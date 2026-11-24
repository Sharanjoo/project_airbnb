"""Round-0 rankings. Pure and deterministic: same requirements + same pool = same answer.

Every agent scores the whole pool on its own and only sees pool fields (city, type,
capacity, price, amenities, rating, review_count). The pool has no calendar, host,
cancellation, complaint or review-text data, so no score pretends to use them;
each opinion says so in reflection.checks."""
import math
from collections import defaultdict
from statistics import median

from app.pool import PropertyPool

TOP_N = 10
PRIOR_RATING, PRIOR_WEIGHT = 4.3, 20  # a new listing counts as average, not as bad
NOT_IN_POOL = "not in pool data: calendar, host, cancellations, complaints, review text"


def ref(p: dict) -> str:
    return f"property:{p['property_id']}"


def failures(p: dict, req: dict) -> list[str]:
    """Stated requirements this property does not meet."""
    out = []
    if req.get("city") and p["city"] != req["city"]:
        out.append("city")
    if req.get("guests") and p["capacity"] < req["guests"]:
        out.append("capacity")
    if req.get("price_max") is not None and p["nightly_price"] > req["price_max"]:
        out.append("budget")
    out += [f"amenity:{a}" for a in req.get("amenities") or [] if a not in p["amenities"]]
    if req.get("min_rating") and (p["rating"] is None or p["rating"] < req["min_rating"]):
        out.append("min_rating")
    return out


def banded(base: float, n_failed: int) -> float:
    """0 failures -> 0.5..1, one -> 0.25..0.5, two -> 0.125..0.25. A near miss can
    never outrank a property that meets everything."""
    return round(0.5 ** (n_failed + 1) * (1 + min(1.0, max(0.0, base))), 4)


def fair_rating(p: dict) -> float:
    """Rating pulled toward the average when there are few reviews, scaled to 0..1 over 3..5."""
    n = p["review_count"] if p["rating"] is not None else 0
    value = (n * (p["rating"] or 0) + PRIOR_WEIGHT * PRIOR_RATING) / (n + PRIOR_WEIGHT)
    return min(1.0, max(0.0, (value - 3) / 2))


class Peers:
    """Median price of similar listings: same city and type, or same type if fewer than 4."""

    def __init__(self, pool: PropertyPool):
        self.local, self.by_type = defaultdict(list), defaultdict(list)
        for p in pool.properties:
            self.local[p["city"], p["property_type"]].append(p["nightly_price"])
            self.by_type[p["property_type"]].append(p["nightly_price"])

    def price_ratio(self, p: dict) -> float:
        prices = self.local[p["city"], p["property_type"]]
        if len(prices) < 4:
            prices = self.by_type[p["property_type"]]
        return p["nightly_price"] / median(prices)


def _unmet(failed: list[str]) -> list[str]:
    return [f"Does not meet: {', '.join(failed)}"] if failed else ["Meets every stated requirement"]


def _rank(scored: list[dict]) -> list[dict]:
    return sorted(scored, key=lambda s: (-s["score"], s["property_id"]))


def _item(p: dict, score: float, reasons: list[str], **extra) -> dict:
    return {"property_id": p["property_id"], "score": score, "reasons": reasons, "evidence_refs": [ref(p)], **extra}


def _confidence(ranked: list[dict], eligible: int, unknown: int = 0) -> float:
    """Higher with more matching homes and a clearer winner; lower when data is missing."""
    margin = ranked[0]["score"] - ranked[1]["score"] if len(ranked) > 1 else 0
    base = 0.45 + 0.03 * min(eligible, 10) + min(0.15, margin) if eligible else 0.25
    return round(max(0.1, min(0.95, base - 0.02 * unknown)), 2)


# ---------------------------------------------------------------- matching
MATCH_WEIGHTS = {"price": 0.40, "capacity": 0.25, "rating": 0.25, "extras": 0.10}


def matching(req: dict, pool: PropertyPool) -> dict:
    top_price = max(p["nightly_price"] for p in pool.properties)
    scored, eligible = [], 0
    for p in pool.properties:
        failed = failures(p, req)
        eligible += not failed
        limit = req.get("price_max") or top_price
        parts = {
            "price": max(0.0, 1 - p["nightly_price"] / limit),
            "capacity": max(0.0, 1 - 0.2 * max(0, p["capacity"] - req["guests"])) if req.get("guests") else min(1.0, p["capacity"] / 4),
            "rating": (p["rating"] - 3) / 2 if p["rating"] is not None else 0.5,
            "extras": len(p["amenities"]) / 10,
        }
        base = sum(MATCH_WEIGHTS[k] * max(0.0, v) for k, v in parts.items())
        price = f"${p['nightly_price']:g}/night"
        if req.get("price_max") is not None:
            gap = req["price_max"] - p["nightly_price"]
            price += f", ${abs(gap):g} {'under' if gap >= 0 else 'over'} budget"
        rating = f"{p['rating']:g} rating over {p['review_count']} reviews" if p["rating"] is not None else "No rating yet"
        scored.append(_item(p, banded(base, len(failed)), _unmet(failed) + [price, f"Sleeps {p['capacity']} in {p['city']}", rating]))
    ranked = _rank(scored)[:TOP_N]
    return {"ranked": ranked, "confidence": _confidence(ranked, eligible), "eligible_count": eligible}


# -------------------------------------------------------------------- risk
def risk_signals(p: dict, ratio: float) -> list[tuple[float, str]]:
    """(weight, reason). Total >= 0.5 is high, >= 0.25 medium."""
    out = []
    if p["rating"] is None or p["review_count"] == 0:
        out.append((0.25, "No reviews yet, so quality is unverified"))
    else:
        if p["rating"] < 3.7:
            out.append((0.5, f"Low rating: {p['rating']:g}"))
        elif p["rating"] < 4.0:
            out.append((0.25, f"Below-average rating: {p['rating']:g}"))
        if p["review_count"] < 10:
            out.append((0.2, f"Only {p['review_count']} reviews"))
    if ratio < 0.5:
        out.append((0.3, f"Price is {ratio:.0%} of similar listings, unusually low"))
    elif ratio > 2:
        out.append((0.25, f"Price is {ratio:.0%} of similar listings, unusually high"))
    return out


def risk_level(signals: list[tuple[float, str]]) -> str:
    total = round(sum(w for w, _ in signals), 4)
    return "high" if total >= 0.5 else "medium" if total >= 0.25 else "low"


def risk(req: dict, pool: PropertyPool) -> dict:
    peers = Peers(pool)
    scored, flags, eligible, unknown = [], [], 0, 0
    for p in pool.properties:
        failed = failures(p, req)
        signals = risk_signals(p, peers.price_ratio(p))
        level = risk_level(signals)
        # 80% absence of risk signals, 20% how much review evidence backs that up.
        base = 0.8 * max(0.0, 1 - sum(w for w, _ in signals)) + 0.2 * min(1.0, math.log1p(p["review_count"]) / math.log1p(250)) * fair_rating(p)
        reasons = [r for _, r in signals] or [f"No risk signals; {p['rating']:g} over {p['review_count']} reviews"]
        scored.append(_item(p, banded(base, len(failed)), _unmet(failed) + reasons, risk_level=level))
        if not failed:
            eligible += 1
            unknown += p["rating"] is None
            if level == "high":
                flags.append({"property_id": p["property_id"], "level": level, "reasons": reasons, "evidence_refs": [ref(p)]})
    ranked = _rank(scored)[:TOP_N]
    return {"ranked": ranked, "confidence": _confidence(ranked, eligible, unknown), "eligible_count": eligible,
            "risk_flags": flags[:20]}


# ---------------------------------------------------------------- fairness
def similar(a: dict, b: dict) -> bool:
    """Same place, type and size, close in price and rating: a guest would see them as equal."""
    return (a["city"], a["property_type"], a["capacity"]) == (b["city"], b["property_type"], b["capacity"]) \
        and abs(a["nightly_price"] - b["nightly_price"]) <= 0.15 * max(a["nightly_price"], b["nightly_price"]) \
        and abs(fair_rating(a) - fair_rating(b)) <= 0.1


def concerns(eligible: list[dict], peers: Peers) -> list[dict]:
    """What a ranking built on price or popularity would get wrong. Never empty."""
    out = []

    def add(signal, props, detail):
        out.append({"signal": signal, "property_ids": [p["property_id"] for p in props], "detail": detail,
                    "evidence_refs": [ref(p) for p in props]})

    new = sorted((p for p in eligible if p["rating"] is None), key=lambda p: p["property_id"])[:3]
    if new:
        add("new_listing", new, "These meet every requirement but have no reviews, so a rating or popularity signal would bury them.")
    for i, a in enumerate(eligible):
        twin = next((b for b in eligible[i + 1:] if similar(a, b) and abs(a["review_count"] - b["review_count"]) >= 50), None)
        if twin:
            add("popularity", [a, twin], f"Nearly identical listings, but {a['review_count']} and {twin['review_count']} reviews. "
                                         "They should not be ranked far apart.")
            break
    if len(eligible) >= 2:
        cheap = min(eligible, key=lambda p: (p["nightly_price"], p["property_id"]))
        if peers.price_ratio(cheap) < 0.75 and fair_rating(cheap) < max(map(fair_rating, eligible)) - 0.15:
            add("price_only", [cheap], "The cheapest match is well below similar listings but not the best rated; price alone should not put it first.")
    if not out:
        add("price_weight", eligible[:1], "No specific bias found in this pool slice; the top pick should still hold without the price or popularity signals.")
    return out[:3]


def fairness(req: dict, pool: PropertyPool) -> dict:
    peers = Peers(pool)
    scored, eligible = {}, []
    for p in pool.properties:
        failed = failures(p, req)
        ratio = peers.price_ratio(p)
        # Value against similar listings instead of the lowest price, and a rating that
        # neither rewards a big review count nor punishes a new listing.
        value = max(0.0, 1 - abs(ratio - 0.9))
        base = 0.55 * fair_rating(p) + 0.35 * value + 0.10 * len(p["amenities"]) / 10
        reasons = _unmet(failed) + [f"Price is {ratio:.0%} of similar listings", "Review count ignored; few reviews treated as average"]
        scored[p["property_id"]] = _item(p, banded(base, len(failed)), reasons)
        if not failed:
            eligible.append(p)
    # Similar listings get the same score: their group's average.
    for p in eligible:
        group = [scored[q["property_id"]]["score"] for q in eligible if q is p or similar(p, q)]
        if len(group) > 1:
            item = scored[p["property_id"]]
            item["adjusted"] = round(sum(group) / len(group), 4)
            item["reasons"].append(f"Averaged with {len(group) - 1} similar listing(s)")
    for item in scored.values():
        item["score"] = item.pop("adjusted", item["score"])
    ranked = _rank(list(scored.values()))[:TOP_N]
    # Concern evidence must exist even when nothing matches: fall back to the best near miss.
    subject = eligible or [pool.by_id[ranked[0]["property_id"]]]
    return {"ranked": ranked, "confidence": _confidence(ranked, len(eligible)), "eligible_count": len(eligible),
            "concerns": concerns(subject, peers)}


RANKERS = {"matching": matching, "risk": risk, "fairness": fairness}


def checks(agent: str, opinion: dict) -> dict:
    """The five reflection checks of API doc §11, computed from the opinion."""
    top, n = opinion["ranked"][0], opinion["eligible_count"]
    met = top["reasons"][0] == _unmet([])[0]
    flagged = [f["property_id"] for f in opinion.get("risk_flags", [])]
    return {
        "constraint": "pass" if met else f"no property meets every requirement; best near miss {top['property_id']}",
        "evidence": "pass" if all(i["evidence_refs"] for i in opinion["ranked"]) else "missing",
        "risk": (f"flagged {', '.join(flagged)}" if flagged else "no high-risk match") if agent == "risk" else "n/a",
        "conflict": "n/a",  # round 0 is independent: there is nothing to conflict with yet
        "action": "no external action",
        "coverage": f"{n} of the pool meet every requirement; {NOT_IN_POOL}",
    }
