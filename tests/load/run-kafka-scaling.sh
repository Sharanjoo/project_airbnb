#!/usr/bin/env bash
# Experiment 4 (spec §9): one booking worker versus several in the same consumer group.
#
# Backlog method, so the API/gateway limit does not hide the consumers' speed:
#   1. stop every booking worker
#   2. send bookings through the API (they wait in Kafka: booking.requested has 6 partitions)
#   3. start N workers and time how fast they drain the backlog (MySQL timestamps)
#
#   bash tests/load/run-kafka-scaling.sh              # WORKERS="1 3", about 15,000 bookings each
#   WORKERS="1 2 3 6" SEND_S=20 bash tests/load/run-kafka-scaling.sh
# Restores one booking worker and deletes the test data at the end. Local/dev only.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

WORKERS="${WORKERS:-1 3}"
SEND_S="${SEND_S:-30}"      # seconds of sending
RATE="${RATE:-500}"         # bookings per second requested from JMeter
OUT="tests/load/results"
SUMMARY="$OUT/kafka-scaling-summary.csv"

finish() {
  docker compose up -d --no-recreate --scale booking-worker=1 booking-worker > /dev/null 2>&1 || true
  node tests/load/booking-setup.js --cleanup || true
}
trap finish EXIT
rm -f "$SUMMARY"
{
  echo "run: kafka-scaling at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "topic booking.requested: $(docker compose exec -T kafka sh -c '/opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic booking.requested' 2>/dev/null | grep -o 'PartitionCount: [0-9]*'), consumer group booking-worker-cg"
  echo "backlog: ${SEND_S}s of bookings at up to ${RATE}/s per run; workers tested: $WORKERS"
  echo "machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), $(sysctl -n hw.ncpu 2>/dev/null) cores, $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) GB RAM"
} | tee "$OUT/kafka-scaling-run-info.txt"

for n in $WORKERS; do
  node tests/load/booking-setup.js --guests 100           # also removes the previous run's rows
  docker compose stop booking-worker > /dev/null 2>&1
  jtl="$OUT/kafka-backlog-$n.jtl"
  rm -f "$jtl"
  jmeter -n -t tests/load/booking.jmx -Jthreads=50 -Jduration="$SEND_S" -Jrampup=2 -Jrate=$((RATE * 60)) \
    -Jsample_variables=idem -j "$OUT/jmeter.log" -l "$jtl" > /dev/null 2>&1
  accepted=$(awk -F, 'NR>1 && $4=="202"' "$jtl" | wc -l | tr -d ' ')
  echo "backlog: $accepted bookings accepted and waiting in Kafka; starting $n worker(s)"
  docker compose up -d --no-recreate --scale booking-worker="$n" booking-worker > /dev/null 2>&1
  docker compose start booking-worker > /dev/null 2>&1
  node tests/load/drain-measure.js --expected "$accepted" --label "workers-$n" --workers "$n" --csv "$SUMMARY"
  docker compose exec -T kafka sh -c '/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group booking-worker-cg' 2>/dev/null \
    | awk '$2=="booking.requested"{print "  partition " $3 " -> " $7}' | sort -u | head -6
done
echo "summary: $SUMMARY"
