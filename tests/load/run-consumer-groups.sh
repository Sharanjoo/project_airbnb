#!/usr/bin/env bash
# Experiment 4, second part (spec §9): one consumer group versus several.
# booking.requested is read by three groups: booking-worker-cg (writes the reservation),
# messaging-cg (opens the guest-host thread) and analytics-cg (stores the event). Each group
# keeps its own offsets, so each should get every event, and one group should not slow
# another down.
#
#   A. only booking-worker-cg reads a backlog of bookings
#   B. booking-worker-cg, messaging-cg and analytics-cg read the same size backlog at once
#
#   bash tests/load/run-consumer-groups.sh            # about 7,500 bookings per run
#   SEND_S=30 bash tests/load/run-consumer-groups.sh
# The notification gateway (notify-cg) also reads booking.requested and keeps running
# throughout. Always restarts every worker and deletes the test data at the end.
# Local/dev only.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

SEND_S="${SEND_S:-15}"
RATE="${RATE:-500}"
OUT="tests/load/results"
SUMMARY="$OUT/consumer-groups-summary.csv"
WORKERS="booking-worker messaging-worker analytics-worker"

finish() {
  docker compose start $WORKERS > /dev/null 2>&1 || true
  node tests/load/booking-setup.js --cleanup || true
}
trap finish EXIT
rm -f "$SUMMARY"

now_ms() { node -e 'console.log(Date.now())'; }
queue_backlog() { # $1 = label; all three workers stopped; prints how many bookings were accepted
  node tests/load/booking-setup.js --guests 100 > /dev/null
  docker compose stop $WORKERS > /dev/null 2>&1
  jmeter -n -t tests/load/booking.jmx -Jthreads=50 -Jduration="$SEND_S" -Jrampup=2 -Jrate=$((RATE * 60)) \
    -Jsample_variables=idem -j "$OUT/jmeter.log" -l "$OUT/groups-$1.jtl" > /dev/null 2>&1
  awk -F, 'NR>1 && $4=="202"' "$OUT/groups-$1.jtl" | wc -l | tr -d ' '
}
lag() { # $1 = group
  docker compose exec -T kafka sh -c "/opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group $1" 2>/dev/null \
    | awk '$2=="booking.requested" && $6 ~ /^[0-9]+$/ {s += $6} END {print s + 0}'
}

{
  echo "run: consumer-groups at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "backlog: ${SEND_S}s of bookings at up to ${RATE}/s per run; one worker per group; trace steps on"
  echo "machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), $(sysctl -n hw.ncpu 2>/dev/null) cores"
} | tee "$OUT/consumer-groups-run-info.txt"

# ---------------------------------------------------------------- A. one group
accepted=$(queue_backlog one)
echo "A. $accepted bookings waiting; starting booking-worker only" | tee -a "$OUT/consumer-groups-run-info.txt"
docker compose start booking-worker > /dev/null 2>&1
node tests/load/groups-measure.js --expected "$accepted" --label groups-1 --groups booking --since-ms "$(now_ms)" --csv "$SUMMARY" | tee -a "$OUT/consumer-groups-run-info.txt"
# let the other groups catch up on run A's events before the next backlog, so they do not mix
docker compose start messaging-worker analytics-worker > /dev/null 2>&1
for g in messaging-cg analytics-cg; do until [ "$(lag $g)" = "0" ]; do sleep 2; done; done

# ---------------------------------------------------------------- B. three groups
accepted=$(queue_backlog three)
echo "B. $accepted bookings waiting; starting booking-worker, messaging-worker and analytics-worker together" | tee -a "$OUT/consumer-groups-run-info.txt"
since=$(now_ms)
docker compose start $WORKERS > /dev/null 2>&1
node tests/load/groups-measure.js --expected "$accepted" --label groups-3 --groups booking,messaging,analytics --since-ms "$since" --csv "$SUMMARY" | tee -a "$OUT/consumer-groups-run-info.txt"
for g in booking-worker-cg messaging-cg analytics-cg notify-cg; do echo "   lag after run B, $g: $(lag $g)"; done | tee -a "$OUT/consumer-groups-run-info.txt"
echo "summary: $SUMMARY"
