# Load tests (Deliverable D)

JMeter plans and results for the performance report. Owner: Slice 4.

Required experiments (spec §9): property search under increasing concurrency,
booking end-to-end time, AI debate timings, one vs many Kafka consumers,
search with and without indexes, and failure recovery.

Put each plan here as `<experiment>.jmx`; results go in `results/` (git-ignored).
Record the machine, dataset size, concurrency and duration for every run.

## Setup

```bash
docker compose -f docker-compose.yml -f tests/load/docker-compose.loadtest.yml up -d --build
```
```bash
npm run gen:properties -- --count 10000 --mongo
```

The override raises the gateway's 100 requests/minute limit for test runs only.
Never use `docker compose down` before a demo: it recreates Kafka and loses its data.

## Experiments

| Experiment | Command | Output |
| --- | --- | --- |
| 1. Search, 1 to 100 users | `bash tests/load/run-search.sh` | `results/search-summary.csv` |
| 5. Search without the indexes | `bash tests/load/run-indexing.sh` (restores the indexes afterwards) | `results/search-noindex-summary.csv` |
| Search with the Redis cache | `NAME=search-cache CACHE_MODE=default bash tests/load/run-search.sh` | `results/search-cache-summary.csv` |

`run-search.sh` takes `LEVELS`, `DURATION`, `RAMPUP`, `HOST`, `PORT`, `STRATEGY`
(`mysql` or `mongo`) and `CACHE_MODE` (`bypass` or `default`). Every run writes
`<name>-run-info.txt` with the machine, versions and dataset, and one summary row
per level: throughput, average, p50, p95, p99 and error rate
(`node tests/load/summarize.js <file.jtl>`).

Run JMeter in command-line mode (`-n`) for measurements; the GUI slows it down.
JMeter runs on the same machine as the stack, so state that in the report.
