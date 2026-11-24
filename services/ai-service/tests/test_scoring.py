import copy

import pytest

from agents.harness import disagreement_score
from agents.scoring import RANKERS, Peers, banded, concerns, failures, risk_level, risk_signals
from app.pool import PropertyPool, load_pool

POOL = load_pool()
REQ = {"city": "San Jose", "guests": 2, "price_max": 250, "amenities": ["parking"], "min_rating": None}
IMPOSSIBLE = {"city": "San Jose", "guests": 16, "price_max": 1, "amenities": ["pool"], "min_rating": 5}


def make(pid, **over):
    return {"property_id": pid, "title": "t", "city": "Napa", "property_type": "condo", "capacity": 2, "nightly_price": 100,
            "amenities": ["wifi"], "rating": 4.5, "review_count": 100, **over}


def small(*rows):
    return PropertyPool({"pool_ref": "t", "count": len(rows), "properties": list(rows)})


@pytest.mark.parametrize("agent", RANKERS)
@pytest.mark.parametrize("req", [REQ, {}, IMPOSSIBLE, {"city": "Fresno"}])
def test_rankings_are_deterministic_bounded_and_do_not_change_the_pool(agent, req):
    before = copy.deepcopy(POOL.properties)
    out = RANKERS[agent](req, POOL)
    assert out == RANKERS[agent](req, POOL) and POOL.properties == before
    assert len(out["ranked"]) == 10 and 0 <= out["confidence"] <= 1
    scores = [r["score"] for r in out["ranked"]]
    assert scores == sorted(scores, reverse=True) and all(0 <= s <= 1 for s in scores)


@pytest.mark.parametrize("agent", RANKERS)
def test_matches_always_outrank_near_misses(agent):
    out = RANKERS[agent](REQ, POOL)
    misses = [bool(failures(POOL.by_id[r["property_id"]], REQ)) for r in out["ranked"]]
    assert out["eligible_count"] >= 1 and misses == sorted(misses)


def test_bands_never_overlap():
    assert banded(0, 0) >= banded(1, 1) and banded(0, 1) >= banded(1, 2) and banded(9, 0) == 1


def test_failures_name_each_unmet_requirement():
    p = make("a", rating=None)
    assert failures(p, {"city": "Fresno", "guests": 3, "price_max": 50, "amenities": ["pool", "wifi"], "min_rating": 4}) == \
        ["city", "capacity", "budget", "amenity:pool", "min_rating"]
    assert failures(p, {"price_max": 100, "guests": 2, "city": "Napa"}) == []


@pytest.mark.parametrize("agent", RANKERS)
def test_impossible_request_is_reported_not_hidden(agent):
    out = RANKERS[agent](IMPOSSIBLE, POOL)
    assert out["eligible_count"] == 0 and out["confidence"] <= 0.25
    assert out["ranked"][0]["reasons"][0].startswith("Does not meet")


def test_matching_prefers_cheaper_when_equal():
    out = RANKERS["matching"]({"price_max": 200}, small(make("a", nightly_price=150), make("b", nightly_price=90)))
    assert out["ranked"][0]["property_id"] == "b"


@pytest.mark.parametrize("over,ratio,level", [
    ({}, 1, "low"), ({"rating": 3.5}, 1, "high"), ({"rating": 3.9}, 1, "medium"), ({"rating": None, "review_count": 0}, 1, "medium"),
    ({"rating": None, "review_count": 0}, 0.4, "high"), ({}, 0.4, "medium"), ({}, 2.5, "medium"), ({"review_count": 3}, 1, "low")])
def test_risk_levels(over, ratio, level):
    assert risk_level(risk_signals(make("a", **over), ratio)) == level


def test_risk_ranks_the_risky_one_last_and_flags_it():
    out = RANKERS["risk"]({}, small(make("a", rating=3.5), make("b"), make("c", rating=3.9)))
    assert [r["property_id"] for r in out["ranked"]] == ["b", "c", "a"]
    assert [f["property_id"] for f in out["risk_flags"]] == ["a"]


def test_fairness_treats_similar_listings_alike_whatever_their_popularity():
    out = RANKERS["fairness"]({}, small(make("a", review_count=240), make("b", review_count=120), make("c", rating=3.5)))
    score = {r["property_id"]: r["score"] for r in out["ranked"]}
    assert score["a"] == score["b"] > score["c"]


def test_fairness_does_not_bury_new_listings():
    new, poor = make("new", rating=None, review_count=0), make("poor", rating=3.6)
    assert RANKERS["fairness"]({}, small(new, poor))["ranked"][0]["property_id"] == "new"


@pytest.mark.parametrize("req", [REQ, {}, IMPOSSIBLE] + [{"city": c} for c in POOL.cities])
def test_fairness_always_has_a_concern_with_evidence(req):
    found = RANKERS["fairness"](req, POOL)["concerns"]
    assert 1 <= len(found) <= 3 and all(c["evidence_refs"] and c["detail"] for c in found)


def test_concern_types():
    pool = small(make("n", rating=None, review_count=0), make("a", review_count=200), make("b", review_count=10))
    assert {"new_listing", "popularity"} <= {c["signal"] for c in concerns(pool.properties, Peers(pool))}
    lone = small(make("a"))
    assert concerns(lone.properties, Peers(lone))[0]["signal"] == "price_weight"


def test_agents_have_distinct_views():
    differ = 0
    for city in POOL.cities:
        top = {a: [r["property_id"] for r in RANKERS[a]({"city": city}, POOL)["ranked"][:3]] for a in RANKERS}
        differ += disagreement_score(top) > 0
    assert differ >= 8
