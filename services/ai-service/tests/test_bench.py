"""The 50-request benchmark: answer key, metrics, labelling sheets and agreement.
Label values below are test fixtures for the arithmetic, not benchmark labels."""
import csv
import json

import pytest

from app.pool import load_pool
from bench import agree, labels, metrics, run
from bench.run import HERE

POOL = load_pool()
REQUESTS = metrics.load_requests(HERE / "requests.json", POOL)


# ------------------------------------------------------------- answer key
def test_the_request_set_is_fifty_fixed_requests():
    assert len(REQUESTS) == 50
    assert {r["category"] for r in REQUESTS} == set(metrics.CATEGORIES)
    assert len({metrics.describe(r) for r in REQUESTS}) == 50


def test_no_match_requests_really_have_no_match_and_the_rest_do():
    for r in REQUESTS:
        found = metrics.relevant(POOL, r["expected"])
        assert (not found) == (r["category"] == "no_match"), r["id"]


def test_every_request_is_a_valid_api_body():
    from app.main import AiRequest
    for r in REQUESTS:
        AiRequest(**metrics.request_body(r))


@pytest.mark.parametrize("change,problem", [
    ({"extra": 1}, "unknown field"), ({"category": "misc"}, "category"), ({"expected": {"city": "Paris"}}, "city"),
    ({"expected": {"amenities": ["sauna"]}}, "amenity"), ({"expected": {"nights": 2}}, "expected must be"),
])
def test_a_typo_in_the_answer_key_is_refused(tmp_path, change, problem):
    row = {"id": "X1", "category": "text", "request_text": "San Jose for 2", "expected": {"city": "San Jose"}, **change}
    path = tmp_path / "r.json"
    path.write_text(json.dumps({"pool_ref": POOL.ref, "requests": [row]}))
    with pytest.raises(metrics.BenchError, match=problem):
        metrics.load_requests(path, POOL)


def test_requests_for_another_pool_are_refused(tmp_path):
    path = tmp_path / "r.json"
    path.write_text(json.dumps({"pool_ref": "other-pool", "requests": []}))
    with pytest.raises(metrics.BenchError, match="pool"):
        metrics.load_requests(path, POOL)


def test_describe_shows_text_and_form_filters():
    r = {"request_text": "quiet please", "structured": {"city": "Napa", "amenities": ["pool", "wifi"], "guests": None},
         "check_in": "2027-05-14"}
    assert metrics.describe(r) == "quiet please [form: city=Napa; amenities=pool, wifi; check_in=2027-05-14]"


# --------------------------------------------------------------- relevance
def test_an_area_is_a_list_of_cities():
    exp = {"city": ["Oakland", "San Jose"], "guests": 2}
    cities = {POOL.by_id[p]["city"] for p in metrics.relevant(POOL, exp)}
    assert cities == {"Oakland", "San Jose"}


def test_precision_recall_and_rank():
    ranked = ["a", "b", "c", "d"] + [f"x{i}" for i in range(6)]
    assert metrics.precision_at(ranked, {"b", "d", "z"}) == 0.2
    assert metrics.recall_at(ranked, {"b", "d", "z"}) == pytest.approx(2 / 3)
    assert metrics.precision_at(ranked, {"b"}, 3) == pytest.approx(1 / 3)
    assert metrics.recall_at(ranked, set()) is None
    assert metrics.first_relevant(ranked, {"c", "d"}) == 3
    assert metrics.first_relevant(ranked, {"z"}) is None


def test_the_baseline_is_a_plain_filter_sorted_by_rating():
    req = {"city": "Napa", "guests": 2}
    top, count = metrics.baseline(POOL, req)
    hits = [p for p in POOL.properties if p["city"] == "Napa" and p["capacity"] >= 2]
    assert count == len(hits)
    rated = [POOL.by_id[p]["rating"] for p in top if POOL.by_id[p]["rating"] is not None]
    assert rated == sorted(rated, reverse=True)
    assert all(POOL.by_id[p]["rating"] is not None for p in top[:len(rated)])  # new listings after rated ones


# ------------------------------------------------------------------ parser
def test_parser_diff():
    exp = {"city": "Oakland", "guests": 2, "price_max": 200, "amenities": ["wifi"]}
    assert metrics.parser_diff({"city": "Oakland", "guests": 2, "price_max": 200.0, "amenities": ["wifi"], "check_in": "2027-01-01"}, exp) == []
    diff = metrics.parser_diff({"city": "Oakland", "guests": None, "price_max": 600, "amenities": []}, exp)
    assert [d.split(":")[0] for d in diff] == ["guests", "price_max", "amenities"]
    # an area cannot be one city: picking one is wrong, leaving it open is right
    area = {"city": ["Oakland", "San Jose"]}
    assert metrics.parser_diff({"city": "Oakland"}, area) and not metrics.parser_diff({"city": None}, area)
    assert metrics.parser_diff({"check_in": "2027-01-02"}, {"check_in": "2027-01-01"})


# --------------------------------------------------------------- scoring
def entry_for(r, ranked, **result):
    return {"id": r["id"], "category": r["category"], "status": "AWAITING_APPROVAL", "provider": "deterministic", "result": {
        "parsed_request": r["expected"], "ranked": ranked, "limitations": [], "disagreement_score": 0.5,
        "decision": {"mode": "majority"}, "timings_ms": {"total": 900, "parse": 100, "round0": 300, "debate": 400, "decide": 100},
        "config_version": "matcher-v1", **result}}


def test_score_one_request():
    r = next(x for x in REQUESTS if x["id"] == "R01")
    rel = sorted(metrics.relevant(POOL, r["expected"]))
    others = [p for p in POOL.ids if p not in rel][:10 - len(rel)]
    m = metrics.score(entry_for(r, rel[:1] + sorted(others) + rel[1:]), r, POOL)
    assert m["relevant_count"] == len(rel) and m["parser_diff"] == []
    assert m["precision_at_10"] == len(rel) / 10 and m["recall_at_10"] == 1.0
    assert m["first_relevant_rank"] == 1 and m["top_pick_relevant"]
    assert m["parsed_filter_count"] == len(rel)  # parsed = expected here, so the baseline finds exactly the relevant set
    assert m["baseline_recall_at_10"] == 1.0


def test_a_failed_request_scores_only_the_count():
    r = REQUESTS[0]
    assert metrics.score({"id": r["id"], "status": "TIMED_OUT"}, r, POOL) == {"relevant_count": len(metrics.relevant(POOL, r["expected"]))}


def test_no_match_must_be_said():
    r = next(x for x in REQUESTS if x["category"] == "no_match")
    said = entry_for(r, sorted(POOL.ids)[:10], limitations=["No property meets every stated requirement; this is the closest match."])
    assert metrics.score(said, r, POOL)["said_no_exact_match"]
    assert not metrics.score(entry_for(r, sorted(POOL.ids)[:10]), r, POOL)["said_no_exact_match"]


def test_summary_leaves_no_match_requests_out_of_precision():
    good = next(x for x in REQUESTS if x["id"] == "R01")
    none = next(x for x in REQUESTS if x["category"] == "no_match")
    rel = sorted(metrics.relevant(POOL, good["expected"]))
    entries = [entry_for(good, rel + [p for p in sorted(POOL.ids) if p not in rel][:10 - len(rel)]),
               entry_for(none, sorted(POOL.ids)[:10]), {"id": "R02", "category": "text", "status": "TIMED_OUT", "timeouts": [{"agent": "risk", "round": 0}]}]
    for e, r in zip(entries, (good, none, REQUESTS[1])):
        e["metrics"] = metrics.score(e, r, POOL)
    s = metrics.summarize(entries)
    assert s["requests"] == 3 and s["completed"] == 2 and s["scored_requests"] == 1
    assert s["agents"]["recall_at_10"] == 1.0 and s["agents"]["mean_rank"] == 1
    assert s["no_match"] == {"requests": 1, "said_so": 0}
    assert s["agent_timeouts"] == 1 and s["latency_ms"]["total"]["p50"] == 900


def test_csv_has_one_row_per_request(tmp_path):
    r = REQUESTS[0]
    e = entry_for(r, sorted(POOL.ids)[:10])
    e["metrics"] = metrics.score(e, r, POOL)
    run.write_csv(tmp_path / "x.csv", [e], {r["id"]: r})
    rows = list(csv.DictReader((tmp_path / "x.csv").open()))
    assert len(rows) == 1 and rows[0]["request"] == r["request_text"] and rows[0]["total_ms"] == "900"


def test_a_partial_run_is_not_recorded():
    data = {"run_id": "eval_t", "requests": 50, "entries": {"R01": {"id": "R01", "result": {"config_version": "matcher-v1"}}}}
    with pytest.raises(SystemExit, match="Not recording"):
        run.record(data, "mongodb://unused:1", "x")


# ------------------------------------------------------------ agreement
def test_kappa_textbook_example():
    # 50 items: both yes 20, a yes / b no 5, a no / b yes 10, both no 15 -> po 0.7, pe 0.5, kappa 0.4
    a = ["yes"] * 25 + ["no"] * 25
    b = ["yes"] * 20 + ["no"] * 5 + ["yes"] * 10 + ["no"] * 15
    assert metrics.percent_agreement(a, b) == 0.7
    assert metrics.cohen_kappa(a, b) == pytest.approx(0.4)
    assert metrics.kappa_words(0.4) == "fair"


def test_quadratic_weighted_kappa():
    a, b = ["0", "1", "2", "2"], ["0", "2", "2", "1"]
    assert metrics.cohen_kappa(a, b, ["0", "1", "2"], "quadratic") == pytest.approx(1 - 0.125 / 0.34375)
    assert metrics.cohen_kappa(a, a, ["0", "1", "2"], "quadratic") == pytest.approx(1.0)


def test_kappa_is_undefined_without_variation():
    assert metrics.cohen_kappa(["2"] * 5, ["2"] * 5) is None
    assert metrics.kappa_words(None).startswith("not defined")
    with pytest.raises(metrics.BenchError):
        metrics.percent_agreement([], [])


def sheet(tmp_path, name, values, run_id="eval_t"):
    """values: one (relevance, suitability, filters, fairness) tuple per row."""
    path = tmp_path / f"{labels.slug(name)}.csv"
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, labels.COLUMNS)
        w.writeheader()
        for n, (rel, suit, flt, fair) in enumerate(values):
            w.writerow({"label_id": f"R{n // 3 + 1:02d}-{n % 3 + 1}", "run_id": run_id, "labeller": name, "request": "x",
                        "property_id": f"prp_{n}", "relevance": rel, "suitability": suit, "filters_correct": flt,
                        "fairness_concern": fair, "notes": ""})
    return agree.read_sheet(path)


def test_agreement_report(tmp_path):
    a = sheet(tmp_path, "Person A", [("2", "2", "yes", "no"), ("1", "1", "yes", "no"), ("0", "0", "no", "yes"),
                                     ("2", "1", "yes", "no"), ("1", "1", "yes", "no"), ("0", "0", "no", "no")])
    b = sheet(tmp_path, "Person B", [("2", "1", "yes", "no"), ("1", "1", "yes", "no"), ("0", "1", "no", "no"),
                                     ("2", "0", "yes", "no"), ("1", "1", "no", "no"), ("1", "0", "no", "no")])
    ids, open_rows = agree.compare(a, b, partial=False)
    rep = agree.report(a, b, ids)
    assert rep["labellers"] == ["Person A", "Person B"] and rep["rows"] == 6 and rep["requests"] == 2
    assert rep["fields"]["relevance"]["percent_agreement"] == pytest.approx(5 / 6, abs=1e-3)
    assert rep["approval_rate"] == 0.5  # R01-1 both >= 1, R02-1 has a 0
    assert "weighted_kappa" in rep["fields"]["suitability"] and "weighted_kappa" not in rep["fields"]["filters_correct"]
    text, differ = agree.write_outputs(tmp_path, rep, a, b, ids)
    assert differ == 5 and "Cohen's kappa" in text
    assert len(list(csv.reader((tmp_path / "disagreements.csv").open()))) == 6


def test_unfinished_labels_need_partial(tmp_path):
    a = sheet(tmp_path, "Person A", [("2", "2", "yes", "no"), ("1", "", "yes", "no")])
    b = sheet(tmp_path, "Person B", [("2", "2", "yes", "no"), ("1", "1", "yes", "no")])
    with pytest.raises(metrics.BenchError, match="not finished"):
        agree.compare(a, b, partial=False)
    ids, open_rows = agree.compare(a, b, partial=True)
    assert ids == ["R01-1"] and open_rows == {"a": 1, "b": 0}


def test_sheets_must_come_from_two_people_and_one_run(tmp_path):
    a = sheet(tmp_path, "Person A", [("2", "2", "yes", "no")])
    (tmp_path / "b").mkdir()
    same = sheet(tmp_path / "b", "Person A", [("1", "1", "yes", "no")])
    with pytest.raises(metrics.BenchError, match="two different people"):
        agree.compare(a, same, partial=False)
    other = sheet(tmp_path, "Person B", [("2", "2", "yes", "no")], run_id="eval_other")
    with pytest.raises(metrics.BenchError, match="same run|stay or run"):
        agree.compare(a, other, partial=False)


def test_a_label_outside_the_scale_is_refused(tmp_path):
    with pytest.raises(metrics.BenchError, match="relevance"):
        sheet(tmp_path, "Person A", [("3", "2", "yes", "no")])


def test_sheet_rows_show_facts_but_no_agent_scores():
    r = REQUESTS[0]
    data = {"run_id": "eval_t", "entries": {r["id"]: {"result": {"ranked": sorted(POOL.ids)[:10]}}}}
    rows = labels.rows(data, {r["id"]: r}, POOL, "Person A")
    assert [x["label_id"] for x in rows] == ["R01-1", "R01-2", "R01-3"]
    assert set(rows[0]) == set(labels.COLUMNS)
    assert all(rows[0][f] == "" for f in labels.LABEL_FIELDS)
    assert not {"score", "confidence", "votes", "parsed_request"} & set(rows[0])
