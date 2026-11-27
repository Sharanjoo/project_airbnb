"""Blank labelling sheets for the two human labellers (instructions: bench/README.md).

    python -m bench.labels --run eval_X --labeller "First Last"

Writes bench/labels/<run>/<first-last>.csv: one row per recommended stay (top 3 of each
request), with the request and the listing's facts, and empty label columns. The sheet
never shows agent scores, votes or the parser's reading, so the labels are the
person's own judgement. Run it once per labeller; an existing sheet is never overwritten."""
import argparse
import csv
import json
import re
import sys
from pathlib import Path

from app.pool import load_pool

from . import metrics

HERE = Path(__file__).resolve().parent
LABELS = HERE / "labels"
TOP = 3
FACTS = ["label_id", "run_id", "labeller", "request_id", "request", "rank", "property_id", "title", "city", "property_type",
         "sleeps", "nightly_price", "rating", "reviews", "amenities"]
LABEL_FIELDS = {"relevance": ("0", "1", "2"), "suitability": ("0", "1", "2"), "filters_correct": ("yes", "no"),
                "fairness_concern": ("yes", "no")}
COLUMNS = FACTS + list(LABEL_FIELDS) + ["notes"]


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not s:
        raise SystemExit("--labeller needs a name")
    return s


def rows(data: dict, requests: dict, pool, labeller: str) -> list[dict]:
    out = []
    for rid, r in requests.items():
        result = (data["entries"].get(rid) or {}).get("result")
        if not result:
            continue  # nothing to label; agree.py reports these as missing
        for rank, pid in enumerate(result["ranked"][:TOP], 1):
            p = pool.by_id[pid]
            out.append({"label_id": f"{rid}-{rank}", "run_id": data["run_id"], "labeller": labeller, "request_id": rid,
                        "request": metrics.describe(r), "rank": rank, "property_id": pid, "title": p["title"], "city": p["city"],
                        "property_type": p["property_type"].replace("_", " "), "sleeps": p["capacity"],
                        "nightly_price": p["nightly_price"], "rating": "new, no reviews" if p["rating"] is None else p["rating"],
                        "reviews": p["review_count"], "amenities": ", ".join(p["amenities"]),
                        **{f: "" for f in LABEL_FIELDS}, "notes": ""})
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True)
    ap.add_argument("--labeller", required=True, help="the real person who will fill in this sheet")
    args = ap.parse_args(argv)

    path = HERE / "results" / f"{args.run}.json"
    if not path.exists():
        sys.exit(f"No results at {path}; run python -m bench.run first")
    data = json.loads(path.read_text())
    pool = load_pool()
    requests = {r["id"]: r for r in metrics.load_requests(HERE / "requests.json", pool)}
    out = LABELS / args.run / f"{slug(args.labeller)}.csv"
    if out.exists():
        sys.exit(f"{out} already exists and may hold real labels; not overwriting it")
    sheet = rows(data, requests, pool, args.labeller)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="") as fh:
        w = csv.DictWriter(fh, COLUMNS)
        w.writeheader()
        w.writerows(sheet)
    missing = len(requests) - len({r["request_id"] for r in sheet})
    print(f"Wrote {len(sheet)} rows for {args.labeller} to {out}" + (f" ({missing} requests had no result)" if missing else ""))
    print("Fill in relevance, suitability (0/1/2), filters_correct, fairness_concern (yes/no) and notes; see bench/README.md.")


if __name__ == "__main__":
    main()
