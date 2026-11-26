# Slice 2: properties, search, availability and caching

Owner: Sharan. Covers the property endpoints, search, availability, saved
properties, and mandatory features 13.3, 13.8 and 13.9. Each section gives the
chosen design, a rejected alternative and the trade-off, as section 13.13 of the
spec requires.

## What is built

| Piece | Where |
| --- | --- |
| Create, get, update, delete, save, search, availability | `services/property-service/src/routes.js` |
| SQL for listings, calendar, blocks, saved | `src/models/property.js`, `availability.js`, `saved.js` |
| Two search strategies (MySQL, MongoDB) | `src/search/strategies.js`, `src/search/filters.js` |
| Redis cache for search and calendars | `src/cache.js` |
| MongoDB read model for the mongo strategy | `src/readModel.js` |
| Property worker (`property-cg`) | `src/worker.js` |
| 200-property pool for the AI benchmark | `scripts/generate-properties.js` → `data/property-pool-200.json` |
| Search benchmark (13.8, §9) | `scripts/bench-search.js` |
| Cache demo (13.9) | `scripts/demo-cache.js` |
| Index experiment (§9) | `infra/mysql/experiments/*.sql` |
| Client pages | `client/src/pages/guest/Search.jsx`, `PropertyDetail.jsx`, `host/HostListings.jsx` |

## 13.3 Availability conflicts

**Detection.** Every availability write (block or unblock) sends the
`availability_version` it last read. In one transaction the service runs
`UPDATE properties SET availability_version = availability_version + 1 WHERE property_id = ? AND availability_version = ?`.
If 0 rows match, someone else changed the calendar first.

**Which update wins.** The first writer to commit. The row lock taken by that
`UPDATE` makes concurrent writers wait; when the first commits, the others
match 0 rows and get `409 VERSION_CONFLICT` with the current version. There is
no silent merge: the host's screen reloads the calendar and they decide again.
Blocks that overlap a booked night or an existing block are refused with
`409 DATE_CONFLICT` inside the same transaction, so a refused write never bumps
the version.

**Enforced by the database.** Integration test: 6 simultaneous blocks on the
same version → exactly 1 succeeds, 5 get VERSION_CONFLICT, 1 block row exists
(`test/integration/search-availability.int.js`).

**Stale reads, ordering, retries.** A host acting on an old calendar is exactly
the stale read the version check catches. Ordering is decided by commit order,
not by request arrival. Retrying a 409 with the *same* version can never
succeed, so clients must re-read first; that is why the error carries the
current version and is marked `retryable: true` only in the "re-read, then
retry" sense.

**Rejected alternative:** last-write-wins (no version). Simpler, but a host could
silently overwrite a co-host's block made seconds earlier. **Also considered:**
pessimistic `SELECT … FOR UPDATE` on a calendar read. It blocks other readers
while a host thinks, so we rejected it for an interactive screen.

**Coordination with Slice 3 (done).** The booking worker takes a shared lock on
the property row and refuses nights inside a host `blocked` range in the same
transaction that claims them. A host block takes the exclusive lock first (the
`availability_version` update above), so a block and a booking racing for the
same night cannot both succeed: whichever commits second sees the first.

## 13.8 Search strategy comparison

| | `mysql` (default) | `mongo` |
| --- | --- | --- |
| How | One SQL query: filters, `JSON_CONTAINS` for amenities, `NOT EXISTS` against `reservation_nights` and `availability_blocks` for dates, plus `COUNT(*)` | Query the `property_search` read model in MongoDB, then remove booked or blocked candidates with one MySQL query |
| Indexes | `(status, city, nightly_price)`, `(status, rating)` | Same shape: `{status, city, nightly_price}`, `{status, rating}` |
| Freshness | Always current | Eventually consistent: updated by the property worker after `property.*` and `review.created` events |

Both strategies use the same filter definitions (`src/search/filters.js`), so
the workload is identical. Pick the strategy per request with the header
`X-Search-Strategy: mysql | mongo`, and skip the cache with `X-Cache-Mode: bypass`.

**How to run the comparison** (same dataset and workload for every run):

```bash
npm run gen:properties -- --count 10000 --mongo     # dataset + Mongo read model
npm run bench:search -- --strategy mysql --cache off --concurrency 10 --requests 2000 --label c10
npm run bench:search -- --strategy mongo --cache off --concurrency 10 --requests 2000 --label c10
npm run bench:search -- --strategy mysql --cache on  --concurrency 10 --requests 2000 --label c10
# repeat with --concurrency 1, 25, 50 for the scaling graph
```

Results append to `tests/load/results/search-bench.csv` (throughput, average,
p50, p95, p99, error rate, cache hit rate). Run `docker stats` alongside and
note peak CPU and memory for `mysql`, `mongo` and `redis`.

**Results.** 10,000 properties, 25 concurrent users, the same request mix for
every run, sent to the property service directly (`bench:search` default),
on one Windows laptop with everything in Docker Desktop:

| Strategy | Throughput (req/s) | Average (ms) | p95 (ms) |
| --- | ---: | ---: | ---: |
| `mysql`, cache off | 79 | 313 | 566 |
| `mongo`, cache off | 47 | 522 | 1,035 |
| `mysql`, cache on (95% hits) | 147 | 163 | 289 |

MySQL wins: about 1.7 times the throughput of MongoDB and half the p95. The
`mongo` strategy pays for two round trips (the read model in MongoDB, then one
MySQL query to drop booked or blocked candidates), and our filters fit the
MySQL indexes well. MongoDB is also only eventually consistent, so `mysql`
stays the default. The
cache nearly doubles throughput and halves p95 on top of MySQL.

Timothy's performance report ([`docs/performance-report.md`](performance-report.md),
experiments 1 and 5) measured the `mysql` strategy with JMeter on a faster
machine: about 1,150 req/s through the gateway, the two indexes worth 5 to 35%,
and the cache 3.3 times the throughput at the property service. The absolute
numbers differ from the table above because the machines differ; the
comparisons between configurations point the same way.

## 13.9 Redis cache invalidation

**Design: cache-aside with a version counter.**
`search:<version>:<strategy>:<sha256(filters)>` holds a search result for 60 s.
Any change that can alter results (create, update, delete, block, unblock, a
booking confirmed or cancelled, a new rating) runs `INCR search:version`, so
every older key is unreachable at once. `avail:<property_id>` holds a calendar
for 300 s and is deleted on the same changes.

**Race handled.** The version is read *before* the database query. If a host
edit lands while a slow search is running, its result is stored under the old
version and never served (integration test "an invalidation during a slow
query never leaves stale data").

**Cache down.** Every Redis call is wrapped; search and calendar fall back to
the database and report `cache: "BYPASS"`. Measured here: invalidation with
Redis stopped returns in about 0.3 s without errors.

**Demo:** `npm run demo:cache` shows MISS, then HIT, then a price change, then
MISS with the new price. Run it again after `docker compose stop redis` to show
BYPASS.

**What does not invalidate.** `booking.rejected` only clears the cache for a host
decline (`new_status` DECLINED), which frees nights. A request refused by the
booking worker (dates taken, host block, deleted guest) never held nights, so
it changes nothing; without this check every losing request in a double-booking
race would refresh every cached search.

**Rejected alternative:** deleting only the search keys that contain the changed
property. That needs a reverse index (property → keys) that must stay in sync,
and it is easy to miss a key. Bumping one counter is a single atomic command and
always correct; the cost is that unrelated cached searches are refreshed too,
which is acceptable with a 60 s TTL.

## Other decisions

- **Optimistic locking on listing edits** (`version`). Same reasoning as 13.3.
  Integration test: 8 simultaneous saves → exactly one applies.
- **Soft delete.** Bookings and reviews keep pointing at the listing. Deleting
  is refused while it has upcoming bookings; reading a deleted listing returns
  410, not 404.
- **Events after a committed write.** If Kafka is down, the listing is still
  saved and the request returns after at most 2 s (`PUBLISH_WAIT_MS`); the
  event is logged as failed. Failing the request instead would make a retry
  create a duplicate listing. The complete fix is a transactional outbox;
  named here as future work.
- **Cache invalidation runs before publishing the event,** so the next search
  is correct even when Kafka is slow.
- **Search events for analytics.** Every guest search publishes one
  `property.searched` event (city, dates, guests, result count, strategy, cache
  result), keyed by city. The admin geo report counts them per city or state.
  It is fire and forget, so a slow or down broker never slows a search; a host
  listing their own properties is not counted. Turn it off for search load
  tests with `SEARCH_EVENTS=off`.

## Tests

```bash
npm test -w services/property-service         # 38 unit tests, no database needed
npm run test:db -w services/property-service  # 15 tests against MySQL + Redis (npm run infra:up first)
```

The `mongo` strategy's query builder is unit-tested. Run it end to end with
`npm run gen:properties -- --mongo` and `npm run bench:search -- --strategy mongo`.
