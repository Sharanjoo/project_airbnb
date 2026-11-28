# Contributions

Spec §12 asks for a page mapping every vertical slice to an owner and repository
commits. Everything below comes from the git history of `main` (up to `9153fd5`,
2026-11-26) and the pull requests on GitHub; the commands at the end regenerate the
numbers. Each owner should check their own row and add anything the history cannot
show (see "Not in the repository").

## Slices and owners

| Slice | Owner (GitHub) | What they built | Merged PRs | Commits on `main` | Lines added / removed* |
|---|---|---|---|---:|---:|
| 1. Users, auth, gateway, messaging | Farzaan ([@farzaandalwai](https://github.com/farzaandalwai)) | Guest and host sign-up and login, JWT at the gateway (refusing deleted accounts' tokens), profiles with optimistic locking, Kafka-driven guest counters, messaging service and the booking-to-thread worker, the admin account setup for the platform and AI dashboards, Login and Messages pages | [#3](https://github.com/Sharanjoo/project_airbnb/pull/3), [#4](https://github.com/Sharanjoo/project_airbnb/pull/4), [#5](https://github.com/Sharanjoo/project_airbnb/pull/5), [#21](https://github.com/Sharanjoo/project_airbnb/pull/21) | 9 | +6,375 / −184 |
| 2. Properties, search, availability | Sharan ([@Sharanjoo](https://github.com/Sharanjoo)) | Property service: listings, MySQL and MongoDB search strategies (13.8), availability with version checks (13.3), Redis cache and invalidation (13.9), search events for the geo report; Search, PropertyDetail and HostListings pages | [#1](https://github.com/Sharanjoo/project_airbnb/pull/1), [#2](https://github.com/Sharanjoo/project_airbnb/pull/2), [#17](https://github.com/Sharanjoo/project_airbnb/pull/17) | 6 (+1 skeleton) | +3,089 / −106 |
| 3. Bookings and reliability | Prajeet ([@villyalsriprajeet-cmd](https://github.com/villyalsriprajeet-cmd)) | Booking API and worker: request, approve, decline, cancel, the night-claim that prevents double booking (13.1), idempotency, the scheduler (expire and complete), recovery after a consumer restart (13.2) with demos; My trips and Reservation requests pages | [#9](https://github.com/Sharanjoo/project_airbnb/pull/9), [#18](https://github.com/Sharanjoo/project_airbnb/pull/18) | 16 | +3,649 / −329 |
| 4. Reviews, analytics, real time, load tests | Timothy ([@TimothyYSong](https://github.com/TimothyYSong)) | Review service, analytics service (dashboard endpoints, traces), guest, host and platform/AI dashboards, notification gateway authorization and 13.4 latency, trace steps in the shared consumer, JMeter load tests and the performance report (§9), demo scripts, this contributions page | [#6](https://github.com/Sharanjoo/project_airbnb/pull/6), [#7](https://github.com/Sharanjoo/project_airbnb/pull/7), [#11](https://github.com/Sharanjoo/project_airbnb/pull/11), [#13](https://github.com/Sharanjoo/project_airbnb/pull/13), [#14](https://github.com/Sharanjoo/project_airbnb/pull/14), [#15](https://github.com/Sharanjoo/project_airbnb/pull/15), [#16](https://github.com/Sharanjoo/project_airbnb/pull/16), [#19](https://github.com/Sharanjoo/project_airbnb/pull/19), [#20](https://github.com/Sharanjoo/project_airbnb/pull/20) | 32 | +6,391 / −724 |
| 5. AI agent service | Kavan ([@Kavan1804](https://github.com/Kavan1804)) | FastAPI AI service: task store, parser, matching, risk and fairness agents, the Chair's debate rounds, disagreement and votes, WebSocket stream, human approval, feedback and config versions (13.10, 13.11), the AI match page in the client and the Docker/Kafka integration | [#8](https://github.com/Sharanjoo/project_airbnb/pull/8), [#10](https://github.com/Sharanjoo/project_airbnb/pull/10), [#22](https://github.com/Sharanjoo/project_airbnb/pull/22) | 4 | +5,297 / −194 |

\* Lines from `git log --numstat` on `main`, without `package-lock.json`, generated
data (`data/`), generated charts (`*.svg`) and load-test result files. Commit and
line counts measure size, not effort: Kavan's four commits are large, for example.

**Project skeleton (shared).** Sharan's first commit,
[`350237e`](https://github.com/Sharanjoo/project_airbnb/commit/350237e) "Initial
project skeleton" (+4,390 lines in 112 files), was more than stubs. It included:

- the shared library in `packages/common`: envelope validation, the Kafka consumer
  with bounded retries and the dead-letter topic, `claimEvent` for duplicate events,
  `withTransaction` with deadlock retry, and the common error model;
- the gateway: JWT checks, trace ids and 503 handling;
- Docker Compose, CI (GitHub Actions), and the MySQL and MongoDB init scripts;
- the first booking request endpoint and the night-claiming worker, with the test
  that sends 10 concurrent requests for the same nights, which slice 3 built on;
- starting points for the other services and the client, which each owner filled in.

It is not counted in Sharan's slice 2 row above.

### Open pull requests (not on `main` yet)

None right now: every pull request up to #22 is merged.

## Work across slices

Changes one owner made in shared code or in another slice, so they are not lost in
the slice rows:

| Who | What | Where |
|---|---|---|
| Sharan | Project skeleton: the shared library (envelopes, Kafka consumer with retry and DLQ, `claimEvent`, `withTransaction`, error model), the gateway (JWT, trace ids, 503s), Docker Compose, CI, database init scripts, and the first booking endpoint, night-claiming worker and double-booking test | `350237e` |
| Sharan | Kafka keeps its data on its volume; no password hash in the property generator | [#12](https://github.com/Sharanjoo/project_airbnb/pull/12) |
| Sharan | `property.searched` events and the geo report's search counts in the analytics service | [#17](https://github.com/Sharanjoo/project_airbnb/pull/17) |
| Prajeet | Search cache cleared on host declines; `actor_id` stored on idempotency records (shared) | `04024b8` |
| Prajeet | Gateway test made independent of the review service; demo scripts read `.env` | `ae69d8f`, `67c0047` |
| Farzaan | Gateway refuses tokens of deleted accounts | `a3d2999` |
| Timothy | Notification gateway channel authorization (who may hear which push) | [#6](https://github.com/Sharanjoo/project_airbnb/pull/6) |
| Timothy | Trace step per consumed event in the shared Kafka consumer (`packages/common`) | [#15](https://github.com/Sharanjoo/project_airbnb/pull/15) |

## Design notes

| Slice | Note |
|---|---|
| 1 | [slice1-messaging.md](slice1-messaging.md), [slice1-account-deletion.md](slice1-account-deletion.md), [slice1-admin-account.md](slice1-admin-account.md) |
| 2 | [slice2-properties-search.md](slice2-properties-search.md) |
| 3 | [slice3-bookings.md](slice3-bookings.md) |
| 4 | [slice4-reviews-analytics-realtime.md](slice4-reviews-analytics-realtime.md), [performance-report.md](performance-report.md) |
| 5 | not yet (planned) |

## Not in the repository

The git history does not show these. Owners, please fill in who did what:

| Deliverable | Who |
|---|---|
| A. API design document | Sharan |
| E. Final presentation and slides | _to fill in_ |
| 50-request AI benchmark: the two human labellers and adjudication | _to fill in_ |
| Demo run sheet and rehearsal | _to fill in_ |

## Reviews

Approvals recorded on GitHub (the "Approved" reviews on each pull request):

| Reviewer | Approvals | Pull requests |
|---|---:|---|
| Sharan | 9 | [#3](https://github.com/Sharanjoo/project_airbnb/pull/3), [#8](https://github.com/Sharanjoo/project_airbnb/pull/8), [#9](https://github.com/Sharanjoo/project_airbnb/pull/9), [#10](https://github.com/Sharanjoo/project_airbnb/pull/10), [#11](https://github.com/Sharanjoo/project_airbnb/pull/11), [#13](https://github.com/Sharanjoo/project_airbnb/pull/13), [#14](https://github.com/Sharanjoo/project_airbnb/pull/14), [#15](https://github.com/Sharanjoo/project_airbnb/pull/15), [#20](https://github.com/Sharanjoo/project_airbnb/pull/20) |
| Prajeet | 5 | [#2](https://github.com/Sharanjoo/project_airbnb/pull/2), [#6](https://github.com/Sharanjoo/project_airbnb/pull/6), [#7](https://github.com/Sharanjoo/project_airbnb/pull/7), [#16](https://github.com/Sharanjoo/project_airbnb/pull/16), [#19](https://github.com/Sharanjoo/project_airbnb/pull/19) |
| Timothy | 3 | [#1](https://github.com/Sharanjoo/project_airbnb/pull/1), [#9](https://github.com/Sharanjoo/project_airbnb/pull/9), [#18](https://github.com/Sharanjoo/project_airbnb/pull/18) |
| Farzaan | 0 | — |
| Kavan | 0 | — |

[#4](https://github.com/Sharanjoo/project_airbnb/pull/4) and [#5](https://github.com/Sharanjoo/project_airbnb/pull/5) were stacked on
[#3](https://github.com/Sharanjoo/project_airbnb/pull/3) and merged into its branch, so they reached `main` through #3's approval.
Merged into `main` without an approval recorded on GitHub: [#12](https://github.com/Sharanjoo/project_airbnb/pull/12), [#17](https://github.com/Sharanjoo/project_airbnb/pull/17), [#21](https://github.com/Sharanjoo/project_airbnb/pull/21), [#22](https://github.com/Sharanjoo/project_airbnb/pull/22). Reviews
given outside GitHub (in the group chat or in person) are not in this table; add them
here if you did some.

## Every commit on `main`, by owner

<details>
<summary>Farzaan (9)</summary>

| Commit | Date | Subject |
|---|---|---|
| `cbe6808` | 2026-11-22 | Slice 1 phase 1: guest/host sign-up, login, gateway stale-token fix, Login page |
| `c076cdc` | 2026-11-22 | Phase 1 review fixes: session race, side-effect-free getSession, precise duplicate mapping |
| `7b69c04` | 2026-11-22 | Slice 1 phase 2: user profiles and Kafka-driven guest counters |
| `faead84` | 2026-11-22 | Phase 2 review: lifetime booking_count, atomic versioned updates |
| `0333aa6` | 2026-11-22 | Slice 1 phase 3: messaging service, booking-to-thread worker, Messages page |
| `a3d2999` | 2026-11-23 | Refuse deleted accounts' tokens at the gateway |
| `a78ef35` | 2026-11-23 | Messaging docs: gateway fix keeps listing pushes; smoke cleans its Kafka group |
| `9b3c661` | 2026-11-26 | Slice 1: admin account setup for the Platform and AI dashboards |
| `fc8c0b4` | 2026-11-26 | smoke:auth: always remove the throwaway admin, and run the admin checks last |

</details>

<details>
<summary>Sharan (7, including the skeleton)</summary>

| Commit | Date | Subject |
|---|---|---|
| `350237e` | 2026-10-31 | Initial project skeleton |
| `a17fe37` | 2026-10-31 | Quiet KafkaJS startup warnings and make smoke test wait for services |
| `ced1581` | 2026-11-09 | Add slice owners |
| `a73c465` | 2026-11-09 | Property search, availability, caching and host pages |
| `b17d3b4` | 2026-11-22 | Stop tracking the generated 10k property pool |
| `09bdef0` | 2026-11-23 | Keep Kafka data on its volume and stop storing a password hash in the generator |
| `f83cb16` | 2026-11-25 | Clear the search cache only on host declines, use useSession in property pages, publish search events for the geo report |

</details>

<details>
<summary>Prajeet (16)</summary>

| Commit | Date | Subject |
|---|---|---|
| `375bff9` | 2026-11-18 | Booking service: get, byProperty and byGuest endpoints |
| `6e53d10` | 2026-11-18 | Booking service: read endpoints, approve/decline/cancel, idempotency checks |
| `e9dab56` | 2026-11-18 | Booking worker: confirm, decline, cancel, blocked dates, scheduler, safe redelivery |
| `04024b8` | 2026-11-18 | Shared: clear search cache when a host declines, store who made a request |
| `aadac65` | 2026-11-18 | Booking: follow the API doc rules, add duplicate booking check, tidy comments |
| `d3b8105` | 2026-11-18 | Booking: show listing title and city on trips |
| `26ff077` | 2026-11-18 | Client: My trips and Reservation requests pages |
| `ef4db93` | 2026-11-18 | Add the 13.2 failure and recovery demo |
| `03e1870` | 2026-11-18 | Add the 13.1 double booking demo |
| `3d68eff` | 2026-11-18 | Add the outage step to the recovery demo and the slice 3 design note |
| `ae69d8f` | 2026-11-24 | Gateway test: do not depend on the review service being down |
| `96be6ca` | 2026-11-24 | Booking worker: reject requests from guests whose account was deleted |
| `6e0852b` | 2026-11-24 | Requests page: react to booking.requested pushes |
| `06ac44c` | 2026-11-24 | Slice 3 note: deleted guests, database change, live pushes |
| `67c0047` | 2026-11-24 | Demo scripts: read settings from .env instead of hard-coded values |
| `1f188e1` | 2026-11-26 | Booking: look up pending bookings by key, record the real approver, replay before the date check, scope keys to the caller |

</details>

<details>
<summary>Timothy (32)</summary>

| Commit | Date | Subject |
|---|---|---|
| `5b9e7e9` | 2026-11-23 | Authorize notification gateway channels and push booking.requested |
| `9e75aa8` | 2026-11-23 | Implement review service: create, get, byProperty, respond |
| `e7c977f` | 2026-11-23 | Match review service to the API doc (§7, §10, §13.5) |
| `6d36d81` | 2026-11-23 | Implement analytics endpoints from live MySQL and Mongo events |
| `e04e9b7` | 2026-11-23 | Match analytics endpoints to the API doc (§8, §13.6) |
| `bd99990` | 2026-11-23 | Build guest, host, platform and AI dashboards (Deliverable C) |
| `917fbed` | 2026-11-25 | Count AI tasks once and dedupe AI events (Kavan's event notes) |
| `72deaff` | 2026-11-25 | Add the slice 4 design note |
| `2c4718e` | 2026-11-25 | Add the property search load test (spec 9, experiment 1) |
| `b7613ca` | 2026-11-25 | Add the indexing load test and load-test instructions |
| `95d591f` | 2026-11-25 | Add the booking end-to-end load test (spec 9, experiment 2) |
| `44ecd86` | 2026-11-25 | Add the Kafka scaling load test (spec 9, experiment 4) |
| `896c794` | 2026-11-25 | Add the failure recovery load test (spec 9, experiment 6) |
| `9a34308` | 2026-11-25 | Add the AI debate timing test (spec 9, experiment 3) |
| `57649fd` | 2026-11-25 | Time the AI debate with a real model (experiment 3) |
| `740f46c` | 2026-11-25 | Add the performance report with charts (spec 9, Deliverable D) |
| `196962b` | 2026-11-25 | Index reviews by review_id and cap notification channels (review notes on #7 and #6) |
| `7cc4499` | 2026-11-25 | Dashboards: send the viewer's local day boundaries to the API |
| `275d03a` | 2026-11-25 | Add npm run demo:activity: real activity for the dashboards |
| `da278fc` | 2026-11-25 | Measure 13.4 notification latency from the event, add npm run demo:realtime |
| `f8a5771` | 2026-11-25 | Slice 4 note: 13.4 latency numbers, demo data, differences from the API doc |
| `d843fcf` | 2026-11-25 | Record a trace step for every consumed event (shared consumer, API doc §8) |
| `1977e1a` | 2026-11-25 | demo:activity cleanup also removes trace steps; warn before test:db |
| `4899ba6` | 2026-11-25 | Load tests: clean up trace steps; note the trace-step overhead in the report |
| `31299a3` | 2026-11-25 | Add the consumer-groups comparison (spec 9, experiment 4) |
| `cd5f14d` | 2026-11-25 | demo:activity: finished stays and reviews, so reviews can be demoed |
| `06b93d7` | 2026-11-26 | Limit POST /events/ingest to services and admins (review on #11) |
| `5f79a1e` | 2026-11-26 | Commit the load-test summaries behind the performance report |
| `e89aa4c` | 2026-11-26 | Load tests: DLQ replay note and Windows/Git Bash instructions |
| `8af17b9` | 2026-11-26 | Add the contributions page (spec 12) |
| `ed2ec70` | 2026-11-26 | Contributions page: #18 merged |
| `97e24bc` | 2026-11-26 | Contributions page: #16 and #19 merged |

</details>

<details>
<summary>Kavan (4)</summary>

| Commit | Date | Subject |
|---|---|---|
| `eeea344` | 2026-11-24 | Slice 5: Mongo task store, parser, and round-0 analysis agents |
| `e578ee8` | 2026-11-24 | Update README status for the AI service |
| `8c4725c` | 2026-11-24 | Slice 5: Chair debate, live stream, approval, feedback and versions |
| `f8246b0` | 2026-11-25 | Slice 5: AI match page and Docker/Kafka integration |

</details>

## Regenerating the numbers

```bash
git shortlog -sn --no-merges main
```
```bash
git log main --no-merges --author="<name>" --numstat --format= -- . ':(exclude)package-lock.json' ':(exclude)*.svg' ':(exclude)data/*' ':(exclude)tests/load/results/*' | awk '{a+=$1; d+=$2} END {print "+" a, "-" d}'
```
```bash
git log main --no-merges --reverse --format='%h %an %ad %s' --date=short
```
