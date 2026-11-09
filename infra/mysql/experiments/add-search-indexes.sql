-- Restores the search indexes from infra/mysql/init/001_schema.sql.
--   docker compose exec -T mysql mysql -uroot -proot airbnb < infra/mysql/experiments/add-search-indexes.sql
ALTER TABLE properties
  ADD INDEX ix_properties_search (status, city, nightly_price),
  ADD INDEX ix_properties_rating (status, rating);
