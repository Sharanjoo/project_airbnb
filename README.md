# Staybook: distributed rental and booking platform

Group project for Distributed Systems: an Airbnb-style rental platform built as
REST microservices joined by Kafka, with MySQL, MongoDB, Redis and a multi-agent
AI recommendation service. The API design (Deliverable A) is the source of truth
for every endpoint and event in this repo.

**Who owns what and what to do first: see [TEAM.md](TEAM.md).**

## Stack

| Tier | Technology |
| --- | --- |
| Client | React 18 + Vite (`client/`) |
| Services | Node 22 + Express (`services/*`), FastAPI for AI (`services/ai-service`) |
| Middleware | Kafka 3.8 (KRaft, no ZooKeeper), shared JSON envelope, DLQ per topic |
| Data | MySQL 8 (transactions), MongoDB 7 (documents, traces, AI debate), Redis 7 (cache) |

## Prerequisites

- Docker Desktop (running)
- Node.js 22 or newer: `node -v`
- Python 3.12 (only if you work on the AI service outside Docker)

## Quick start

```bash
npm install                  # installs every Node workspace
cp .env.example .env         # Windows PowerShell: Copy-Item .env.example .env
npm run infra:up             # Kafka + topics, MySQL, MongoDB, Redis, Kafka UI
npm test                     # unit tests for all Node services
```

Then either run the services you are working on locally:

```bash
npm run dev:gateway
npm run dev:booking
npm run dev:booking-worker
npm run dev:property         # property API
npm run dev:property-worker  # cache invalidation, ratings, Mongo read model
npm run dev:client           # http://localhost:5173
```

or run everything in Docker:

```bash
docker compose up -d --build
npm run smoke                # health checks + one booking through Kafka
```

Kafka UI is at http://localhost:8090 for topics, messages, consumer groups and lag.

## Ports

| What | Port on your machine |
| --- | --- |
| Client (Vite) | 5173 |
| API Gateway | 8080 |
| User / Property / Booking / Messaging / Review / Analytics | 8001 to 8006 |
| AI Agent Service | 8007 |
| Notification gateway (WebSocket) | 8009 |
| Kafka (from your machine) | 9094 |
| MySQL | **3307** (not 3306, so it does not clash with a local MySQL) |
| MongoDB | **27018** |
| Redis | 6379 |
| Kafka UI | 8090 |

## Repository layout

```
contracts/                 envelope.schema.json, shared by Node and Python
infra/kafka/               topics.txt + create-topics.sh (each topic also gets <topic>.dlq)
infra/mysql/init/          001_schema.sql, 002_seed.sql (run on first container start)
infra/mongo/init/          collections and indexes
packages/common/           shared Node library, used by every Node service:
                             envelope create/validate, EventBus (publish, consume with
                             retry + DLQ + manual commit), claimEvent (consumer idempotency),
                             error model, Express app factory, DB clients
services/gateway/          JWT check, rate limit, trace id, routes /api/v1/<service>/...
services/<name>-service/   src/index.js (API), src/routes.js, src/models/ (data access),
                           src/worker.js (Kafka consumer, separate process), test/
services/notification-gateway/  Kafka events -> WebSocket pushes
services/ai-service/       FastAPI app/ + agents/ (one process per agent) + tests/
client/                    React pages, one placeholder per screen with its owner and endpoints
scripts/smoke.js           end-to-end check
tests/load/                JMeter plans and results (Deliverable D)
```

## How a request flows

```
React -> gateway :8080 -> Booking API :8003 -> Kafka booking.requested
      -> booking-worker (MySQL transaction) -> booking.confirmed / rejected
      -> notification-gateway -> WebSocket -> React
```

`trace_id` is created at the gateway (or by the client) and carried in the
`X-Trace-Id` header and every Kafka envelope, so one journey can be followed end to end.

## Conventions (from the API doc)

- Success body `{ "data": ..., "trace_id": ... }`; error body `{ "error": { code, message, details, retryable }, "trace_id" }`. Use `Errors.*` from `@airbnb/common`, never hand-written error JSON.
- Validate every request body with Joi (`validateBody`) or Pydantic. Unknown fields are rejected.
- State-changing booking and AI-approval calls require an `Idempotency-Key` header.
- Publish only through `bus.publish(topic, createEnvelope(...), key)`. It validates the envelope first.
- Consumers call `claimEvent(conn, group, env, topic)` inside the same MySQL transaction as their write.
- Stay dates are plain `YYYY-MM-DD`; timestamps are UTC ISO strings ending in `Z`.
- Topic names come from `TOPICS` in `@airbnb/common`. To add a topic, edit `infra/kafka/topics.txt` **and** `packages/common/src/topics.js` (a test checks they match).

## Data and experiment scripts

```bash
npm run gen:properties                       # the fixed 200-property pool (AI benchmark "active-pool-v1")
npm run gen:properties -- --count 10000 --mongo   # bigger dataset + MongoDB read model for search experiments
npm run bench:search -- --strategy mysql --cache off   # search benchmark, results in tests/load/results/
npm run demo:cache                           # 13.9 demo: MISS, HIT, price change, fresh MISS
```

Design notes for properties, search, availability and caching: [docs/slice2-properties-search.md](docs/slice2-properties-search.md).

## Tests

```bash
npm test                                   # all Node unit tests
npm test -w services/booking-service       # one service
npm run test:db -w services/booking-service  # double-booking + duplicate-event test, needs MySQL running
npm run test:db -w services/property-service # property SQL, concurrent updates, cache invalidation; needs MySQL + Redis
cd services/ai-service && pip install -r requirements.txt && pytest
```

Every service has a `routes.test.js` that fails if an endpoint from the API doc
is missing. Add behaviour tests next to it as you implement each endpoint.

## Status of the skeleton

Working and tested:

- Shared envelope validation (Node and Python use the same schema file)
- Kafka consumer logic: malformed or invalid messages go to DLQ, transient errors retry with backoff, permanent errors skip retries
- Gateway: JWT, spoofed identity headers dropped, trace id, 503 when a service is down
- Properties (Slice 2): create, get, update, delete, save, search with two strategies and a Redis cache, availability with conflict detection, property worker, client search/detail/host pages
- `POST /bookings/request`: validation, Idempotency-Key replay, capacity check, publishes `booking.requested`
- Booking worker: claims nights in one transaction; tested with 10 concurrent requests for the same nights (exactly one wins) and a duplicate delivery (applied once)
- Notification gateway WebSocket push by channel
- AI API: `POST /ai/requests` publishes `ai.requests` with the same trace id; harness checks for agent output, topic permissions and disagreement score

Stubs that return `501 NOT_IMPLEMENTED` until their owner fills them in: every
other endpoint, the agent logic, and all client pages.

Known gaps:

- The Docker images for the services have not been built yet. Run `docker compose up --build` once and fix anything that fails before splitting work.
- Consumer retries are in-process. The API doc also mentions `<topic>.retry.N` topics; Slice 3 decides whether to add them.
- The AI task store is in memory; Slice 5 moves it to MongoDB.
