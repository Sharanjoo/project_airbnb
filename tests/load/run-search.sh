#!/usr/bin/env bash
# Experiment 1 (spec §9): property search under increasing concurrency.
# Runs search.jmx at each concurrency level, summarises every run into
# tests/load/results/<name>-summary.csv, and records the machine and dataset.
#
#   bash tests/load/run-search.sh                       # defaults: mysql, no cache, 1 10 25 50 100 users, 60 s each
#   NAME=search-mongo STRATEGY=mongo bash tests/load/run-search.sh
#   NAME=search-cache CACHE_MODE=default bash tests/load/run-search.sh
#   LEVELS="100" DURATION=120 bash tests/load/run-search.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

NAME="${NAME:-search}"
STRATEGY="${STRATEGY:-mysql}"
CACHE_MODE="${CACHE_MODE:-bypass}"
LEVELS="${LEVELS:-1 10 25 50 100}"
DURATION="${DURATION:-60}"
RAMPUP="${RAMPUP:-5}"
HOST="${HOST:-localhost}"
PORT="${PORT:-8080}"
OUT="tests/load/results"
SUMMARY="$OUT/$NAME-summary.csv"

mkdir -p "$OUT"
node tests/load/gen-search-queries.js
rm -f "$SUMMARY"

{
  echo "run: $NAME at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "target: http://$HOST:$PORT (gateway), strategy=$STRATEGY, cache_mode=$CACHE_MODE"
  echo "levels: $LEVELS users, ${DURATION}s each, ${RAMPUP}s ramp-up"
  echo "machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), $(sysctl -n hw.ncpu 2>/dev/null) cores, $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) GB RAM, $(uname -s) $(uname -r)"
  echo "jmeter: $(jmeter --version 2>/dev/null | grep -o '[0-9]\.[0-9]\.[0-9]*' | head -1), node $(node -v), docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  echo "dataset: $(docker compose exec -T mysql mysql -uairbnb -pairbnb airbnb -N -e "SELECT CONCAT(COUNT(*), ' properties (', SUM(status='active'), ' active)') FROM properties" 2>/dev/null)"
} | tee "$OUT/$NAME-run-info.txt"

for n in $LEVELS; do
  jtl="$OUT/$NAME-$n.jtl"
  rm -f "$jtl"
  jmeter -n -t tests/load/search.jmx -Jthreads="$n" -Jduration="$DURATION" -Jrampup="$RAMPUP" \
    -Jhost="$HOST" -Jport="$PORT" -Jstrategy="$STRATEGY" -Jcache_mode="$CACHE_MODE" -l "$jtl" > "$OUT/$NAME-$n.log" 2>&1
  node tests/load/summarize.js "$jtl" --label "$NAME-$n" --csv "$SUMMARY"
  sleep 5 # let queues drain between levels
done

echo "summary: $SUMMARY"
