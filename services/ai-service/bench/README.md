# Slice 5 benchmark: 50 requests and two human labellers

This folder holds the fixed AI benchmark from TEAM.md: 50 requests against the 200-property pool
(`active-pool-v1`), a filter-count baseline, and a labelling workflow for two people.

| File | What it is |
|---|---|
| `requests.json` | The 50 requests. Each has `expected`, the hard constraints a careful reader takes from it (written by hand). |
| `run.py` | Sends every request through the gateway, the same way the client does, and records the result |
| `metrics.py` | Scoring: parser accuracy, precision@10, recall@10, mean rank, baseline, percent agreement, Cohen's kappa |
| `labels.py` | Makes a blank labelling sheet for one person |
| `agree.py` | Compares the two filled sheets |
| `results/` | Run output, JSON and CSV (git-ignored) |
| `labels/<run>/` | The two filled sheets and the agreement report (committed: they are real people's work) |

## 1. Run the benchmark

Needs the whole stack running and the pool loaded in MySQL:

```bash
docker compose up -d --build
npm run gen:properties
```

From `services/ai-service`, with the Python packages from `requirements.txt` installed:

```bash
python -m bench.run --run eval_det_1 --note "LLM_PROVIDER=none"
```

Or without Python on your machine, inside the AI image:

```bash
docker compose run --rm --no-deps -v "$PWD/services/ai-service/bench:/app/ai-service/bench" ai-service \
  python -m bench.run --run eval_det_1 --gateway http://gateway:8080 --mongo mongodb://mongo:27017
```

The runner signs up one fresh guest and sends the requests one at a time. For each one it follows the
WebSocket stream to the end. It saves `results/<run>.json` after every request, so running the same
command again resumes where it stopped. Add `--retry-failed` to retry the ones that ended without a
result. At the end it prints a summary and writes `results/<run>.csv`, one row per request.

| Columns | Meaning |
|---|---|
| `task_id`, `trace_id`, `config_version`, `provider`, `fallback`, `llm_fields` | Which run, which version and which parser handled it |
| `status`, `error`, `timeouts` | How the task ended |
| `total_ms`, `parse_ms`, `round0_ms`, `debate_ms`, `decide_ms`, `wall_ms` | Latency, from the Chair's timings plus wall clock at the client |
| `disagreement_score`, `decision_mode`, `availability`, `recommended`, `top3`, `ranked10` | The debate's outcome |
| `parsed_filter_count` | The filter-count baseline: how many stays a plain filter search with the parsed requirements returns |
| `expected_filter_count` | The same count using the answer key |
| `parser_ok`, `parser_diff` | Whether the parser read the request like the answer key, and where it differed |
| `precision_at_10`, `recall_at_10`, `first_relevant_rank` | The agents' ranking against the answer key |
| `baseline_*` | The same scores for the plain filter search (sorted by rating, review count, then price) |

### Comparing with the LLM parser

Run the same 50 requests with Ollama on, under a new run id:

```bash
ollama run llama3.2:3b "hi" --keepalive 30m     # warm the model first
LLM_PROVIDER=ollama docker compose up -d --no-deps ai-parser
python -m bench.run --run eval_llm_1 --note "LLM_PROVIDER=ollama llama3.2:3b"
```

Compare the two summaries, especially parser accuracy and parse latency. Then switch back with
`docker compose up -d --no-deps ai-parser`.

### How the automatic numbers are defined

- **Relevant**: a stay in the pool that meets every hard constraint in `expected` (city or one of the
  listed cities, sleeps at least that many, price at or under the limit, every amenity, minimum
  rating). Dates are not part of it, because the pool has no calendar. The Chair checks dates with
  the property service.
- **precision@10**: the relevant share of the top 10. When fewer than 10 stays are relevant, the
  most it can reach is relevant / 10.
- **recall@10**: the share of all relevant stays that made the top 10.
- **mean rank**: the average rank of the first relevant stay, counting 11 when none is in the top 10.
- **No-match requests**: precision and recall leave out the five `no_match` requests, because the
  pool has nothing relevant for them. The check there is whether the result says "No property meets
  every stated requirement".

To put the numbers on the config version that ran (`agent_versions`, which the platform dashboard
and `POST /ai/versions/{id}/promote` read), run this once the run is complete:

```bash
python -m bench.run --run eval_det_1 --record
```

## 2. Labelling: instructions for the two labellers

Each labeller makes their own sheet. The name must be the real person who will fill it in:

```bash
python -m bench.labels --run eval_det_1 --labeller "First Last"
```

This writes `labels/eval_det_1/first-last.csv` with 3 rows per request (the top 3 recommendations),
so up to 150 rows. Open it in Excel, Numbers or Google Sheets. Each row shows the request and the
stay's facts: city, type, sleeps, price, rating, reviews and amenities. It does not show agent scores,
votes or how the parser read the request.

**Work alone.** Don't look at the other person's sheet or talk about rows until you are both
finished. Agreement only means something if the labels are independent. Fill in four columns per row:

| Column | Values | Meaning |
|---|---|---|
| `relevance` | 0, 1, 2 | Does this stay match what the person asked for? 0 = no, 1 = partly (misses something minor), 2 = yes |
| `suitability` | 0, 1, 2 | Would you be happy to book it for them? 0 = no, 1 = acceptable, 2 = a good choice |
| `filters_correct` | yes, no | Does it meet every hard requirement stated in the request (city, guests, budget, amenities, rating)? |
| `fairness_concern` | yes, no | Does it look ranked for a bad reason (only cheap, only popular, a new listing pushed down) or does anything about it seem unfair? |
| `notes` | free text | Optional. Please add a note for every 0 and every "yes" fairness concern. |

Rules of thumb:

- Judge the stay against the request text, not against the other two rows.
- If the request says "under $250", then $250 is fine and $251 breaks the filter.
- For requests nothing can satisfy (for example 10 people with a pool under $100 in Oakland), a near
  miss can still be relevance 1. Mark `filters_correct = no`.
- Soft words such as "quiet", "nice" or "near the beach" can't be checked from the listing facts.
  Don't mark a stay down for them.
- Save the sheet as CSV under the same name. Don't change the first columns or the order of rows.

## 3. Agreement

When both sheets are finished:

```bash
python -m bench.agree --run eval_det_1
```

This prints and saves `labels/<run>/agreement.md` and `agreement.json`:

- **Per field**: percent agreement and Cohen's kappa. For the 0–2 scales it also gives quadratic
  weighted kappa, which counts 1 against 2 as a smaller disagreement than 0 against 2.
- **Reading**: the Landis and Koch description of each kappa (slight, fair, moderate and so on).
- **Per labeller**: mean relevance and mean suitability, the share of rows meeting the filters, and
  the number of fairness concerns.
- **Approval rate**: the share of requests where both people would accept the top pick
  (suitability 1 or 2).

It also writes `disagreements.csv`, every row where the two people differ. Talk those through
together and fill in `agreed_after_discussion`. Don't change the original sheets afterwards; the
kappa is about the independent labels.

`--partial` gives an interim look while labelling is in progress. `--record` stores the approval
rate and the agreement figures on the config version, next to precision@10.

Commit the two sheets, `agreement.md`, `agreement.json` and `disagreements.csv`.
