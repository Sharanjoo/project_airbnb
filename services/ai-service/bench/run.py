"""Run the 50-request benchmark through the gateway, exactly as the client does:
sign up a guest, POST /ai/requests, follow the task's WebSocket stream to the end.

    cd services/ai-service
    python -m bench.run                       # new run, id eval_<UTC date_time>
    python -m bench.run --run eval_X          # resume: skips requests already finished
    python -m bench.run --run eval_X --retry-failed
    python -m bench.run --note "LLM_PROVIDER=ollama"   # label a run (the provider itself is read from the stream)
    python -m bench.run --run eval_X --record # write precision@10 etc. to agent_versions

Needs the whole stack (docker compose up -d --build) and npm run gen:properties.
Results go to bench/results/<run>.json and .csv (git-ignored). The JSON is written after
every request, so a crash or a closed laptop loses at most the request in progress.
Requests run one at a time so latencies are not inflated by each other."""
import argparse
import asyncio
import csv
import json
import os
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import websockets

from app.pool import load_pool

from . import metrics

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
TASK_LIMIT_S = 150  # above the service's own TASK_DEADLINE_S (120 s)
KEEP = ("config_version", "recommended", "ranked", "parsed_request", "disagreement_score", "decision", "limitations",
        "availability", "eligible_count", "timings_ms", "confidence", "opinions", "dissent", "rejected_alternative", "risks")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def save_json(path: Path, data: dict):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, default=str))
    os.replace(tmp, path)  # never a half-written results file


class Client:
    def __init__(self, gateway: str):
        self.gateway = gateway.rstrip("/")
        self.http = httpx.AsyncClient(base_url=f"{self.gateway}/api/v1", timeout=15)
        self.token = None

    async def call(self, method, path, body=None):
        """(status, data, error), waiting out the gateway's per-user rate limit."""
        for _ in range(10):
            headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
            r = await self.http.request(method, path, json=body, headers=headers)
            try:
                j = r.json()
            except ValueError:
                j = {}
            if r.status_code == 429 and j.get("error", {}).get("message") == "Too many requests.":
                await asyncio.sleep(15)  # gateway: 100 requests a minute
                continue
            return r.status_code, j.get("data"), j.get("error")
        raise RuntimeError(f"{method} {path}: still rate limited")

    async def sign_up(self, run_id: str):
        """A fresh guest per session. The password lives only in memory."""
        email = f"bench-{run_id.lower().replace('_', '-')}-{secrets.token_hex(3)}@example.com"
        password = f"Bench-{secrets.token_urlsafe(12)}"
        status, _, err = await self.call("POST", "/user/guests/create", {"first_name": "Bench", "last_name": "Runner", "email": email, "password": password})
        if status not in (200, 201):
            raise RuntimeError(f"sign-up failed ({status}): {err}")
        status, data, err = await self.call("POST", "/user/auth/login", {"email": email, "password": password, "role": "guest"})
        if not data or not data.get("token"):
            raise RuntimeError(f"login failed ({status}): {err}")
        self.token = data["token"]

    async def stream(self, task_id: str) -> tuple[list[dict], int | None]:
        url = f"{self.gateway.replace('http', 'ws', 1)}/api/v1/ai/ai/tasks/{task_id}/stream?token={self.token}&after=0"
        frames, code = [], None
        try:
            async with asyncio.timeout(TASK_LIMIT_S):
                async with websockets.connect(url, open_timeout=10) as ws:
                    async for raw in ws:
                        frames.append(json.loads(raw))
                    code = ws.close_code
        except websockets.ConnectionClosed as exc:
            code = exc.code
        except TimeoutError:
            code = "client_timeout"
        return frames, code

    async def close(self):
        await self.http.aclose()


async def run_one(client: Client, r: dict, version: str | None) -> dict:
    body = metrics.request_body(r, version)
    entry = {"id": r["id"], "category": r["category"], "request": body, "started_at": now_iso()}
    t0 = time.perf_counter()
    for _ in range(40):  # 429 RATE_LIMITED from the AI service: too many open tasks
        status, data, err = await client.call("POST", "/ai/ai/requests", body)
        if status != 429:
            break
        await asyncio.sleep(3)
    if status != 202:
        return {**entry, "status": "NOT_CREATED", "error": f"{status} {err}"}
    entry.update(task_id=data["task_id"], trace_id=data["trace_id"])

    frames, code = await client.stream(data["task_id"])
    entry["wall_ms"] = round((time.perf_counter() - t0) * 1000)
    entry["close_code"] = code
    parsed = next((f for f in frames if f["type"] == "parser.completed"), {})
    entry.update(provider=parsed.get("provider"), fallback=parsed.get("fallback"), llm_fields=parsed.get("llm_fields") or [],
                 timeouts=[{"agent": f["agent"], "round": f["round"]} for f in frames if f["type"] == "agent.timeout"],
                 rejected=sum(f["type"] == "harness.rejected" for f in frames), frames=len(frames))
    verdict = next((f for f in frames if f["type"] == "verdict"), None)
    error = next((f for f in frames if f["type"] == "error"), None)
    if not verdict and code == 1000:  # stream ended cleanly, but missed the verdict: ask for it
        status, data, _ = await client.call("GET", f"/ai/ai/results/{entry['task_id']}")
        verdict = {"payload": data} if status == 200 else None
    _, task, _ = await client.call("GET", f"/ai/ai/tasks/{entry['task_id']}")
    entry["status"] = (task or {}).get("status", "UNKNOWN")
    if verdict:
        result = verdict.get("payload") or verdict
        entry["result"] = {k: result.get(k) for k in KEEP}
    if error:
        entry["error"] = f"{error.get('code')}: {error.get('message')}"
    return entry


def write_csv(path: Path, entries: list[dict], requests: dict):
    cols = ["id", "category", "request", "task_id", "trace_id", "config_version", "provider", "fallback", "llm_fields", "status",
            "error", "timeouts", "total_ms", "parse_ms", "round0_ms", "debate_ms", "decide_ms", "wall_ms", "disagreement_score",
            "decision_mode", "availability", "recommended", "top3", "ranked10", "parsed_filter_count", "expected_filter_count",
            "parser_ok", "parser_diff", "precision_at_10", "recall_at_10", "first_relevant_rank", "baseline_top3",
            "baseline_precision_at_10", "baseline_recall_at_10", "limitations"]
    with path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, cols)
        w.writeheader()
        for e in entries:
            res, m, t = e.get("result") or {}, e.get("metrics", {}), (e.get("result") or {}).get("timings_ms") or {}
            w.writerow({
                "id": e["id"], "category": e["category"], "request": metrics.describe(requests[e["id"]]),
                "task_id": e.get("task_id"), "trace_id": e.get("trace_id"), "config_version": res.get("config_version"),
                "provider": e.get("provider"), "fallback": e.get("fallback"), "llm_fields": " ".join(e.get("llm_fields", [])),
                "status": e.get("status"), "error": e.get("error"),
                "timeouts": " ".join(f"{x['agent']}@{x['round']}" for x in e.get("timeouts", [])),
                **{f"{k}_ms": t.get(k) for k in ("total", "parse", "round0", "debate", "decide")}, "wall_ms": e.get("wall_ms"),
                "disagreement_score": res.get("disagreement_score"), "decision_mode": (res.get("decision") or {}).get("mode"),
                "availability": res.get("availability"), "recommended": (res.get("recommended") or {}).get("property_id"),
                "top3": " ".join((res.get("ranked") or [])[:3]), "ranked10": " ".join(res.get("ranked") or []),
                "parsed_filter_count": m.get("parsed_filter_count"), "expected_filter_count": m.get("relevant_count"),
                "parser_ok": (not m["parser_diff"]) if "parser_diff" in m else None, "parser_diff": "; ".join(m.get("parser_diff", [])),
                "precision_at_10": m.get("precision_at_10"), "recall_at_10": m.get("recall_at_10"),
                "first_relevant_rank": m.get("first_relevant_rank"), "baseline_top3": " ".join(m.get("baseline_top10", [])[:3]),
                "baseline_precision_at_10": m.get("baseline_precision_at_10"), "baseline_recall_at_10": m.get("baseline_recall_at_10"),
                "limitations": " | ".join(res.get("limitations") or []),
            })


def print_summary(s: dict):
    a, b, lat = s["agents"], s["baseline"], s["latency_ms"]
    print(f"\n{s['completed']}/{s['requests']} completed  statuses {s['statuses']}  agent timeouts {s['agent_timeouts']}")
    print(f"parser: {s['providers']}  fallbacks {s['llm_fallbacks']}  exact {s['parser']['exact']}  wrong fields {s['parser']['wrong_fields']}")
    print(f"latency ms p50/p95: total {lat['total']['p50']}/{lat['total']['p95']}  parse {lat['parse']['p50']}/{lat['parse']['p95']}  "
          f"round0 {lat['round0']['p50']}/{lat['round0']['p95']}  debate {lat['debate']['p50']}/{lat['debate']['p95']}")
    print(f"disagreement mean {s['disagreement']['mean']}  decisions {s['decision_modes']}")
    print(f"over {s['scored_requests']} requests with a relevant stay:")
    print(f"  agents    precision@10 {a['precision_at_10']}  recall@10 {a['recall_at_10']}  precision@3 {a['precision_at_3']}  mean rank {a['mean_rank']}  top pick relevant {a['top_pick_relevant']}")
    print(f"  baseline  precision@10 {b['precision_at_10']}  recall@10 {b['recall_at_10']}  precision@3 {b['precision_at_3']}  mean rank {b['mean_rank']}")
    print(f"filter count: expected {s['filter_count']['expected_mean']}  parsed {s['filter_count']['parsed_mean']} (mean matching stays)")
    print(f"no-match requests: {s['no_match']['said_so']}/{s['no_match']['requests']} said no stay meets everything")


def record(data: dict, mongo_url: str, mongo_db: str):
    """Put the automatic metrics on the config version that ran (API doc §11, agent_versions).
    Only a complete run counts: a partial one would make the version look better or worse than it is."""
    from pymongo import MongoClient

    entries = list(data["entries"].values())
    versions = {e["result"]["config_version"] for e in entries if e.get("result")}
    unfinished = [e["id"] for e in entries if not e.get("result")]
    if len(entries) < data["requests"] or unfinished:
        sys.exit(f"Not recording: {data['requests'] - len(entries)} not run, {len(unfinished)} without a result {unfinished[:10]}. "
                 "Finish the run (--retry-failed) first.")
    if len(versions) != 1:
        sys.exit(f"Not recording: the run used several config versions {sorted(versions)}")
    s = data["summary"]
    fields = {"eval_run_id": data["run_id"], "evaluated_at": now_iso(), "precision_at_10": s["agents"]["precision_at_10"],
              "recall_at_10": s["agents"]["recall_at_10"], "mean_rank": s["agents"]["mean_rank"],
              "eval": {"benchmark": data["benchmark"], "pool_ref": data["pool_ref"], "requests": data["requests"],
                       "scored_requests": s["scored_requests"], "parser_exact": s["parser"]["exact"], "baseline": s["baseline"],
                       "latency_ms": s["latency_ms"], "providers": s["providers"]}}
    version = versions.pop()
    with MongoClient(mongo_url, serverSelectionTimeoutMS=5000) as mc:
        done = mc[mongo_db].agent_versions.update_one({"version_id": version}, {"$set": fields})
    if not done.matched_count:
        sys.exit(f"No agent_versions record for {version}")
    print(f"Recorded {data['run_id']} on {version}: precision@10 {fields['precision_at_10']}, recall@10 {fields['recall_at_10']}, "
          f"mean rank {fields['mean_rank']}")


async def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gateway", default=os.getenv("GATEWAY_URL", "http://localhost:8080"))
    ap.add_argument("--run", help="run id; an existing one is resumed")
    ap.add_argument("--only", help="comma-separated request ids, e.g. R01,R19")
    ap.add_argument("--retry-failed", action="store_true", help="run again the requests that ended without a result")
    ap.add_argument("--version", help="config_version to ask for (default: the promoted one)")
    ap.add_argument("--note", default="", help="free text stored with the run, e.g. which LLM_PROVIDER the stack had")
    ap.add_argument("--record", action="store_true", help="write the metrics to agent_versions in MongoDB, then stop")
    ap.add_argument("--mongo", default=os.getenv("BENCH_MONGO_URL", "mongodb://localhost:27018"))
    ap.add_argument("--mongo-db", default=os.getenv("MONGO_DB", "airbnb"))
    args = ap.parse_args(argv)

    pool = load_pool()
    requests = metrics.load_requests(HERE / "requests.json", pool)
    by_id = {r["id"]: r for r in requests}
    run_id = args.run or f"eval_{datetime.now(timezone.utc):%Y%m%d_%H%M}"
    RESULTS.mkdir(exist_ok=True)
    path = RESULTS / f"{run_id}.json"
    data = json.loads(path.read_text()) if path.exists() else {
        "run_id": run_id, "benchmark": "slice5-ai-50", "pool_ref": pool.ref, "requests": len(requests),
        "created_at": now_iso(), "gateway": args.gateway, "note": args.note, "entries": {}}
    if args.note and args.note != data.get("note"):
        data["note"] = " / ".join(filter(None, [data.get("note"), args.note]))

    if args.record:
        if not data["entries"]:
            sys.exit(f"No results for {run_id}")
        return record(data, args.mongo, args.mongo_db)

    wanted = [by_id[i.strip()] for i in args.only.split(",")] if args.only else requests
    todo = [r for r in wanted if r["id"] not in data["entries"]
            or (args.retry_failed and not data["entries"][r["id"]].get("result"))]
    print(f"Run {run_id}: {len(todo)} to do, {len(data['entries'])} already stored -> {path}")
    client = Client(args.gateway)
    try:
        if todo:
            await client.sign_up(run_id)
        for n, r in enumerate(todo, 1):
            try:
                entry = await run_one(client, r, args.version)
            except (httpx.HTTPError, OSError, websockets.WebSocketException) as exc:
                entry = {"id": r["id"], "category": r["category"], "status": "CLIENT_ERROR", "error": f"{type(exc).__name__}: {exc}"}
            entry["metrics"] = metrics.score(entry, r, pool)
            data["entries"][r["id"]] = entry
            save_json(path, data)
            m = entry["metrics"]
            print(f"[{n}/{len(todo)}] {r['id']} {entry['status']:<17} {((entry.get('result') or {}).get('timings_ms') or {}).get('total')} ms  "
                  f"p@10 {m.get('precision_at_10')}  parser {'ok' if not m.get('parser_diff') else m.get('parser_diff')}"
                  + (f"  error {entry['error']}" if entry.get("error") else ""))
    finally:
        await client.close()

    entries = [data["entries"][r["id"]] for r in requests if r["id"] in data["entries"]]
    for e in entries:  # rescore stored entries, so a fixed answer key applies to old runs too
        e["metrics"] = metrics.score(e, by_id[e["id"]], pool)
    data["summary"] = metrics.summarize(entries)
    data["updated_at"] = now_iso()
    save_json(path, data)
    write_csv(path.with_suffix(".csv"), entries, by_id)
    print_summary(data["summary"])
    print(f"\nSaved {path} and {path.with_suffix('.csv')}")
    if len(entries) < len(requests):
        print(f"{len(requests) - len(entries)} requests not run yet: python -m bench.run --run {run_id}")


if __name__ == "__main__":
    asyncio.run(main())
