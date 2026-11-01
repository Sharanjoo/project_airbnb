import pytest

from agents.harness import check_round0, check_topic_allowed, disagreement_score
from app.envelope import create_envelope, validate_envelope

TRACE = "7c1e4b2a-0d3f-4f8e-9a11-2b6c5d8e9f01"


def env(**over):
    e = create_envelope(event_type="debate.round.0", trace_id=TRACE, actor_id="agent:matching",
                        actor_type="agent", entity_type="ai_task", entity_id="tsk_1",
                        payload={"agent": "matching", "confidence": 0.7,
                                 "ranked": [{"property_id": "prp_A", "score": 0.9, "reasons": ["cheap"]}]})
    e.update(over)
    return e


def test_python_and_node_share_the_contract():
    assert validate_envelope(env(), "debate.round.0") == []


def test_missing_field_rejected():
    e = env()
    del e["idempotency_key"]
    assert validate_envelope(e)


def test_topic_mismatch_rejected():
    assert validate_envelope(env(), "ai.results")


def test_harness_accepts_good_round0():
    assert check_round0(env(), expected_trace_id=TRACE, known_property_ids={"prp_A"}) == []


def test_harness_rejects_unknown_property_bad_score_and_wrong_trace():
    bad = env(trace_id="00000000-0000-0000-0000-000000000000")
    bad["payload"]["ranked"] = [{"property_id": "prp_Z", "score": 1.5, "reasons": []}]
    problems = check_round0(bad, expected_trace_id=TRACE, known_property_ids={"prp_A"})
    assert len(problems) == 4


def test_agents_cannot_publish_booking_topics():
    with pytest.raises(PermissionError):
        check_topic_allowed("matching", "booking.requested")
    check_topic_allowed("matching", "debate.round.0")


def test_disagreement_score():
    assert disagreement_score({"m": ["A", "B", "C"], "r": ["A", "B", "C"]}) == 0
    assert disagreement_score({"m": ["A", "B", "C"], "r": ["D", "E", "F"]}) == 1
    assert disagreement_score({"m": ["A", "B", "C"], "r": ["A", "B", "D"]}) == 0.5
