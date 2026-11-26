#!/usr/bin/env bash
# Experiment 6 (spec §9): failure recovery under load. Adds two measurements to
# Slice 3's single-booking demo (npm run demo:recovery):
#   A. crash: queue a backlog, start the booking worker, kill it (SIGKILL, like a power
#      cut) half-way, restart it, then check the final state is exactly consistent and
#      how long recovery took. Redelivered events must be skipped, not applied twice.
#   B. outage: stop MySQL for a few seconds while the worker drains a backlog, and
#      measure the retries, how many bookings went to the dead-letter topic and how
#      long the system took to finish once MySQL was back.
#
#   bash tests/load/run-recovery.sh
# Always restarts MySQL and one booking worker and deletes the test data at the end.
# Local/dev only.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

OUT="tests/load/results"
SUMMARY="$OUT/recovery-summary.csv"
SEND_S="${SEND_S:-20}"
OUTAGE_S="${OUTAGE_S:-8}"
rm -f "$SUMMARY"

finish() {
  docker compose start mysql > /dev/null 2>&1 || true
  for _ in $(seq 1 30); do docker compose exec -T mysql mysqladmin ping -uairbnb -pairbnb > /dev/null 2>&1 && break; sleep 1; done
  docker compose up -d --no-recreate --scale booking-worker=1 booking-worker > /dev/null 2>&1 || true
  docker compose start booking-worker > /dev/null 2>&1 || true
  node tests/load/booking-setup.js --cleanup || true
}
trap finish EXIT

rows() { docker compose exec -T mysql mysql -uairbnb -pairbnb airbnb -N -e "SELECT COUNT(*) FROM reservations WHERE guest_id LIKE 'gst\\_lt\\_%'" 2>/dev/null | tr -d '\r'; }
dlq_size() {
  docker compose exec -T kafka /opt/kafka/bin/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic booking.requested.dlq 2>/dev/null \
    | awk -F: '{s += $3} END {print s + 0}'
}
now_ms() { node -e 'console.log(Date.now())'; }
queue_backlog() { # $1 = label; leaves the worker stopped and prints how many bookings were accepted
  node tests/load/booking-setup.js --guests 100 > /dev/null
  docker compose stop booking-worker > /dev/null 2>&1
  jmeter -n -t tests/load/booking.jmx -Jthreads=50 -Jduration="$SEND_S" -Jrampup=2 -Jrate=30000 \
    -Jsample_variables=idem -j "$OUT/jmeter.log" -l "$OUT/recovery-$1.jtl" > /dev/null 2>&1
  awk -F, 'NR>1 && $4=="202"' "$OUT/recovery-$1.jtl" | wc -l | tr -d ' '
}

echo "run: recovery at $(date -u +%Y-%m-%dT%H:%M:%SZ), machine $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)" | tee "$OUT/recovery-run-info.txt"

# ---------------------------------------------------------------- A. crash mid-backlog
accepted=$(queue_backlog crash)
dlq_before=$(dlq_size)
echo "A. crash: $accepted bookings waiting in Kafka; starting the worker" | tee -a "$OUT/recovery-run-info.txt"
docker compose start booking-worker > /dev/null 2>&1
target=$((accepted / 3))
until [ "$(rows)" -ge "$target" ]; do sleep 0.5; done
docker compose kill -s SIGKILL booking-worker > /dev/null 2>&1
at_crash=$(rows)
echo "   killed the worker with SIGKILL after $at_crash rows" | tee -a "$OUT/recovery-run-info.txt"
sleep 3
restart_ms=$(now_ms)
restart_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose start booking-worker > /dev/null 2>&1
node tests/load/recovery-check.js --expected "$accepted" --label crash --since-ms "$restart_ms" --csv "$SUMMARY" | tee -a "$OUT/recovery-run-info.txt"
dups=$(docker compose logs --since "$restart_iso" booking-worker 2>&1 | grep -c '"outcome":"duplicate"' || true)
echo "   redelivered after the restart and skipped as duplicates: $dups | dead-letter messages added: $(( $(dlq_size) - dlq_before ))" | tee -a "$OUT/recovery-run-info.txt"

# ---------------------------------------------------------------- B. MySQL outage while draining
accepted=$(queue_backlog outage)
dlq_before=$(dlq_size)
outage_start_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "B. outage: $accepted bookings waiting; starting the worker, stopping MySQL for ${OUTAGE_S}s" | tee -a "$OUT/recovery-run-info.txt"
docker compose start booking-worker > /dev/null 2>&1
target=$((accepted / 3))
until [ "$(rows)" -ge "$target" ]; do sleep 0.5; done
docker compose stop mysql > /dev/null 2>&1
echo "   MySQL stopped after $target+ rows" | tee -a "$OUT/recovery-run-info.txt"
sleep "$OUTAGE_S"
docker compose start mysql > /dev/null 2>&1
until docker compose exec -T mysql mysqladmin ping -uairbnb -pairbnb > /dev/null 2>&1; do sleep 0.5; done
back_ms=$(now_ms)
echo "   MySQL back" | tee -a "$OUT/recovery-run-info.txt"
added=$(( $(dlq_size) - dlq_before ))
node tests/load/recovery-check.js --expected "$((accepted - added))" --label outage --since-ms "$back_ms" --csv "$SUMMARY" --timeout 300 | tee -a "$OUT/recovery-run-info.txt"
retries=$(docker compose logs --since "$outage_start_iso" booking-worker 2>&1 | grep -c '"event failed, retrying"' || true)
gaveup=$(docker compose logs --since "$outage_start_iso" booking-worker 2>&1 | grep -c '"event failed, sent to DLQ"' || true)
delays=$(docker compose logs --since "$outage_start_iso" booking-worker 2>&1 | grep '"event failed, retrying"' | grep -o '"delay_ms":[0-9]*' | cut -d: -f2 | sort -n | tr '\n' ' ' | cut -c1-200)
echo "   retries logged: $retries | gave up and sent to the dead-letter topic: $gaveup (DLQ grew by $added) | retry delays (ms): $delays" | tee -a "$OUT/recovery-run-info.txt"
echo "summary: $SUMMARY"
