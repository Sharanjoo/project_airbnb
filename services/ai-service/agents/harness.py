"""Agent harness checks (spec §7.5.1, API doc §11). Every agent message is
checked here before the Chair counts it; a failing message is rejected to
debate.round.N.dlq and streamed as harness.rejected."""

ALLOWED_PRODUCE_TOPICS = {
    # Agents may only publish debate traffic. booking.*, availability.*, message.*
    # need human approval and are therefore not on this list (API doc §11).
    "parser": {"ai.requests"},
    "matching": {"debate.round.0", "debate.round.2"},
    "risk": {"debate.round.0", "debate.round.2"},
    "fairness": {"debate.round.0", "debate.round.2"},
    "travel_coach": {"debate.round.0", "debate.round.2"},
    "explainer": {"ai.results"},
    "chair": {"debate.round.1", "ai.results"},
}


def check_topic_allowed(agent: str, topic: str) -> None:
    if topic not in ALLOWED_PRODUCE_TOPICS.get(agent, set()):
        raise PermissionError(f"agent {agent!r} may not publish to {topic!r}")


def check_round0(msg: dict, *, expected_trace_id: str, known_property_ids: set[str]) -> list[str]:
    """Validate a round-0 opinion payload. Returns a list of problems (empty = ok)."""
    problems: list[str] = []
    if msg.get("trace_id") != expected_trace_id:
        problems.append("trace_id does not match the task")
    p = msg.get("payload", {})
    if not p.get("agent"):
        problems.append("payload.agent is required")
    ranked = p.get("ranked")
    if not isinstance(ranked, list) or not ranked:
        problems.append("payload.ranked must be a non-empty list")
        ranked = []
    if len(ranked) > 10:
        problems.append("payload.ranked has more than 10 items")
    for i, item in enumerate(ranked):
        pid = item.get("property_id")
        if pid not in known_property_ids:
            problems.append(f"ranked[{i}].property_id {pid!r} is not in the property pool")
        score = item.get("score")
        if not isinstance(score, (int, float)) or not 0 <= score <= 1:
            problems.append(f"ranked[{i}].score must be between 0 and 1")
        if not item.get("reasons"):
            problems.append(f"ranked[{i}].reasons must not be empty")
    conf = p.get("confidence")
    if not isinstance(conf, (int, float)) or not 0 <= conf <= 1:
        problems.append("payload.confidence must be between 0 and 1")
    return problems


def disagreement_score(top3_by_agent: dict[str, list[str]]) -> float:
    """Max over agent pairs of (1 - Jaccard overlap of their top-3). API doc §11."""
    agents = list(top3_by_agent)
    worst = 0.0
    for i in range(len(agents)):
        for j in range(i + 1, len(agents)):
            a, b = set(top3_by_agent[agents[i]]), set(top3_by_agent[agents[j]])
            union = a | b
            jaccard = len(a & b) / len(union) if union else 1.0
            worst = max(worst, 1 - jaccard)
    return round(worst, 3)
