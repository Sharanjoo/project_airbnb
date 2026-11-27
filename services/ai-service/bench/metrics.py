"""Benchmark scoring, all pure functions (tested in tests/test_bench.py).

Two kinds of numbers come out of the benchmark:

  automatic   computed here from the fixed pool and each request's hand-written
              'expected' constraints: parser accuracy, precision@10, recall@10,
              mean rank, and the same for a plain filter search (the baseline).
  human       relevance / suitability / filter / fairness labels that two real
              people give the top 3 (bench/labels.py makes the sheets). This file
              only measures how much the two people agree; it never makes a label.
"""
import json
import math
from collections import Counter
from pathlib import Path
from statistics import mean, median

from agents.scoring import failures
from app.pool import AMENITIES, PropertyPool

K = 10
REQUEST_FIELDS = {"id", "category", "request_text", "structured", "check_in", "check_out", "expected"}
EXPECTED_FIELDS = {"city", "guests", "price_max", "amenities", "min_rating", "check_in", "check_out"}
CATEGORIES = ("text", "dates", "structured", "paraphrase", "no_match", "vague")


class BenchError(Exception):
    pass


# ------------------------------------------------------------- the request set
def load_requests(path: Path, pool: PropertyPool) -> list[dict]:
    """The fixed request set, checked so a typo cannot quietly change the answer key."""
    data = json.loads(Path(path).read_text())
    if data.get("pool_ref") != pool.ref:
        raise BenchError(f"requests are for pool {data.get('pool_ref')}, the loaded pool is {pool.ref}")
    rows = data.get("requests") or []
    ids = [r.get("id") for r in rows]
    if len(set(ids)) != len(ids):
        raise BenchError("duplicate request id")
    for r in rows:
        where = r.get("id", "?")
        if set(r) - REQUEST_FIELDS:
            raise BenchError(f"{where}: unknown field(s) {sorted(set(r) - REQUEST_FIELDS)}")
        if r.get("category") not in CATEGORIES:
            raise BenchError(f"{where}: category must be one of {CATEGORIES}")
        if not r.get("request_text") and not r.get("structured"):
            raise BenchError(f"{where}: needs request_text or structured")
        exp = r.get("expected")
        if not isinstance(exp, dict) or set(exp) - EXPECTED_FIELDS:
            raise BenchError(f"{where}: expected must be an object with only {sorted(EXPECTED_FIELDS)}")
        cities = exp.get("city") if isinstance(exp.get("city"), list) else [exp["city"]] if exp.get("city") else []
        if any(c not in pool.cities for c in cities):
            raise BenchError(f"{where}: expected city is not in the pool")
        if set(exp.get("amenities", [])) - set(AMENITIES):
            raise BenchError(f"{where}: unknown amenity in expected")
    return rows


def request_body(r: dict, config_version: str | None = None) -> dict:
    """The POST /ai/requests body for one benchmark request."""
    body = {k: r[k] for k in ("request_text", "structured", "check_in", "check_out") if r.get(k)}
    if config_version:
        body["config_version"] = config_version
    return body


def describe(r: dict) -> str:
    """One line a labeller can read: the text plus any form filters."""
    parts = [r["request_text"]] if r.get("request_text") else []
    s = r.get("structured") or {}
    filters = [f"{k}={', '.join(v) if isinstance(v, list) else v}" for k, v in s.items() if v not in (None, [])]
    filters += [f"{k}={r[k]}" for k in ("check_in", "check_out") if r.get(k)]
    if filters:
        parts.append(f"[form: {'; '.join(filters)}]")
    return " ".join(parts)


# ------------------------------------------------------------------ relevance
def misses(p: dict, expected: dict) -> list[str]:
    """Hard constraints from 'expected' that this property does not meet. Dates are not
    checked: the pool has no calendar (the Chair checks dates with the property service)."""
    city = expected.get("city")
    out = []
    if isinstance(city, list):
        if p["city"] not in city:
            out.append("city")
        expected = {k: v for k, v in expected.items() if k != "city"}
    return out + failures(p, expected)


def relevant(pool: PropertyPool, expected: dict) -> set[str]:
    return {p["property_id"] for p in pool.properties if not misses(p, expected)}


def precision_at(ranked: list[str], rel: set[str], k: int = K) -> float:
    return sum(p in rel for p in ranked[:k]) / k


def recall_at(ranked: list[str], rel: set[str], k: int = K) -> float | None:
    """None when nothing in the pool is relevant: recall is not defined there."""
    return sum(p in rel for p in ranked[:k]) / len(rel) if rel else None


def first_relevant(ranked: list[str], rel: set[str], k: int = K) -> int | None:
    """1-based rank of the first relevant property in the top k, or None."""
    return next((i for i, p in enumerate(ranked[:k], 1) if p in rel), None)


def baseline(pool: PropertyPool, req: dict, k: int = K) -> tuple[list[str], int]:
    """The filter-count baseline: a plain search with the same parsed filters, sorted the
    way a listing site would (rating, then review count, then price). (top k, how many matched)."""
    hits = [p for p in pool.properties if not failures(p, req)]
    hits.sort(key=lambda p: (p["rating"] is None, -(p["rating"] or 0), -p["review_count"], p["nightly_price"], p["property_id"]))
    return [p["property_id"] for p in hits[:k]], len(hits)


# ------------------------------------------------------------------- parser
def parser_diff(parsed: dict, expected: dict) -> list[str]:
    """Fields where the parser's requirements differ from the answer key. An area
    (city list) cannot be one city, so there the right answer is no city."""
    out = []
    for f in ("city", "guests", "price_max", "min_rating", "check_in", "check_out"):
        want, got = expected.get(f), parsed.get(f)
        if f in ("check_in", "check_out") and f not in expected:
            continue  # the parser may work out dates the key does not care about
        if isinstance(want, list):
            want = None
        if isinstance(want, (int, float)) and isinstance(got, (int, float)):
            same = math.isclose(want, got, abs_tol=0.01)
        else:
            same = want == got
        if not same:
            out.append(f"{f}: expected {want}, got {got}")
    want, got = set(expected.get("amenities", [])), set(parsed.get("amenities") or [])
    if want != got:
        out.append(f"amenities: expected {sorted(want)}, got {sorted(got)}")
    return out


# --------------------------------------------------------------- one request
def score(entry: dict, r: dict, pool: PropertyPool) -> dict:
    """Automatic metrics for one finished request. Failed runs only get the counts."""
    rel = relevant(pool, r["expected"])
    out = {"relevant_count": len(rel)}
    result = entry.get("result")
    if not result:
        return out
    parsed = result["parsed_request"]
    ranked = result["ranked"]
    base, base_count = baseline(pool, parsed)
    out.update({
        "parser_diff": parser_diff(parsed, r["expected"]),
        "parsed_filter_count": base_count,
        "precision_at_10": precision_at(ranked, rel), "recall_at_10": recall_at(ranked, rel),
        "precision_at_3": precision_at(ranked, rel, 3), "first_relevant_rank": first_relevant(ranked, rel),
        "top_pick_relevant": ranked[0] in rel if ranked else False,
        "baseline_top10": base,
        "baseline_precision_at_10": precision_at(base, rel), "baseline_recall_at_10": recall_at(base, rel),
        "baseline_precision_at_3": precision_at(base, rel, 3),
        "baseline_first_relevant_rank": first_relevant(base, rel),
        # A request nothing can satisfy should say so instead of passing off a near miss.
        "said_no_exact_match": any(s.startswith("No property meets every stated requirement") for s in result["limitations"]),
    })
    return out


# --------------------------------------------------------------------- a run
def _pct(values: list[float], q: float) -> float | None:
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, max(0, math.ceil(q * len(s)) - 1))]


def _avg(values) -> float | None:
    values = [v for v in values if v is not None]
    return round(mean(values), 3) if values else None


def summarize(entries: list[dict]) -> dict:
    """The run's headline numbers. Precision/recall/mean rank only count requests where the
    pool has at least one relevant property; no-match requests are reported on their own."""
    done = [e for e in entries if e.get("result")]
    scored = [e for e in done if e["metrics"]["relevant_count"]]
    no_match = [e for e in done if not e["metrics"]["relevant_count"]]
    phases = {}
    for phase in ("total", "parse", "round0", "debate", "decide"):
        values = [e["result"]["timings_ms"][phase] for e in done if e["result"]["timings_ms"].get(phase) is not None]
        phases[phase] = {"p50": _pct(values, 0.5), "p95": _pct(values, 0.95), "mean": _avg(values)}

    def side(prefix: str) -> dict:
        m = [e["metrics"] for e in scored]
        ranks = [x[f"{prefix}first_relevant_rank"] or K + 1 for x in m]  # never found = just past the list
        return {"precision_at_10": _avg(x[f"{prefix}precision_at_10"] for x in m),
                "recall_at_10": _avg(x[f"{prefix}recall_at_10"] for x in m),
                "precision_at_3": _avg(x[f"{prefix}precision_at_3"] for x in m),
                "mean_rank": _avg(ranks)}

    by_cat = {}
    for c in CATEGORIES:
        rows = [e for e in done if e["category"] == c]
        if rows:
            by_cat[c] = {"done": len(rows), "parser_exact": _avg(not e["metrics"]["parser_diff"] for e in rows),
                         "precision_at_10": _avg(e["metrics"]["precision_at_10"] for e in rows if e["metrics"]["relevant_count"])}
    fields = Counter(d.split(":")[0] for e in done for d in e["metrics"]["parser_diff"])
    return {
        "requests": len(entries), "completed": len(done),
        "statuses": dict(Counter(e.get("status") for e in entries)),
        "agent_timeouts": sum(len(e.get("timeouts", [])) for e in entries),
        "harness_rejections": sum(e.get("rejected", 0) for e in entries),
        "providers": dict(Counter(e.get("provider") for e in done)),
        "llm_fallbacks": dict(Counter(e.get("fallback") for e in done if e.get("fallback"))),
        "latency_ms": phases,
        "disagreement": {"mean": _avg(e["result"]["disagreement_score"] for e in done),
                         "median": median([e["result"]["disagreement_score"] for e in done]) if done else None},
        "decision_modes": dict(Counter(e["result"]["decision"]["mode"] for e in done)),
        "parser": {"exact": _avg(not e["metrics"]["parser_diff"] for e in done), "wrong_fields": dict(fields)},
        "scored_requests": len(scored),
        "agents": {**side(""), "top_pick_relevant": _avg(e["metrics"]["top_pick_relevant"] for e in scored)},
        "baseline": side("baseline_"),
        "filter_count": {"expected_mean": _avg(e["metrics"]["relevant_count"] for e in done),
                         "parsed_mean": _avg(e["metrics"]["parsed_filter_count"] for e in done)},
        "no_match": {"requests": len(no_match), "said_so": sum(e["metrics"]["said_no_exact_match"] for e in no_match)},
        "by_category": by_cat,
    }


# ---------------------------------------------------------------- agreement
def percent_agreement(a: list, b: list) -> float:
    if len(a) != len(b) or not a:
        raise BenchError("need two equally long, non-empty label lists")
    return sum(x == y for x, y in zip(a, b)) / len(a)


def cohen_kappa(a: list, b: list, categories: list | None = None, weights: str | None = None) -> float | None:
    """Cohen's kappa; weights='quadratic' for ordered labels such as 0/1/2.
    None when chance agreement is already 1 (both people used one value only)."""
    cats = categories or sorted(set(a) | set(b))
    n, idx = len(a), {c: i for i, c in enumerate(cats)}
    if len(a) != len(b) or not n:
        raise BenchError("need two equally long, non-empty label lists")
    k = len(cats)

    def w(i, j):  # disagreement weight
        if weights == "quadratic":
            return ((i - j) / (k - 1)) ** 2 if k > 1 else 0.0
        return 0.0 if i == j else 1.0

    pa, pb = Counter(idx[x] for x in a), Counter(idx[y] for y in b)
    observed = sum(w(idx[x], idx[y]) for x, y in zip(a, b)) / n
    expected = sum(w(i, j) * pa[i] * pb[j] for i in range(k) for j in range(k)) / (n * n)
    if math.isclose(expected, 0.0):
        return None
    return 1 - observed / expected


def kappa_words(kappa: float | None) -> str:
    """Landis and Koch's usual reading of a kappa value."""
    if kappa is None:
        return "not defined (no variation)"
    for limit, word in ((0, "poor"), (0.2, "slight"), (0.4, "fair"), (0.6, "moderate"), (0.8, "substantial")):
        if kappa <= limit:
            return word
    return "almost perfect"
