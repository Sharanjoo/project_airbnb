#!/usr/bin/env bash
# Experiment 2 (spec §9): booking request end to end
# (API -> Kafka booking.requested -> booking worker -> MySQL) at fixed request rates.
# Also used by experiment 4: run once with one booking worker and once with several.
#
#   bash tests/load/run-booking.sh                         # 10, 50 and 200 bookings/s, 60 s each
#   RATES="50" NAME=booking-1worker bash tests/load/run-booking.sh
# Creates load-test guests first and deletes every row they created at the end.
# Local/dev databases only.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

NAME="${NAME:-booking}"
RATES="${RATES:-10 50 200}"          # bookings per second
DURATION="${DURATION:-60}"
THREADS="${THREADS:-50}"
HOST="${HOST:-localhost}"
PORT="${PORT:-8080}"
OUT="tests/load/results"
SUMMARY="$OUT/$NAME-summary.csv"

trap 'node tests/load/booking-setup.js --cleanup' EXIT
node tests/load/booking-setup.js --guests 100
rm -f "$SUMMARY"

{
  echo "run: $NAME at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "target: http://$HOST:$PORT (gateway), $THREADS threads, rates $RATES bookings/s, ${DURATION}s each"
  echo "booking workers: $(docker compose ps -q booking-worker 2>/dev/null | wc -l | tr -d ' ')"
  echo "machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), $(sysctl -n hw.ncpu 2>/dev/null) cores, $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) GB RAM"
  echo "dataset: $(docker compose exec -T mysql mysql -uairbnb -pairbnb airbnb -N -e "SELECT CONCAT(COUNT(*), ' active properties') FROM properties WHERE status='active'" 2>/dev/null)"
} | tee "$OUT/$NAME-run-info.txt"

jm() { jmeter -n -t tests/load/booking.jmx -Jhost="$HOST" -Jport="$PORT" -Jsample_variables=idem -j "$OUT/jmeter.log" "$@"; }

# warm-up: opens connections (the gateway's first request after idle can fail while Redis reconnects)
jm -Jthreads=5 -Jduration=5 -Jrampup=1 -Jrate=300 -l "$OUT/$NAME-warmup.jtl" > /dev/null 2>&1 || true
sleep 3

for r in $RATES; do
  jtl="$OUT/$NAME-$r.jtl"
  rm -f "$jtl"
  jm -Jthreads="$THREADS" -Jduration="$DURATION" -Jrampup=5 -Jrate=$((r * 60)) -l "$jtl" > "$OUT/$NAME-$r.log" 2>&1
  node tests/load/booking-e2e.js "$jtl" --label "$NAME-${r}per_s" --csv "$SUMMARY"
  sleep 5
done

echo "summary: $SUMMARY"
