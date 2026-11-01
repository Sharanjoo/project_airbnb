#!/bin/bash
# Creates every topic in topics.txt plus its .dlq. Safe to re-run.
set -euo pipefail

BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:9092}"
TOPICS_FILE="${TOPICS_FILE:-/topics/topics.txt}"
KT=/opt/kafka/bin/kafka-topics.sh

echo "Waiting for Kafka at $BOOTSTRAP ..."
for i in $(seq 1 60); do
  if $KT --bootstrap-server "$BOOTSTRAP" --list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

while read -r topic partitions; do
  [[ -z "${topic:-}" || "$topic" == \#* ]] && continue
  $KT --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
      --topic "$topic" --partitions "$partitions" --replication-factor 1
  $KT --bootstrap-server "$BOOTSTRAP" --create --if-not-exists \
      --topic "$topic.dlq" --partitions 1 --replication-factor 1
done < "$TOPICS_FILE"

echo "Topics ready:"
$KT --bootstrap-server "$BOOTSTRAP" --list
