"""Agreement between the two human labellers, and what their labels say.

    python -m bench.agree --run eval_X              # finds the two sheets in bench/labels/eval_X/
    python -m bench.agree --run eval_X --partial    # while labelling is still in progress
    python -m bench.agree --run eval_X --record     # also put approval rate and kappa on agent_versions

Writes bench/labels/<run>/agreement.json, agreement.md and disagreements.csv (the rows
the two people should talk through). Nothing here creates or changes a label."""
import argparse
import csv
import json
import os
import sys
from collections import Counter
from pathlib import Path

from . import metrics
from .labels import LABEL_FIELDS, LABELS
from .run import now_iso

ORDINAL = {"relevance", "suitability"}


def read_sheet(path: Path) -> dict[str, dict]:
    with path.open(newline="") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        raise metrics.BenchError(f"{path.name} is empty")
    missing = (set(LABEL_FIELDS) | {"label_id", "property_id", "labeller", "run_id"}) - set(rows[0])
    if missing:
        raise metrics.BenchError(f"{path.name} lacks columns {sorted(missing)}")
    out = {}
    for row in rows:
        row = {k: (v or "").strip() for k, v in row.items() if k}
        for f, allowed in LABEL_FIELDS.items():
            v = row[f].lower()
            if v and v not in allowed:
                raise metrics.BenchError(f"{path.name} {row['label_id']}: {f} is {row[f]!r}, use one of {'/'.join(allowed)}")
            row[f] = v
        out[row["label_id"]] = row
    return out


def complete(row: dict) -> bool:
    return all(row[f] for f in LABEL_FIELDS)


def compare(a: dict[str, dict], b: dict[str, dict], partial: bool) -> tuple[list[str], dict]:
    """(label ids both people finished, problems). Refuses sheets from different runs or with different stays."""
    if set(a) != set(b):
        raise metrics.BenchError("the two sheets do not have the same rows; were they made from the same run?")
    for lid in a:
        if a[lid]["property_id"] != b[lid]["property_id"] or a[lid]["run_id"] != b[lid]["run_id"]:
            raise metrics.BenchError(f"{lid}: the sheets disagree on the stay or run; regenerate them from one run")
    names = {next(iter(a.values()))["labeller"], next(iter(b.values()))["labeller"]}
    if len(names) < 2:
        raise metrics.BenchError("both sheets name the same labeller; two different people are needed")
    open_rows = {"a": sum(not complete(r) for r in a.values()), "b": sum(not complete(r) for r in b.values())}
    if (open_rows["a"] or open_rows["b"]) and not partial:
        raise metrics.BenchError(f"labelling is not finished ({open_rows['a']} and {open_rows['b']} rows still blank). "
                                 "Use --partial for an interim look.")
    ids = sorted(lid for lid in a if complete(a[lid]) and complete(b[lid]))
    if not ids:
        raise metrics.BenchError("no row has been labelled by both people yet")
    return ids, open_rows


def report(a: dict, b: dict, ids: list[str]) -> dict:
    name_a, name_b = a[ids[0]]["labeller"], b[ids[0]]["labeller"]
    fields = {}
    for f, cats in LABEL_FIELDS.items():
        x, y = [a[i][f] for i in ids], [b[i][f] for i in ids]
        kappa = metrics.cohen_kappa(x, y, list(cats))
        fields[f] = {"percent_agreement": round(metrics.percent_agreement(x, y), 3),
                     "cohen_kappa": None if kappa is None else round(kappa, 3), "reading": metrics.kappa_words(kappa),
                     "counts": {name_a: dict(Counter(x)), name_b: dict(Counter(y))},
                     "pairs": {f"{p}|{q}": n for (p, q), n in sorted(Counter(zip(x, y)).items())}}
        if f in ORDINAL:
            wk = metrics.cohen_kappa(x, y, list(cats), weights="quadratic")
            fields[f]["weighted_kappa"] = None if wk is None else round(wk, 3)

    def per_person(sheet):
        rows = [sheet[i] for i in ids]
        return {"mean_relevance": round(sum(int(r["relevance"]) for r in rows) / len(rows), 3),
                "mean_suitability": round(sum(int(r["suitability"]) for r in rows) / len(rows), 3),
                "filters_correct": round(sum(r["filters_correct"] == "yes" for r in rows) / len(rows), 3),
                "fairness_concerns": sum(r["fairness_concern"] == "yes" for r in rows)}

    top = [i for i in ids if i.endswith("-1")]
    # A top pick counts as approved when both people would accept it (suitability 1 or 2).
    approved = [i for i in top if int(a[i]["suitability"]) >= 1 and int(b[i]["suitability"]) >= 1]
    both_relevant = [i for i in ids if int(a[i]["relevance"]) >= 1 and int(b[i]["relevance"]) >= 1]
    return {"labellers": [name_a, name_b], "rows": len(ids), "requests": len({i.rsplit("-", 1)[0] for i in ids}),
            "fields": fields, "per_labeller": {name_a: per_person(a), name_b: per_person(b)},
            "approval_rate": round(len(approved) / len(top), 3) if top else None, "top_picks": len(top),
            "human_precision_at_3": round(len(both_relevant) / len(ids), 3)}


def write_outputs(folder: Path, rep: dict, a: dict, b: dict, ids: list[str]):
    (folder / "agreement.json").write_text(json.dumps(rep, indent=1))
    name_a, name_b = rep["labellers"]
    differ = [i for i in ids if any(a[i][f] != b[i][f] for f in LABEL_FIELDS)]
    with (folder / "disagreements.csv").open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["label_id", "request", "property_id", "title", *[f"{f}_{n}" for f in LABEL_FIELDS for n in ("a", "b")],
                    f"notes_{name_a}", f"notes_{name_b}", "agreed_after_discussion"])
        for i in differ:
            w.writerow([i, a[i]["request"], a[i]["property_id"], a[i]["title"], *[s[i][f] for f in LABEL_FIELDS for s in (a, b)],
                        a[i]["notes"], b[i]["notes"], ""])
    lines = [f"# Labeller agreement, run {a[ids[0]]['run_id']}", "",
             f"Labellers: {name_a} (a) and {name_b} (b). {rep['rows']} rows over {rep['requests']} requests, labelled independently.", "",
             "| Field | Agreement | Cohen's kappa | Weighted kappa | Reading |", "|---|---|---|---|---|"]
    for f, v in rep["fields"].items():
        lines.append(f"| {f} | {v['percent_agreement']:.0%} | {v['cohen_kappa']} | {v.get('weighted_kappa', '–')} | {v['reading']} |")
    lines += ["", f"Approval rate (both would accept the top pick): {rep['approval_rate']}",
              f"Rows both rated relevant (1 or 2): {rep['human_precision_at_3']}", "",
              "| Labeller | Mean relevance | Mean suitability | Filters correct | Fairness concerns |", "|---|---|---|---|---|"]
    for n, v in rep["per_labeller"].items():
        lines.append(f"| {n} | {v['mean_relevance']} | {v['mean_suitability']} | {v['filters_correct']:.0%} | {v['fairness_concerns']} |")
    lines += ["", f"{len(differ)} rows differ in at least one field: see disagreements.csv.", ""]
    (folder / "agreement.md").write_text("\n".join(lines))
    return "\n".join(lines), len(differ)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True)
    ap.add_argument("--sheets", nargs=2, metavar="CSV", help="the two sheets (default: the two in bench/labels/<run>/)")
    ap.add_argument("--partial", action="store_true", help="only rows both people have finished")
    ap.add_argument("--record", action="store_true", help="put approval_rate and the agreement on agent_versions")
    ap.add_argument("--mongo", default=os.getenv("BENCH_MONGO_URL", "mongodb://localhost:27018"))
    ap.add_argument("--mongo-db", default=os.getenv("MONGO_DB", "airbnb"))
    args = ap.parse_args(argv)

    folder = LABELS / args.run
    paths = [Path(p) for p in args.sheets] if args.sheets else sorted(p for p in folder.glob("*.csv") if p.name != "disagreements.csv")
    if len(paths) != 2:
        sys.exit(f"Need exactly two labelling sheets in {folder}, found {len(paths)}: {[p.name for p in paths]}")
    try:
        a, b = (read_sheet(p) for p in paths)
        ids, open_rows = compare(a, b, args.partial)
    except metrics.BenchError as exc:
        sys.exit(f"Cannot compare: {exc}")
    rep = report(a, b, ids)
    rep.update(run_id=args.run, interim=bool(open_rows["a"] or open_rows["b"]), computed_at=now_iso())
    folder.mkdir(parents=True, exist_ok=True)
    text, _ = write_outputs(folder, rep, a, b, ids)
    print(text)
    if rep["interim"]:
        print(f"INTERIM: {open_rows['a']} and {open_rows['b']} rows are still blank.")
    if args.record:
        if rep["interim"]:
            sys.exit("Not recording interim labels.")
        record(args.run, rep, args.mongo, args.mongo_db)


def record(run_id: str, rep: dict, mongo_url: str, mongo_db: str):
    from pymongo import MongoClient

    with MongoClient(mongo_url, serverSelectionTimeoutMS=5000) as mc:
        versions = mc[mongo_db].agent_versions
        v = versions.find_one({"eval_run_id": run_id})
        if not v:
            sys.exit(f"No version has eval_run_id {run_id}; run python -m bench.run --run {run_id} --record first")
        versions.update_one({"version_id": v["version_id"]}, {"$set": {
            "approval_rate": rep["approval_rate"],
            "human_eval": {"labellers": rep["labellers"], "rows": rep["rows"], "human_precision_at_3": rep["human_precision_at_3"],
                           "kappa": {f: x["cohen_kappa"] for f, x in rep["fields"].items()},
                           "percent_agreement": {f: x["percent_agreement"] for f, x in rep["fields"].items()}}}})
    print(f"Recorded approval rate {rep['approval_rate']} and agreement on {v['version_id']}")


if __name__ == "__main__":
    main()
