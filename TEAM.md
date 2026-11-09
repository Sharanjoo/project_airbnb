# Team split

Five vertical slices, one owner each. Each owner builds their slice end to end
(React pages, API, worker, schema, tests) and explains one integration area in
the demo. The spec also requires a contributions page mapping every slice to an
owner and commits, so fill in the names below and keep this file current.

| Slice | Owner | Services and topics | Client pages | Mandatory feature | Integration area to explain |
| --- | --- | --- | --- | --- | --- |
| 1. Users, auth, gateway, messaging | Farzaan | user-service, gateway, messaging-service + worker; `user.*`, `message.sent` | Login, Messages | Live change request readiness (13.12) | JWT flow and gateway routing |
| 2. Properties, search, availability | Sharan | property-service, Redis; `property.*`, `availability.changed` | Search, PropertyDetail, HostListings | Redis cache invalidation (13.9) | Search strategy comparison (13.8) |
| 3. Bookings and reliability | Prajeet | booking-service API + worker; `booking.*`, `payment.completed`, DLQs | MyBookings, HostRequests | Double-booking (13.1), consumer failure and recovery (13.2) | Envelope validation, idempotency, DLQ |
| 4. Reviews, analytics, real time, load tests | Timothy | review-service, analytics-service + worker, notification-gateway; `review.*` | Guest, host and platform dashboards | Performance report (§9 of spec) | Real-time WebSocket updates (13.4) |
| 5. AI agent service | Kavan | ai-service API, parser, chair, matching, risk, fairness, explainer; `ai.*`, `debate.*` | AiRecommend | Three concurrent debates (13.11), agent timeout (13.10) | Debate protocol and 50-request benchmark |

## First tasks for each person

Everyone, day 1:

- [ ] Clone, `npm install`, `cp .env.example .env`, `npm run infra:up`, `npm test` all green
- [ ] Open Kafka UI (http://localhost:8090) and confirm the topics and `.dlq` topics exist
- [ ] Read the API doc section for your slice and the Conventions section of README.md

**Slice 1 (Farzaan)**
- [ ] `POST /guests/create`, `/hosts/create` with bcrypt hashing; publish `user.created`
- [ ] `POST /auth/login` returning a JWT the gateway accepts (`sub`, `role`)
- [ ] Login page storing the session; then guests/hosts get/update/delete with optimistic `version`
- [ ] Messaging: threads/open, messages/send (dedupe on `client_message_id`), messages/list

**Slice 2 (Sharan)**
- [ ] `POST /properties/create`, `/properties/get` (publish `property.viewed`), `/properties/update`
- [ ] `POST /properties/search` on indexed MySQL, then the Redis cache with `HIT`/`MISS`
- [ ] `POST /properties/availability` with `expected_version` (409 on conflict)
- [ ] Generate the 200-property pool needed for the AI benchmark (share with Slice 5)

**Slice 3 (Prajeet)**
- [ ] Run `npm run test:db -w services/booking-service` and understand why it passes
- [ ] Approve, decline and cancel endpoints and their worker handlers; status history rows
- [ ] Publish `booking.confirmed` / `booking.cancelled`; scheduler for `EXPIRED` and `COMPLETED`
- [ ] The 13.2 demo: stop the worker after Kafka has the event, restart, show no duplicate
- [ ] Get `docker compose up --build` fully green and keep CI green

**Slice 4 (Timothy)**
- [ ] Review create / byProperty / respond; the `review.created` consumer updating property rating
- [ ] Analytics worker is storing events: build `/analytics/platform` and `/traces/{trace_id}` first
- [ ] Host and guest dashboards from real data; WebSocket "dates no longer available" (13.4)
- [ ] JMeter plans in `tests/load/` for search, booking and AI (Deliverable D)

**Slice 5 (Kavan)**
- [ ] Mongo task store; plan record with `plan_id`; WebSocket stream frames
- [ ] Parser, then matching / risk / fairness round-0 opinions over Kafka
- [ ] Chair: disagreement score, challenges, votes, decision rule, `ai.results`
- [ ] 50-request benchmark set with two human labellers; filter-count baseline

## Working rules

- Branch per task: `slice2/property-search`. Open a pull request into `main`; one teammate reviews.
- Changes to `contracts/`, `packages/common/`, `infra/` or the API doc affect everyone: say so in the group chat and tag the PR `shared`.
- Never break `npm test` on `main`. Every endpoint you finish gets at least one test for success and one for its main error.
- Keep trace ids flowing: pass `req.traceId` into every envelope you create.
