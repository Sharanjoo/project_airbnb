# Contributions

Spec §12 asks for a page mapping every vertical slice to an owner and repository
commits. Everything below comes from the git history of `main` (up to `09ab478`,
2026-11-25) and the pull requests on GitHub; the commands at the end regenerate the
numbers. Each owner should check their own row and add anything the history cannot
show (see "Not in the repository").

## Slices and owners

| Slice | Owner (GitHub) | What they built | Merged PRs | Commits on `main` | Lines added / removed* |
|---|---|---|---|---:|---:|
| 1. Users, auth, gateway, messaging | Farzaan ([@farzaandalwai](https://github.com/farzaandalwai)) | Guest and host sign-up and login, JWT at the gateway (refusing deleted accounts' tokens), profiles with optimistic locking, Kafka-driven guest counters, messaging service and the booking-to-thread worker, Login and Messages pages | [#3](https://github.com/Sharanjoo/project_airbnb/pull/3), [#4](https://github.com/Sharanjoo/project_airbnb/pull/4), [#5](https://github.com/Sharanjoo/project_airbnb/pull/5) | 7 | +5,466 / −179 |
| 2. Properties, search, availability | Sharan ([@Sharanjoo](https://github.com/Sharanjoo)) | Property service: listings, MySQL and MongoDB search strategies (13.8), availability with version checks (13.3), Redis cache and invalidation (13.9), search events for the geo report; Search, PropertyDetail and HostListings pages | [#1](https://github.com/Sharanjoo/project_airbnb/pull/1), [#2](https://github.com/Sharanjoo/project_airbnb/pull/2), [#17](https://github.com/Sharanjoo/project_airbnb/pull/17) | 6 (+1 skeleton) | +3,089 / −106 |
| 3. Bookings and reliability | Prajeet ([@villyalsriprajeet-cmd](https://github.com/villyalsriprajeet-cmd)) | Booking API and worker: request, approve, decline, cancel, the night-claim that prevents double booking (13.1), idempotency, the scheduler (expire and complete), recovery after a consumer restart (13.2) with demos; My trips and Reservation requests pages | [#9](https://github.com/Sharanjoo/project_airbnb/pull/9) | 15 | +3,585 / −308 |
| 4. Reviews, analytics, real time, load tests | Timothy ([@TimothyYSong](https://github.com/TimothyYSong)) | Review service, analytics service (dashboard endpoints, traces), guest, host and platform/AI dashboards, notification gateway authorization and 13.4 latency, trace steps in the shared consumer, JMeter load tests and the performance report (§9), demo scripts | [#6](https://github.com/Sharanjoo/project_airbnb/pull/6), [#7](https://github.com/Sharanjoo/project_airbnb/pull/7), [#11](https://github.com/Sharanjoo/project_airbnb/pull/11), [#13](https://github.com/Sharanjoo/project_airbnb/pull/13), [#14](https://github.com/Sharanjoo/project_airbnb/pull/14), [#15](https://github.com/Sharanjoo/project_airbnb/pull/15) | 25 | +6,048 / −685 |
| 5. AI agent service | Kavan ([@Kavan1804](https://github.com/Kavan1804)) | FastAPI AI service: task store, parser, matching, risk and fairness agents, the Chair's debate rounds, disagreement and votes, WebSocket stream, human approval, feedback and config versions (13.10, 13.11) | [#8](https://github.com/Sharanjoo/project_airbnb/pull/8), [#10](https://github.com/Sharanjoo/project_airbnb/pull/10) | 3 | +4,145 / −162 |

\* Lines from `git log --numstat` on `main`, without `package-lock.json`, generated
data (`data/`), generated charts (`*.svg`) and load-test result files. Commit and
line counts measure size, not effort: Kavan's three commits are large, for example.

**Project skeleton (shared).** Sharan's first commit,
[`350237e`](https://github.com/Sharanjoo/project_airbnb/commit/350237e) "Initial
project skeleton" (+4,390 lines in 112 files), set up every service, the shared
package, Docker Compose, the database scripts and the client, with stubs each owner
then filled in. It is not counted in Sharan's slice 2 row above.

### Open pull requests (not on `main` yet)

| PR | Owner | What |
|---|---|---|
| [#16](https://github.com/Sharanjoo/project_airbnb/pull/16) | Timothy | Finished stays and reviews in `npm run demo:activity`, so reviews can be demoed |
| [#18](https://github.com/Sharanjoo/project_airbnb/pull/18) | Prajeet | Booking follow-ups from the review of #9 |
| [#19](https://github.com/Sharanjoo/project_airbnb/pull/19) | Timothy | Slice 4 follow-ups from the reviews |
| `slice5/page-integration` (branch, no PR yet) | Kavan | AI page in the client and the `PROPERTY_SERVICE_URL` fix |

## Work across slices

Changes one owner made in shared code or in another slice, so they are not lost in
the slice rows:

| Who | What | Where |
|---|---|---|
| Sharan | Project skeleton; Kafka keeps its data on its volume, no password hash in the property generator | `350237e`, [#12](https://github.com/Sharanjoo/project_airbnb/pull/12) |
| Sharan | `property.searched` events and the geo report's search counts in the analytics service | [#17](https://github.com/Sharanjoo/project_airbnb/pull/17) |
| Prajeet | Search cache cleared on host declines; `actor_id` stored on idempotency records (shared) | `04024b8` |
| Prajeet | Gateway test made independent of the review service; demo scripts read `.env` | `ae69d8f`, `67c0047` |
| Farzaan | Gateway refuses tokens of deleted accounts | `a3d2999` |
| Timothy | Notification gateway channel authorization (who may hear which push) | [#6](https://github.com/Sharanjoo/project_airbnb/pull/6) |
| Timothy | Trace step per consumed event in the shared Kafka consumer (`packages/common`) | [#15](https://github.com/Sharanjoo/project_airbnb/pull/15) |

## Design notes

| Slice | Note |
|---|---|
| 1 | [slice1-messaging.md](slice1-messaging.md), [slice1-account-deletion.md](slice1-account-deletion.md) |
| 2 | [slice2-properties-search.md](slice2-properties-search.md) |
| 3 | [slice3-bookings.md](slice3-bookings.md) |
| 4 | [slice4-reviews-analytics-realtime.md](slice4-reviews-analytics-realtime.md), [performance-report.md](performance-report.md) |
| 5 | not yet (planned) |

## Not in the repository

The git history does not show these. Owners, please fill in who did what:

| Deliverable | Who |
|---|---|
| A. API design document | _to fill in_ |
| E. Final presentation and slides | _to fill in_ |
| 50-request AI benchmark: the two human labellers and adjudication | _to fill in_ |
| Demo run sheet and rehearsal | _to fill in_ |
| Pull request reviews | see each PR on GitHub |

## Every commit on `main`, by owner

<details>
<summary>Farzaan (7)</summary>

| Commit | Date | Subject |
|---|---|---|
| `cbe6808` | 2026-11-22 | Slice 1 phase 1: guest/host sign-up, login, gateway stale-token fix, Login page |
| `c076cdc` | 2026-11-22 | Phase 1 review fixes: session race, side-effect-free getSession, precise duplicate mapping |
| `7b69c04` | 2026-11-22 | Slice 1 phase 2: user profiles and Kafka-driven guest counters |
| `faead84` | 2026-11-22 | Phase 2 review: lifetime booking_count, atomic versioned updates |
| `0333aa6` | 2026-11-22 | Slice 1 phase 3: messaging service, booking-to-thread worker, Messages page |
| `a3d2999` | 2026-11-23 | Refuse deleted accounts' tokens at the gateway |
| `a78ef35` | 2026-11-23 | Messaging docs: gateway fix keeps listing pushes; smoke cleans its Kafka group |

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
<summary>Prajeet (15)</summary>

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

</details>

<details>
<summary>Timothy (25)</summary>

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

</details>

<details>
<summary>Kavan (3)</summary>

| Commit | Date | Subject |
|---|---|---|
| `eeea344` | 2026-11-24 | Slice 5: Mongo task store, parser, and round-0 analysis agents |
| `e578ee8` | 2026-11-24 | Update README status for the AI service |
| `8c4725c` | 2026-11-24 | Slice 5: Chair debate, live stream, approval, feedback and versions |

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
