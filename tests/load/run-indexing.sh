#!/usr/bin/env bash
# Experiment 5 (spec §9): search latency with and without the selected indexes.
# Drops the two search indexes the schema marks for this experiment
# (ix_properties_search, ix_properties_rating), runs the same search load test
# as experiment 1, then puts the indexes back exactly as 001_schema.sql defines
# them. The restore runs even if the test fails or is interrupted.
#
#   bash tests/load/run-indexing.sh            # compare with tests/load/results/search-summary.csv
#   LEVELS="10 50" bash tests/load/run-indexing.sh
# Local/dev databases only: never run this against a shared database.
set -euo pipefail
cd "$(dirname "$0")/../.."

sql() { docker compose exec -T mysql mysql -uairbnb -pairbnb airbnb -N -e "$1" 2>/dev/null; }

restore() {
  if [ "$(sql "SELECT COUNT(DISTINCT index_name) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'properties' AND index_name IN ('ix_properties_search', 'ix_properties_rating')")" != "2" ]; then
    sql "ALTER TABLE properties ADD KEY ix_properties_search (status, city, nightly_price), ADD KEY ix_properties_rating (status, rating)"
    echo "indexes restored"
  fi
}
trap restore EXIT

echo "dropping ix_properties_search and ix_properties_rating"
sql "ALTER TABLE properties DROP INDEX ix_properties_search, DROP INDEX ix_properties_rating"
echo "query plan without the indexes:"
sql "EXPLAIN SELECT property_id FROM properties WHERE status = 'active' AND city = 'San Jose' AND nightly_price <= 200 ORDER BY nightly_price LIMIT 20" | awk '{print "  type=" $5 ", key=" $7 ", rows=" $10}'

NAME="${NAME:-search-noindex}" bash tests/load/run-search.sh
