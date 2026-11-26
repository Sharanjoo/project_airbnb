# Load tests (Deliverable D)

JMeter plans and results for the performance report. Owner: Slice 4.

Required experiments (spec §9): property search under increasing concurrency,
booking end-to-end time, AI debate timings, one vs many Kafka consumers,
search with and without indexes, and failure recovery.

Put each plan here as `<experiment>.jmx`; results go in `results/`. Each experiment's
`*-summary.csv` and `*-run-info.txt` are committed (the numbers behind
`docs/performance-report.md`); raw `.jtl` files and logs stay local.
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

**Windows:** run the `.sh` scripts from Git Bash (not PowerShell or cmd), with Java
and JMeter's `bin` folder on `PATH`, and first run `export MSYS_NO_PATHCONV=1`, or
Git Bash rewrites the `/opt/kafka/...` paths in the `docker compose exec` steps into
Windows paths. The repo's `.gitattributes` keeps the scripts' Unix line endings. The
machine line in `*-run-info.txt` then shows only the CPU type, so add the CPU, cores
and RAM to the report by hand. (Written for Git Bash; the runs here were on macOS.)

## Experiments

| Experiment | Command | Output |
| --- | --- | --- |
| 1. Search, 1 to 100 users | `bash tests/load/run-search.sh` | `results/search-summary.csv` |
| 5. Search without the indexes | `bash tests/load/run-indexing.sh` (restores the indexes afterwards) | `results/search-noindex-summary.csv` |
| Search with the Redis cache | `NAME=search-cache CACHE_MODE=default bash tests/load/run-search.sh` | `results/search-cache-summary.csv` |
| 2. Booking end to end, 10 / 50 / 200 per second | `bash tests/load/run-booking.sh` | `results/booking-summary.csv` |
| 4. Kafka scaling, 1 vs 3 booking workers | `bash tests/load/run-kafka-scaling.sh` | `results/kafka-scaling-summary.csv` |
| 4. One consumer group vs three | `bash tests/load/run-consumer-groups.sh` | `results/consumer-groups-summary.csv` |
| 6. Failure recovery (worker killed, MySQL stopped) | `bash tests/load/run-recovery.sh` | `results/recovery-summary.csv` |
| 3. AI debate timings | `node tests/load/booking-setup.js --guests 100`, then `node tests/load/ai-timings.js --tasks 30 --concurrency 3 --label det-c3` | `results/ai-summary.csv` |
| Charts for the report | `node tests/load/make-charts.js` | `docs/performance/*.svg` |

The booking, scaling, groups and recovery runs create load-test guests (`gst_lt_…`)
and delete everything they made at the end (`node tests/load/booking-setup.js
--cleanup` does it by hand). They stop and start workers but never recreate Kafka.
Load the settings first for the Node scripts: `set -a; . ./.env; set +a`.
`TRACE_STEPS=off` on the workers turns off their trace steps for a run.

`run-search.sh` takes `LEVELS`, `DURATION`, `RAMPUP`, `HOST`, `PORT`, `STRATEGY`
(`mysql` or `mongo`) and `CACHE_MODE` (`bypass` or `default`). Every run writes
`<name>-run-info.txt` with the machine, versions and dataset, and one summary row
per level: throughput, average, p50, p95, p99 and error rate
(`node tests/load/summarize.js <file.jtl>`).

Run JMeter in command-line mode (`-n`) for measurements; the GUI slows it down.
JMeter runs on the same machine as the stack, so state that in the report.
