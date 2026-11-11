-- §9 "Database indexing" experiment: run the search benchmark WITHOUT the search indexes.
--   docker compose exec -T mysql mysql -uroot -proot airbnb < infra/mysql/experiments/drop-search-indexes.sql
--   node scripts/bench-search.js --strategy mysql --cache off --label no-indexes
-- Then restore them with add-search-indexes.sql and run the benchmark again (--label with-indexes).
ALTER TABLE properties DROP INDEX ix_properties_search, DROP INDEX ix_properties_rating;
