"""The agents from spec §7.1. Round 0 opinions are independent: no analysis agent
subscribes to debate.round.0. The Chair is in chair.py; the Explainer is a plain
function the Chair calls (debate.explain), so it needs no process of its own."""
import logging
import re
import time

from app.llm import get_provider
from app.pool import load_pool

from .base import BaseAgent, PermanentError
from .chair import ChairAgent
from .debate import answer_and_vote
from .harness import check_opinion
from .parsing import ParseError, parse_request
from .scoring import RANKERS, checks

log = logging.getLogger("agents")


class ParserAgent(BaseAgent):
    """Guest Request Parser: free text -> structured requirements.

    ai.requests carries both the raw request (from the API) and the parsed one
    (from here). A message with structured_requirements is already parsed, so the
    parser ignores it and does not loop."""
    name = "parser"
    group = "parser-cg"
    subscribe = ["ai.requests"]

    def __init__(self, store=None, producer=None, *, pool=None, provider=None):
        super().__init__(store, producer)
        self.pool = pool or load_pool()
        self.provider = provider or get_provider()

    async def handle(self, env, topic):
        payload = env["payload"]
        if "structured_requirements" in payload:
            return
        task = await self.open_task(env)
        if not task:
            return
        parsed = task.get("parsed_request")
        if not parsed:  # a redelivery reuses the stored answer, so both copies agree
            started = time.perf_counter()
            try:
                parsed = await parse_request(payload, self.pool, provider=self.provider)
            except ParseError as exc:
                log.info("parser rejected task %s: %s", task["task_id"], exc.message)
                await self.store.transition(task["task_id"], "FAILED", {"errors": [
                    {"code": "VALIDATION_ERROR", "field": exc.field, "message": exc.message}]})
                return
            parsed["latency_ms"] = round((time.perf_counter() - started) * 1000, 2)
            await self.store.update(task["task_id"], {"parsed_request": parsed})
        await self.publish("ai.requests", trace_id=env["trace_id"], task_id=task["task_id"],
                           idem=f"{task['task_id']}:parsed", payload={
                               "task_id": task["task_id"], "plan_id": task["plan_id"],
                               "config_version": task["config_version"],
                               "request_text": payload.get("request_text"),
                               "property_pool_ref": payload.get("property_pool_ref", self.pool.ref),
                               "check_in": parsed["requirements"]["check_in"],
                               "check_out": parsed["requirements"]["check_out"],
                               "structured_requirements": parsed["requirements"],
                               "parser": {k: parsed[k] for k in ("provider", "llm_fields", "fallback", "warnings")}})


class AnalysisAgent(BaseAgent):
    """Round 0: rank the pool alone. Subscribes to ai.requests and debate.round.1 only,
    so it can never read another agent's first opinion."""
    subscribe = ["ai.requests", "debate.round.1"]

    def __init__(self, store=None, producer=None, *, pool=None):
        super().__init__(store, producer)
        self.pool = pool or load_pool()

    def opinion(self, requirements: dict) -> dict:
        """The round-0 payload, without the reflection."""
        return {"round": 0, **RANKERS[self.name](requirements, self.pool)}

    def reflect(self, env: dict, draft: dict) -> dict:
        """One self-check and at most one revision (API doc §11): drop the ranked
        items the harness would refuse, and refuse to publish if that is not enough."""
        def problems(payload):
            msg = {"trace_id": env["trace_id"], "entity": env["entity"], "actor_type": "agent",
                   "actor_id": f"agent:{self.name}", "payload": {**payload, "agent": self.name}}
            return check_opinion(msg, expected_trace_id=env["trace_id"], expected_task_id=env["entity"]["entity_id"],
                                 known_property_ids=self.pool.ids)

        def with_reflection(payload, verdict):
            return {**payload, "reflection": {"checks": checks(self.name, payload), "verdict": verdict}}

        bad_rows = {int(m[1]) for p in problems({**draft, "reflection": None}) if (m := re.match(r"ranked\[(\d+)\]", p))}
        kept = [item for i, item in enumerate(draft["ranked"]) if i not in bad_rows]
        if not kept:
            raise PermanentError(f"{self.name} has no valid ranked property")
        final = with_reflection({**draft, "ranked": kept}, "revise" if bad_rows else "keep")
        if left := problems(final):
            raise PermanentError(f"{self.name} opinion failed its own check: {'; '.join(left)}")
        return final

    async def handle(self, env, topic):
        if topic == "ai.requests":
            requirements = env["payload"].get("structured_requirements")
            if requirements is None:  # the raw request; wait for the parser's version
                return
            # Anyone can publish ai.requests, so only the parser's message counts as parsed.
            if env["actor_id"] != "agent:parser" or not isinstance(requirements, dict):
                raise PermanentError("structured_requirements must come from agent:parser")
            task = await self.open_task(env)
            if not task:
                return
            started = time.perf_counter()
            payload = self.reflect(env, self.opinion(requirements))
            payload["latency_ms"] = round((time.perf_counter() - started) * 1000, 2)
            await self.publish("debate.round.0", trace_id=env["trace_id"], task_id=task["task_id"], payload=payload,
                               idem=f"{task['task_id']}:{self.name}:round0")
        elif topic == "debate.round.1":
            await self.on_round1(env)

    async def on_round1(self, env):
        """Answer challenges and vote, or redo a message the harness rejected."""
        if env["actor_id"] != "agent:chair":
            raise PermanentError("debate.round.1 must come from agent:chair")
        task = await self.open_task(env)
        if not task:
            return
        retry = env["payload"].get("retry")
        if retry:
            if retry.get("agent") != self.name:
                return
            log.info("%s retrying round %s for %s: %s", self.name, retry.get("round"), env["trace_id"], retry.get("reason"))
        if retry and retry.get("round") == 0:
            payload = self.reflect(env, self.opinion(task["parsed_request"]["requirements"]))
            await self.publish("debate.round.0", trace_id=env["trace_id"], task_id=task["task_id"], payload=payload,
                               idem=f"{task['task_id']}:{self.name}:round0:retry")
            return
        # A retry carries no challenges; the original round-1 message is on the task.
        round1 = task["round1"] if retry else env["payload"]
        if self.name not in round1["voters"]:
            return
        started = time.perf_counter()
        payload = answer_and_vote(self.name, round1, task["parsed_request"]["requirements"], self.pool)
        payload["latency_ms"] = round((time.perf_counter() - started) * 1000, 2)
        await self.publish("debate.round.2", trace_id=env["trace_id"], task_id=task["task_id"], payload=payload,
                           idem=f"{task['task_id']}:{self.name}:round2{':retry' if retry else ''}")


class MatchingAgent(AnalysisAgent):
    """Property Matching: location, budget, capacity, amenities. Dates: the pool has no
    calendar, so availability is checked later by the Chair (plan step 6)."""
    name = "matching"


class RiskAgent(AnalysisAgent):
    """Review and Risk: low ratings, few reviews, odd prices. Cancellations, complaints
    and host response are not in the pool, so they are not scored."""
    name = "risk"


class FairnessAgent(AnalysisAgent):
    """Fairness and Bias Auditor: the skeptic. Always raises at least one concern, which
    the Chair turns into a challenge, and always receives one."""
    name = "fairness"


AGENTS = {a.name: a for a in (ParserAgent, MatchingAgent, RiskAgent, FairnessAgent, ChairAgent)}
