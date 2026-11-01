"""The agents from spec §7.1. Each is a stub with the right subscriptions and
outputs; Slice 5 fills in the logic. Round 0 opinions are independent: no
analysis agent subscribes to debate.round.0."""
import logging

from .base import BaseAgent

log = logging.getLogger("agents")


class ParserAgent(BaseAgent):
    """Guest Request Parser: free text -> structured requirements."""
    name = "parser"
    subscribe = ["ai.requests"]

    async def handle(self, env, topic):
        # TODO: parse env.payload.request_text -> {city, check_in, check_out, guests, price_max, amenities, min_rating}
        log.info("parser got task %s", env["payload"].get("task_id"))


class AnalysisAgent(BaseAgent):
    subscribe = ["ai.requests", "debate.round.1"]

    async def handle(self, env, topic):
        if topic == "ai.requests":
            # TODO: rank the property pool -> publish debate.round.0
            #   payload: ranked[{property_id, score, reasons[], evidence_refs[]}], confidence, reflection{}
            log.info("%s would publish round-0 opinion for %s", self.name, env["trace_id"])
        elif topic == "debate.round.1":
            # TODO: answer challenges addressed to self.name, then vote -> debate.round.2
            log.info("%s would answer challenges for %s", self.name, env["trace_id"])


class MatchingAgent(AnalysisAgent):
    """Property Matching: dates, budget, location, capacity, amenities."""
    name = "matching"


class RiskAgent(AnalysisAgent):
    """Review and Risk: cancellations, cleanliness complaints, odd prices, unresponsive hosts."""
    name = "risk"


class FairnessAgent(AnalysisAgent):
    """Fairness and Bias Auditor: the skeptic; always receives a challenge."""
    name = "fairness"


class ChairAgent(BaseAgent):
    """Booking Assistant Chair: plan, collect round 0, challenge, count votes, decide, publish ai.results."""
    name = "chair"
    subscribe = ["ai.requests", "debate.round.0", "debate.round.2"]

    async def handle(self, env, topic):
        # TODO: per-trace state keyed by trace_id; deadlines (config.ROUND0_DEADLINE_S);
        # disagreement_score() from harness; decision rule from API doc §11
        log.info("chair saw %s for %s", topic, env["trace_id"])


class ExplainerAgent(BaseAgent):
    """Explanation Skill: technical result -> plain language."""
    name = "explainer"
    subscribe: list[str] = []  # TODO: decide whether the Chair calls it via a topic or library


AGENTS = {a.name: a for a in (ParserAgent, MatchingAgent, RiskAgent, FairnessAgent, ChairAgent, ExplainerAgent)}
