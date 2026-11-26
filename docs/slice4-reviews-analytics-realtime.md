# Slice 4: reviews, analytics, real time and load tests

Owner: Timothy. Covers the Review Service, the Analytics Service and its worker,
the notification gateway, the guest, host and platform/AI dashboards, the
real-time feature 13.4 and the performance report (spec §9). The integration
area for the demo is real-time WebSocket updates. Each section gives the chosen
design, a rejected alternative and the trade-off, as section 13.13 of the spec asks.

## What is built

- Review Service: `services/review-service/src/routes.js`, data access in
  `src/models/review.js`. Reviews live in MongoDB `reviews`.
- Notification gateway: `services/notification-gateway/src/index.js`. Kafka
  events in, WebSocket frames out, with per-channel authorization.
- Analytics API: `services/analytics-service/src/routes.js`. Queries in
  `src/models/stats.js`, Kafka health (consumer lag, DLQ size) in
  `src/models/kafkaStats.js`.
- Analytics worker: `services/analytics-service/src/worker.js`, consumer group
  `analytics-cg`. It stores every event from every domain topic in Mongo `events`.
- Dashboards: `client/src/pages/guest/GuestDashboard.jsx`,
  `client/src/pages/host/HostDashboard.jsx` and
  `client/src/pages/admin/PlatformDashboard.jsx` (platform, AI and the trace view).
  Shared chart pieces are in `client/src/components/charts.jsx`, with styles in
  `dashboards.css` and data loading in `useAnalytics.js`.

## Reviews

Endpoints follow API doc §7: `create` (guest), `get` and `byProperty` (public),
`respond` (owning host).

- A guest can review only their own stay, and only once it is `COMPLETED`
  (403 not theirs, 404 unknown, 422 not finished). `property_id`, `guest_id` and
  `host_id` are copied from the reservation, never taken from the client.
- One review per reservation: the unique index on `reservation_id` makes a second
  create fail, answered as `409 ALREADY_REVIEWED`.
- Public reads show `guest_first_name` only, never `guest_id` or `reservation_id`.
- A host answers once; a second answer is `409 INVALID_STATE_TRANSITION`.

**Rating.** Chosen: no review consumer of our own. `review.created` carries
`property_id` and `rating`, and the property worker (slice 2) recomputes `rating`
and `review_count` from the reviews collection. Rejected: incrementing a running
average in the review service, which drifts when an event is redelivered. The
trade-off is one recount per review, which is cheap at our size.

**Kafka down during create.** Chosen: the review is saved with a
`event_published: false` flag, the API answers 503 (retryable), and the client's
retry finds the saved review and publishes it without creating a second one.
Rejected: answering 201 anyway, which would leave the rating stale forever if the
event never went out.

## 13.4 Real-time booking state

The flow: booking worker publishes `booking.confirmed` (or `availability.changed`)
→ the notification gateway consumes it (`notify-cg`) → it pushes a frame to every
socket subscribed to the right channel → the listing page (slice 2) reloads the
calendar, shows "Your dates are no longer available" and disables the booking
button. A stale booking cannot succeed anyway: if the guest sends it, the API
accepts it (202) and the booking worker's night claim rejects it with
`DATE_CONFLICT` (slice 3).

**Latency, measured from the event.** Every frame carries `event_at` (the event's
own timestamp, set by the producer) and `sent_at` (when the gateway pushed it).
The page shows the time from `event_at` to the update on screen ("shown N ms after
the change"), so the number covers Kafka, the gateway's consumer and the push, as
13.4 asks. `npm run demo:realtime` measures it without a browser: a viewer watches
`property:prp_0002` while another guest books and the host approves, then cancels,
in repeated rounds. On the test laptop (2026-11-25, everything on one machine):

| | Pushes | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Event → viewer (`booking.confirmed`, `booking.cancelled`) | 20 | 1 ms | 2 ms | 2 ms |
| of which gateway → viewer | 20 | 0 ms | 1 ms | |
| On the listing page, in the browser | 2 | 3–4 ms | | |

The containers' clock is compared with the client's through MySQL `NOW(3)` and
corrected; that comparison is good to about ±2 ms, so these values are
approximate. They are small because Kafka, the gateway and the viewer share one
machine; across a network the push adds the network round trip.

One cold-start effect matters for the demo: right after the notification gateway
(re)starts, its consumer group is still forming, and the first push took about
13 s. The demo script runs one uncounted warm-up round for this reason; before a
live 13.4 demo, book and cancel once (or run the script) first.

Channels: `user:<id>` (your own pushes), `property:<id>` (anyone viewing a
listing) and `task:<id>` (an AI task). Pushed topics: `booking.requested`,
`booking.confirmed`, `booking.rejected`, `booking.cancelled`,
`booking.completed`, `availability.changed`, `message.sent`, `ai.results`.

**Who may hear what.** Chosen, after Farzaan's third-user test showed anyone could
join any channel:

- You can only subscribe to your own `user:<id>`. Other users' channels are
  dropped silently, so a client cannot tell whether they exist.
- `property:<id>` is open to anyone signed in, but only receives
  `availability.changed` and booking outcomes, with only public fields
  (`property_id`, dates, status, `availability_version`). Never `guest_id`,
  `host_id`, the reason or the price. Pending requests and messages never go there.
- `task:<id>` frames reach only the task's owner (`payload.user_id`) or an admin.
- Tokens are verified with HS256 pinned, and a token without `sub` is refused (4401).

Rejected: putting the full event on every channel and trusting clients to
subscribe honestly. The trade-off is two frame shapes per event (full for the
people involved, filtered for watchers), which is still a single pass over the
open sockets.

## Analytics

All nine endpoints from API doc §8 are implemented. Every number is computed
live from MySQL and the Mongo `events` and `traces` collections, never from
samples. All GETs take `from` and `to` (a date, inclusive, or an ISO timestamp);
the default is the last 30 days. Hosts and guests only see their own data (403
otherwise); admins can pick any.

Definitions (API doc §8):

- **Occupancy rate** = booked nights ÷ available nights in the range, where
  available nights exclude dates the host blocked.
- **Revenue** is counted per night stayed (`total_price ÷ nights` for each night
  in `reservation_nights`), so a stay that crosses the range edge is split correctly.
- **Median response time** = minutes from a guest's first message in a thread to
  the host's first reply (read from slice 1's messages).
- **Funnel** = viewed → saved → requested → confirmed → completed. "Confirmed"
  means ever confirmed (from status history), so a stay cancelled after
  confirmation still counts, but a request withdrawn before the host answered does not.
- **Workflow latency** = last step − first step for a `trace_id`.
- **Consumer lag** = latest offset − committed offset per group, read with the
  Kafka admin API. If Kafka cannot be reached within 3 s, the platform dashboard
  still answers, with nulls and the reason.

**AI metrics.** Chosen: computed from the §11 events. Tasks are counted by unique
`task_id`, because the parser republishes `ai.requests` for every task; each
trace's clock starts at its first `ai.requests`; events are deduplicated on
`idempotency_key` (delivery is at least once); round-1 messages that only ask an
agent to resend are skipped. Precision@10 and recall@10 come from the evaluated
config in `agent_versions`.

**Where events come from.** Chosen: a dedicated worker in its own consumer group
stores every domain event once (upsert on `event_id`). Rejected: querying each
service's database from analytics, which couples analytics to every schema and
misses events that never reach a database. The trade-off is one more copy of each
event in Mongo.

**Trace view.** `/traces/{trace_id}` merges step documents from the `traces`
collection with one step per Kafka event (service = the topic's producer, latency
= delay until analytics consumed it). Someone else's trace answers 404, exactly
like an unknown one.

**Event ingest.** `POST /events/ingest` takes one envelope or `{events}` (max 500)
and answers 202 `{accepted, rejected, errors}`. Only services and admins may call
it (guests and hosts get 403), so a user token cannot write events into the
dashboards; services normally publish to Kafka, and this is for batch backfills.
The API doc lists clients as callers too; this is narrower on purpose. Rejected
envelopes are stored for the platform's rejected-envelope count.

## Dashboards

- **Guest:** bookings per day, reservation status, saved vs removed per day,
  average match score, recommendation approvals; 7/30/90 days.
- **Host:** occupancy, revenue, average nightly price, cancellations, median
  response time; revenue per day, views-to-booking funnel, monthly rating trend.
- **Platform + AI (admin):** throughput, latencies, errors, retries, DLQ and
  rejected counts, events by topic, consumer lag; agent publication timeline,
  disagreement, challenges, votes, dissent, approvals. The trace lookup at the top
  takes a `trace_id` (also as `?trace_id=` in the URL) to show one journey end to
  end during the demo.

**Data for the demo.** A fresh database shows zeros, because nothing is sampled.
`npm run demo:activity` makes 8 demo guests use the app through the gateway:
views and saves, booking requests that the seed host `hst_0001` approves,
declines or cancels, messages with replies, and AI recommendations that are
approved or rejected. Some stays start today so occupancy and revenue show in the
default 30-day range. `npm run demo:activity -- --cleanup` removes all of it; do that
before `npm run test:db`, whose booking tests use the same listings.

**Dates.** The range pickers hold the viewer's local days; the client sends the
local start of `from` and end of `to` as timestamps, so "today" means the
viewer's today. Daily charts are grouped by UTC day.

Chosen: plain SVG charts with no chart library, a hover tooltip and a table view
on every chart, so no value depends on colour or hover alone. Rejected: adding a
charting dependency, which would change the shared `package.json` and lockfile.
The trade-off is a small amount of chart code to maintain (`charts.jsx`).

## Limits

- `geo` counts `searches` from the property service's `property.searched` events
  (Sharan, #17); searches without a city have no region and are left out.
- Rejected envelopes are counted in Mongo; sending them to an `events.dlq` topic
  waits for the team to add that topic.
- Trace steps per consumer (handled, retry, dead-lettered, with latency and error)
  come from the shared consumer in `packages/common` (separate PR, tagged shared).
  Without it, error and retry counts read 0 and traces show Kafka events only.
  Finer steps inside a handler (for example `claim_nights`) are not recorded.
- A WebSocket that drops is not reconnected automatically yet (`useLiveUpdates.js`).
- Differences from the API doc:
  - The notification gateway is one process with its subscriptions in memory, not
    Redis pub/sub. Running several gateway instances would need Redis pub/sub so
    a push reaches sockets on every instance.
  - The review prompt reaches the guest through the notification gateway
    (`booking.completed` on `user:<id>`); the review service does not consume
    `booking.completed` itself.
- The rating trend and reviews need a COMPLETED stay, which only the booking
  scheduler produces after checkout, so `demo:activity` cannot create them.

## Performance report

The §9 report is `docs/performance-report.md`, with the JMeter plans and scripts
in `tests/load/` (how to rerun each experiment: `tests/load/README.md`). In short:
search levels off at about 1,150 requests/s; the Redis cache gives 3.3× at the
property service but the single gateway process caps it end to end; nothing was
lost in the booking, scaling and failure tests; three booking workers drain 1.8×
faster than one (MySQL is the limit).

## Run it

```bash
npm run dev:review
```
```bash
npm run dev:analytics
```
```bash
npm run worker -w services/analytics-service
```
```bash
npm run dev:notify
```
```bash
npm test -w services/review-service -w services/analytics-service -w services/notification-gateway
```

Dashboards: `/dashboards/guest`, `/dashboards/host` and `/dashboards/platform`
(admin) in the client. With the stack running:

```bash
npm run demo:activity
```
```bash
npm run demo:realtime
```
