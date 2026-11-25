import itertools

import pytest

from agents.debate import answer_and_vote, build_round1, count_votes, decide, known_refs, make_plan, advance_plan
from agents.harness import check_vote
from agents.scoring import RANKERS
from app.pool import PropertyPool, load_pool

POOL = load_pool()
REQ = {"city": "San Jose", "guests": 2, "price_max": 250, "amenities": ["parking"]}


def opinions(req=REQ, pool=POOL, agents=("matching", "risk", "fairness")):
    return {a: RANKERS[a](req, pool) for a in agents}


def make(pid, **over):
    return {"property_id": pid, "title": pid, "city": "Napa", "property_type": "condo", "capacity": 2, "nightly_price": 100,
            "amenities": ["wifi"], "rating": 4.5, "review_count": 100, **over}


def small(*rows):
    return PropertyPool({"pool_ref": "t", "count": len(rows), "properties": list(rows)})


def r1(*options, voters=("matching", "risk", "fairness")):
    return {"voters": list(voters), "options": [{"property_id": p, "failures": f, "risk_level": lv} for p, f, lv in options]}


@pytest.mark.parametrize("req", [REQ, {}, {"city": "Napa", "guests": 16, "price_max": 1}] + [{"city": c} for c in POOL.cities])
def test_challenges_are_targeted_and_fairness_gets_and_raises_one(req):
    out = build_round1("tsk_1", opinions(req), req, POOL)
    to = [c["to_agent"] for c in out["challenges"]]
    assert "fairness" in to and any("Fairness concern" in c["question"] for c in out["challenges"])
    assert set(to) <= set(out["voters"]) and all(c["question"] and c["evidence_refs"] for c in out["challenges"])
    assert len({c["challenge_id"] for c in out["challenges"]}) == len(to)
    if len(set(out["top_picks"].values())) > 1:
        assert set(to) == set(out["voters"])
    assert len(out["options"]) >= 2


@pytest.mark.parametrize("agents", itertools.combinations(("matching", "risk", "fairness"), 2))
def test_two_agents_are_enough(agents):
    out = build_round1("tsk_1", opinions(agents=agents), REQ, POOL)
    assert out["voters"] == list(agents)
    assert ("fairness" in [c["to_agent"] for c in out["challenges"]]) == ("fairness" in agents)


@pytest.mark.parametrize("req", [REQ, {}, {"city": "Fresno"}])
def test_every_agent_answers_its_challenges_and_casts_a_valid_vote(req):
    ops = opinions(req)
    out = build_round1("tsk_1", ops, req, POOL)
    for a in out["voters"]:
        p = {**answer_and_vote(a, out, req, POOL), "agent": a}
        msg = {"trace_id": "t", "entity": {"entity_id": "tsk_1"}, "actor_type": "agent", "actor_id": f"agent:{a}", "payload": p}
        assert check_vote(msg, expected_trace_id="t", expected_task_id="tsk_1", round1=out) == []
        assert set(p["vote"]["evidence_refs"]) <= known_refs(ops, out)


def test_agent_switches_only_for_a_clear_improvement():
    def option(pid, m, r, level="low"):
        return {"property_id": pid, "scores": {"matching": m, "risk": r}, "failures": [], "risk_level": level, "evidence_refs": []}
    base = {"challenges": [], "top_picks": {"matching": "A"}}
    vote = lambda *o: answer_and_vote("matching", {**base, "options": list(o)}, {}, POOL)["vote"]  # noqa: E731
    assert vote(option("A", .8, .8), option("B", .8, .83))["choice"] == "keep"
    assert vote(option("A", .8, .5), option("B", .75, .9))["property_id"] == "B"
    assert vote(option("A", .8, .8, "high"), option("B", .75, .8))["choice"] == "switch"


def test_votes_without_stored_evidence_or_missing_are_abstentions():
    v = lambda **o: {"choice": "keep", "property_id": "A", "reason": "r", "evidence_refs": ["property:A"], **o}  # noqa: E731
    counts, ballots, out = count_votes({"matching": v(), "risk": v(evidence_refs=["property:Z"])}, {"property:A"}, ["matching", "risk", "fairness"])
    assert counts == {"keep": 1, "switch": 0, "abstain": 2} and ballots == {"matching": "A"} and set(out) == {"risk", "fairness"}
    counts, *_ = count_votes({"matching": v(choice="abstain", property_id=None)}, {"property:A"}, ["matching"])
    assert counts["abstain"] == 1


@pytest.mark.parametrize("ballots,mode,winner", [
    ({"matching": "A", "risk": "A", "fairness": "A"}, "consensus", "A"), ({"matching": "B", "risk": "A", "fairness": "B"}, "majority", "B"),
    ({"matching": "A", "risk": "A"}, "majority", "A"), ({"matching": "A"}, "forced", "A"), ({}, "forced", "A")])
def test_majority_is_of_everyone_entitled_to_vote(ballots, mode, winner):
    pool = small(make("A", nightly_price=50), make("B", nightly_price=90))
    got = decide(ballots, r1(("A", [], "low"), ("B", [], "low")), {}, {"price_max": 100}, pool)
    assert (got["mode"], got["property_id"]) == (mode, winner)


def forced(options, req, pool, ops=None):
    got = decide({}, r1(*options), ops or {}, req, pool)
    assert got["mode"] == "forced" and got["notes"]
    return got["property_id"]


def test_rule1_removes_hard_constraint_failures():
    pool = small(make("A", nightly_price=20), make("B", nightly_price=90))
    assert forced([("A", ["capacity"], "low"), ("B", [], "low")], {}, pool) == "B"


def test_rule2_high_risk_outweighs_a_small_price_difference_only():
    req = {"price_max": 200}
    near = small(make("A", nightly_price=100), make("B", nightly_price=110))
    assert forced([("A", [], "high"), ("B", [], "low")], req, near) == "B"
    far = small(make("A", nightly_price=60), make("B", nightly_price=110))
    assert forced([("A", [], "high"), ("B", [], "low")], req, far) == "A"


def test_rule3_fairness_objection_removes_the_signal():
    pool = small(make("A", nightly_price=40, rating=4.0), make("B", nightly_price=90, rating=4.9))
    opts, req = [("A", [], "low"), ("B", [], "low")], {"price_max": 100}
    assert forced(opts, req, pool) == "A"
    concern = {"fairness": {"concerns": [{"signal": "price_only", "property_ids": ["A"]}]}}
    assert forced(opts, req, pool, concern) == "B"
    elsewhere = {"fairness": {"concerns": [{"signal": "price_only", "property_ids": ["Z"]}]}}
    assert forced(opts, req, pool, elsewhere) == "A"


def test_rule4_matching_score_then_id():
    pool = small(make("A"), make("B"))
    assert forced([("B", [], "low"), ("A", [], "low")], {}, pool) == "A"


def test_plan_progress():
    plan = advance_plan(make_plan("pln_1", "t"), "PLANNING")
    assert [s["status"] for s in plan["steps"]][:2] == ["running", "pending"] and len(plan["steps"]) == 7
    assert [s["status"] for s in advance_plan(plan, "TIMED_OUT", "why")["steps"]][0] == "stopped"
    assert {s["status"] for s in advance_plan(plan, "AWAITING_APPROVAL")["steps"]} == {"done"}
