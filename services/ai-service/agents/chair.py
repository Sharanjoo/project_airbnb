"""Booking Assistant Chair: plan, collect round 0, challenge, count votes, decide.

The Chair keeps nothing important in memory. Every step is rebuilt from MongoDB
(task + debate_messages), so a restart continues where it stopped, a duplicate
event changes nothing, and debates cannot mix: all state is read by task/trace id.
A sweep loop enforces the deadlines, so no task waits for a message that never comes."""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from weakref import WeakValueDictionary

from app import config
from app.availability import is_available
from app.envelope import utc_now_iso
from app.pool import load_pool
from app.store import ANALYSIS_AGENTS, OPEN_STATUSES

from .base import BaseAgent, PermanentError
from .debate import (MIN_AGENTS, advance_plan, build_result, build_round1, combined_ranking, count_votes, decide, known_refs,
                     make_plan, scores_by_property, skip_step, top3)
from .harness import check_opinion, check_vote

log = logging.getLogger("agents")

# result["availability"] when plan step 6 did not really check the chosen home
SKIPPED = {"no_dates": "No dates given, so availability was not checked.",
           "unverified": "Availability could not be verified; the booking request will check it."}


class HarnessRejected(PermanentError):
    """The message failed the harness: BaseAgent sends it to debate.round.N.dlq."""


def _in(seconds: float) -> str:
    t = datetime.now(timezone.utc) + timedelta(seconds=seconds)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _ago(seconds: float) -> str:
    return _in(-seconds)


class ChairAgent(BaseAgent):
    name = "chair"
    group = "chair-cg"
    subscribe = ["ai.requests", "debate.round.0", "debate.round.2"]

    def __init__(self, store=None, producer=None, *, pool=None, availability=is_available):
        super().__init__(store, producer)
        self.pool = pool or load_pool()
        self.availability = availability
        self.locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()

    def lock(self, trace_id: str) -> asyncio.Lock:
        lock = self.locks.get(trace_id)
        if lock is None:
            lock = self.locks[trace_id] = asyncio.Lock()
        return lock

    # ------------------------------------------------------------ messages
    async def handle(self, env, topic):
        lock = self.lock(env["trace_id"])
        async with lock:
            task = await self.open_task(env)
            if not task:
                return
            rejected = None
            if topic == "ai.requests":
                await self.on_request(task, env)
            else:
                rejected = await self.on_round(task, env, 0 if topic == "debate.round.0" else 2)
            await self.advance(task["task_id"])
        if rejected:
            raise HarnessRejected("; ".join(rejected))

    async def on_request(self, task, env):
        if task["status"] == "QUEUED":
            plan = make_plan(task["plan_id"], task["trace_id"])
            plan = advance_plan(plan, "PLANNING")
            if await self.store.transition(task["task_id"], "PLANNING", {"plan": plan, "started_at": utc_now_iso()}):
                await self.store.add_frame(task["task_id"], "plan", {"type": "plan.created", "plan_id": task["plan_id"], "steps": plan["steps"]})

    async def on_round(self, task, env, rnd) -> list[str]:
        """Store one opinion or vote. Returns the harness problems, if any."""
        payload = env["payload"]
        agent = payload.get("agent")
        if rnd == 0:
            problems = check_opinion(env, expected_trace_id=task["trace_id"], expected_task_id=task["task_id"], known_property_ids=self.pool.ids)
        elif task["round1"]:
            problems = check_vote(env, expected_trace_id=task["trace_id"], expected_task_id=task["task_id"], round1=task["round1"])
        else:
            problems = ["vote arrived before round 1"]
        new = await self.store.add_message(trace_id=task["trace_id"], task_id=task["task_id"], round_no=rnd, agent=str(agent),
                                           payload=payload, event_id=env["event_id"], rejected=problems)
        if not problems:
            await self.announce(task, agent, rnd, payload)
            return []
        # Only the round that is open can be retried, once per agent. The sender is the
        # envelope's actor, so a message cannot use up another agent's retry.
        sender = env["actor_id"].removeprefix("agent:")
        await self.store.add_frame(task["task_id"], f"rejected:{env['event_id']}", {
            "type": "harness.rejected", "agent": sender, "round": rnd, "reason": "; ".join(problems)})
        key = f"{rnd}:{sender}"
        expected = {"0": ANALYSIS_AGENTS, "2": task["round1"]["voters"] if task["round1"] else ()}[str(rnd)]
        is_open = task["status"] in (("PLANNING", "ROUND_0") if rnd == 0 else ("ROUND_2",))
        if new and is_open and sender in expected and sender not in await self.accepted(task, rnd):
            count = task["retries"].get(key, 0) + 1
            await self.store.update(task["task_id"], {"retries": {**task["retries"], key: count}})
            if count == 1:
                await self.publish("debate.round.1", trace_id=task["trace_id"], task_id=task["task_id"],
                                   idem=f"{task['task_id']}:retry:{key}", payload={
                                       "round": 1, "challenges": [], "disagreement_score": None,
                                       "retry": {"agent": sender, "round": rnd, "reason": "; ".join(problems)[:500]}})
        return problems

    async def announce(self, task, agent, rnd, payload):
        tid = task["task_id"]
        # Frames and agent status only change while the round still counts.
        if (rnd == 0 and task["status"] not in ("QUEUED", "PLANNING", "ROUND_0")) or agent in await self._announced(tid, rnd):
            return
        if rnd == 0:
            agents = [{**a, "status": "published", "published_at": utc_now_iso()} if a["name"] == agent else a for a in task["agents"]]
            await self.store.update(tid, {"agents": agents})
            await self.store.add_frame(tid, f"published:0:{agent}", {"type": "agent.published", "agent": agent, "round": 0,
                                                                    "top3": top3(payload), "confidence": payload["confidence"]})
        else:
            await self.store.add_frame(tid, f"published:2:{agent}", {"type": "agent.published", "agent": agent, "round": 2,
                                                                    "responses": payload["responses"]})
            vote = payload["vote"]
            await self.store.add_frame(tid, f"vote:{agent}", {"type": "vote.cast", "agent": agent, "vote": vote["choice"],
                                                              "property_id": vote.get("property_id"), "reason": vote["reason"]})

    async def _announced(self, task_id, rnd) -> set[str]:
        task = await self.store.get(task_id)
        return {f["agent"] for f in task["frames"] if f["key"].startswith("vote:" if rnd == 2 else "published:0:")}

    async def accepted(self, task, rnd) -> dict[str, dict]:
        """agent -> first valid payload of this round."""
        out: dict[str, dict] = {}
        for m in await self.store.list_messages(task["trace_id"]):
            if m["round"] == rnd and not m["rejected"] and m["task_id"] == task["task_id"]:
                out.setdefault(m["agent"], m["payload"])
        return out

    # ------------------------------------------------------------ workflow
    async def advance(self, task_id: str):
        """Move the task as far as it can go right now. Safe to call at any time."""
        steps = {"QUEUED": self.at_start, "PLANNING": self.at_start, "ROUND_0": self.at_round0, "ROUND_1": self.at_round1,
                 "ROUND_2": self.at_round2, "DECIDING": self.at_deciding}
        while True:
            task = await self.store.get(task_id)
            if not task or task["status"] not in OPEN_STATUSES:
                return
            if task["created_at"] < _ago(config.TASK_DEADLINE_S):
                await self.close(task, "TIMED_OUT", "TASK_DEADLINE", "The debate did not finish in time.")
                return
            if not await steps[task["status"]](task):
                return

    async def move(self, task, status, **fields) -> bool:
        plan = advance_plan(task["plan"], status) if task["plan"]["steps"] else task["plan"]
        return bool(await self.store.transition(task["task_id"], status, {"plan": plan, **fields}))

    async def close(self, task, status, code, message):
        errors = [*task["errors"], {"code": code, "message": message}]
        plan = advance_plan(task["plan"], status, message)
        await self.store.transition(task["task_id"], status, {"errors": errors, "plan": plan})
        log.warning("task %s ended %s: %s", task["task_id"], status, message)

    async def at_start(self, task) -> bool:
        if not task["parsed_request"]:
            if task["created_at"] < _ago(config.PARSE_DEADLINE_S):
                await self.timeout(task, "parser", None, config.PARSE_DEADLINE_S)
                await self.close(task, "TIMED_OUT", "PARSER_TIMEOUT", "The request parser did not answer in time.")
            return False
        if task["status"] == "QUEUED":  # the raw request was missed (restart); plan now
            await self.on_request(task, {})
            return True
        parsed = task["parsed_request"]
        await self.store.add_frame(task["task_id"], "parsed", {
            "type": "parser.completed", "requirements": parsed["requirements"], "provider": parsed["provider"], "warnings": parsed["warnings"],
            "fallback": parsed.get("fallback"), "llm_fields": parsed.get("llm_fields") or []})
        return await self.move(task, "ROUND_0", round=0, timings={**task["timings"], "round0_started": utc_now_iso()},
                               deadlines={**task["deadlines"], "round0": _in(config.ROUND0_DEADLINE_S)})

    def finished(self, task, rnd, expected, got) -> tuple[bool, list[str]]:
        """(is the round over, agents that are out). An agent is out when the deadline
        passed or its one retry was also rejected."""
        missing = [a for a in expected if a not in got]
        out = [a for a in missing if task["retries"].get(f"{rnd}:{a}", 0) >= 2]
        if utc_now_iso() >= task["deadlines"][f"round{rnd}"]:
            return True, missing
        return len(out) == len(missing), out

    async def timeout(self, task, agent, rnd, deadline_s):
        await self.store.add_frame(task["task_id"], f"timeout:{rnd}:{agent}", {
            "type": "agent.timeout", "agent": agent, "round": rnd, "deadline_ms": round(deadline_s * 1000)})

    async def at_round0(self, task) -> bool:
        opinions = await self.accepted(task, 0)
        over, out = self.finished(task, 0, ANALYSIS_AGENTS, opinions)
        if not over:
            return False
        for a in out:
            await self.timeout(task, a, 0, config.ROUND0_DEADLINE_S)
        errors = task["errors"] + [{"code": "AGENT_TIMEOUT", "agent": a, "round": 0,
                                    "message": f"{a} gave no valid round-0 opinion in time."} for a in out]
        agents = [{**a, "status": "timed_out"} if a["name"] in out else a for a in task["agents"]]
        task = {**task, "errors": errors, "agents": agents}
        if len(opinions) < MIN_AGENTS:
            await self.store.update(task["task_id"], {"agents": agents})
            await self.close(task, "TIMED_OUT", "NOT_ENOUGH_AGENTS", f"Only {len(opinions)} of 3 agents answered; at least {MIN_AGENTS} are needed.")
            return False
        # Freeze the opinions that count, so a late one cannot change the debate.
        opinions = {a: opinions[a] for a in ANALYSIS_AGENTS if a in opinions}
        round1 = build_round1(task["task_id"], opinions, task["parsed_request"]["requirements"], self.pool)
        return await self.move(task, "ROUND_1", round=1, round1=round1, errors=errors, agents=agents,
                               timings={**task["timings"], "round0_closed": utc_now_iso()})

    async def at_round1(self, task) -> bool:
        r1 = task["round1"]
        tid = task["task_id"]
        await self.store.add_message(trace_id=task["trace_id"], task_id=tid, round_no=1, agent="chair", payload=r1, event_id=f"{tid}:round1")
        for c in r1["challenges"]:
            await self.store.add_frame(tid, f"challenge:{c['challenge_id']}", {
                "type": "challenge.issued", "challenge_id": c["challenge_id"], "to_agent": c["to_agent"],
                "question": c["question"], "disagreement_score": r1["disagreement_score"]})
        # Move first: a vote that comes back at once must find the round open. If the
        # publish then fails, at_round2 sends it again.
        return await self.move(task, "ROUND_2", round=2, deadlines={**task["deadlines"], "round2": _in(config.ROUND2_DEADLINE_S)})

    async def at_round2(self, task) -> bool:
        if not task["timings"].get("round1_sent"):
            await self.publish("debate.round.1", trace_id=task["trace_id"], task_id=task["task_id"], payload=task["round1"],
                               idem=f"{task['task_id']}:round1")
            # The voters' time starts when they can see the challenges.
            task = await self.store.update(task["task_id"], {
                "timings": {**task["timings"], "round1_sent": utc_now_iso()},
                "deadlines": {**task["deadlines"], "round2": _in(config.ROUND2_DEADLINE_S)}})
        votes = await self.accepted(task, 2)
        over, out = self.finished(task, 2, task["round1"]["voters"], votes)
        if not over:
            return False
        for a in out:
            await self.timeout(task, a, 2, config.ROUND2_DEADLINE_S)
        errors = task["errors"] + [{"code": "AGENT_TIMEOUT", "agent": a, "round": 2, "message": f"{a} cast no valid vote in time."} for a in out]
        # Freeze the votes that count, like round 0.
        return await self.move(task, "DECIDING", errors=errors, timings={**task["timings"], "round2_closed": utc_now_iso()},
                               counted_votes={a: v["vote"] for a, v in votes.items() if a in task["round1"]["voters"]})

    async def at_deciding(self, task) -> bool:
        result = task["result"]
        if not result:
            result = await self.make_result(task)
            if result is None:
                await self.close(task, "FAILED", "NO_AVAILABLE_PROPERTY", "None of the best matches is free for these dates.")
                return False
            await self.store.update(task["task_id"], {"result": result})
        # Same idempotency key if this runs again after a crash, so consumers apply it once.
        await self.publish("ai.results", trace_id=task["trace_id"], task_id=task["task_id"], payload=result, idem=f"{task['task_id']}:result")
        await self.store.add_frame(task["task_id"], "verdict", {"type": "verdict", **result})
        if result.get("availability") in SKIPPED:
            task = {**task, "plan": skip_step(task["plan"], 6, SKIPPED[result["availability"]])}
        await self.move(task, "AWAITING_APPROVAL")
        return False

    async def make_result(self, task) -> dict | None:
        r1, req = task["round1"], task["parsed_request"]["requirements"]
        stored = await self.accepted(task, 0)
        opinions = {a: stored[a] for a in r1["voters"]}
        votes = task["counted_votes"]
        counts, ballots, abstained = count_votes(votes, known_refs(opinions, r1), r1["voters"])
        decision = decide(ballots, r1, opinions, req, self.pool)
        limitations = [e["message"] for e in task["errors"] if e["code"] == "AGENT_TIMEOUT"]
        limitations += [f"{a}'s vote counted as an abstention: {why}." for a, why in abstained.items() if a in votes]
        limitations += task["parsed_request"]["warnings"]
        if not any(not o["failures"] for o in r1["options"]):
            limitations.append("No property meets every stated requirement; this is the closest match.")
        chosen, unavailable, availability = await self.pick_available(task, decision["property_id"], opinions, limitations)
        if chosen is None:
            return None
        return build_result(task, opinions, votes, decision, counts, ballots, limitations, chosen, unavailable, availability, self.pool, utc_now_iso())

    async def pick_available(self, task, winner, opinions, limitations) -> tuple[str | None, list[str], str]:
        """Plan step 6. The first of the winner and the next best four that is not
        known to be taken."""
        req = task["parsed_request"]["requirements"]
        if not (req["check_in"] and req["check_out"]):
            limitations.append(SKIPPED["no_dates"])
            return winner, [], "no_dates"
        order = [winner] + [p for p in combined_ranking(scores_by_property(opinions)) if p != winner]
        taken: list[str] = []
        for pid in order[:5]:
            free = await self.availability(pid, req["check_in"], req["check_out"], task["user_id"], task["trace_id"])
            if free is not False:
                if free is None:
                    limitations.append(SKIPPED["unverified"])
                if taken:
                    limitations.append(f"{winner} won the vote but is not free for these dates.")
                return pid, taken, "unverified" if free is None else "verified"
            taken.append(pid)
        return None, taken, "unavailable"

    # ----------------------------------------------------------- deadlines
    async def sweep(self):
        for task in await self.store.list_open():
            lock = self.lock(task["trace_id"])
            async with lock:
                try:
                    await self.advance(task["task_id"])
                except Exception:  # noqa: BLE001  one bad task must not stop the others
                    log.exception("sweep failed for task %s", task["task_id"])

    async def background(self):
        while True:
            try:
                await self.sweep()
            except Exception:  # noqa: BLE001
                log.exception("sweep failed")
            await asyncio.sleep(config.SWEEP_INTERVAL_S)
