"""Agent harness checks (spec §7.5.1, API doc §11). Every agent message is
checked here before the Chair counts it; a failing message is rejected to
debate.round.N.dlq and streamed as harness.rejected."""

import math

MAX_RANKED = 10
REFLECTION_CHECKS = {"constraint", "evidence", "risk", "conflict", "action"}
VERDICTS = {"keep", "revise", "reject"}

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


def _unit(x) -> bool:
    """A real number from 0 to 1 (True, NaN and "0.5" are not)."""
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and 0 <= x <= 1


def _texts(x) -> bool:
    return isinstance(x, list) and bool(x) and all(isinstance(s, str) and s.strip() for s in x)


def check_round0(msg: dict, *, expected_trace_id: str, known_property_ids: set[str]) -> list[str]:
    """Validate a round-0 opinion payload. Returns a list of problems (empty = ok)."""
    problems: list[str] = []
    if msg.get("trace_id") != expected_trace_id:
        problems.append("trace_id does not match the task")
    p = msg.get("payload")
    if not isinstance(p, dict):
        return problems + ["payload must be an object"]
    if not p.get("agent"):
        problems.append("payload.agent is required")
    ranked = p.get("ranked")
    if not isinstance(ranked, list) or not ranked:
        problems.append("payload.ranked must be a non-empty list")
        ranked = []
    if len(ranked) > MAX_RANKED:
        problems.append(f"payload.ranked has more than {MAX_RANKED} items")
    for i, item in enumerate(ranked):
        if not isinstance(item, dict):
            problems.append(f"ranked[{i}] must be an object")
            continue
        pid = item.get("property_id")
        if not isinstance(pid, str) or pid not in known_property_ids:
            problems.append(f"ranked[{i}].property_id {pid!r} is not in the property pool")
        if not _unit(item.get("score")):
            problems.append(f"ranked[{i}].score must be between 0 and 1")
        if not _texts(item.get("reasons")):
            problems.append(f"ranked[{i}].reasons must not be empty")
    if not _unit(p.get("confidence")):
        problems.append("payload.confidence must be between 0 and 1")
    return problems


def check_refs(refs, where: str, known_property_ids) -> list[str]:
    """Evidence must point at something checkable. The pool only has properties, so
    in round 0 every ref is property:<id>."""
    if not _texts(refs):
        return [f"{where}.evidence_refs must not be empty"]
    return [f"{where}.evidence_refs {r!r} is not a known record" for r in refs
            if not (r.startswith("property:") and r.removeprefix("property:") in known_property_ids)]


def check_opinion(msg: dict, *, expected_trace_id: str, expected_task_id: str, known_property_ids) -> list[str]:
    """Everything in check_round0 plus the rest of the API doc §11 contract. The
    agent runs this on its own draft and the Chair runs it on what arrives."""
    problems = check_round0(msg, expected_trace_id=expected_trace_id, known_property_ids=known_property_ids)
    p = msg.get("payload")
    if not isinstance(p, dict):
        return problems
    entity = msg.get("entity") if isinstance(msg.get("entity"), dict) else {}
    if entity.get("entity_id") != expected_task_id:
        problems.append("entity_id does not match the task")
    if msg.get("actor_type") != "agent" or msg.get("actor_id") != f"agent:{p.get('agent')}":
        problems.append("payload.agent does not match actor_id")
    if not isinstance(p.get("agent"), str) or "debate.round.0" not in ALLOWED_PRODUCE_TOPICS.get(p["agent"], ()):
        problems.append("payload.agent may not publish round-0 opinions")
    if p.get("round") != 0 or isinstance(p.get("round"), bool):
        problems.append("payload.round must be 0")
    items = [i for i in p["ranked"] if isinstance(i, dict)] if isinstance(p.get("ranked"), list) else []
    ids = [i.get("property_id") for i in items]
    if any(ids.count(i) > 1 for i in ids):
        problems.append("payload.ranked lists a property twice")
    scores = [i.get("score") for i in items]
    if all(map(_unit, scores)) and scores != sorted(scores, reverse=True):
        problems.append("payload.ranked is not in score order")
    for i, item in enumerate(items):
        problems += check_refs(item.get("evidence_refs"), f"ranked[{i}]", known_property_ids)
    reflection = p.get("reflection")
    if not isinstance(reflection, dict) or not isinstance(reflection.get("checks"), dict):
        problems.append("payload.reflection.checks is required")
    else:
        if missing := REFLECTION_CHECKS - reflection["checks"].keys():
            problems.append(f"payload.reflection.checks is missing {', '.join(sorted(missing))}")
        if reflection.get("verdict") not in VERDICTS:
            problems.append("payload.reflection.verdict must be keep, revise or reject")
    for key in ("risk_flags", "concerns"):
        rows = p.get(key, [])
        if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
            problems.append(f"payload.{key} must be a list of objects")
            continue
        for i, row in enumerate(rows):
            problems += check_refs(row.get("evidence_refs"), f"{key}[{i}]", known_property_ids)
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
