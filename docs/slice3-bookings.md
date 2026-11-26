# Slice 3: bookings and reliability

Owner: Prajeet. Covers the booking API and worker, the scheduler, the booking
pages in the client, and mandatory features 13.1 and 13.2. The integration area
for the demo is envelope validation, idempotency and the dead-letter topic. Each
section gives the chosen design, a rejected alternative and the trade-off, as
section 13.13 of the spec asks.

## What is built

- Booking API: request, get, byProperty, byGuest, approve, decline, cancel.
  Code is in `services/booking-service/src/routes.js`.
- Data access: `src/models/booking.js`. All SQL for reservations, nights, status
  history and idempotency keys lives here.
- Booking worker: `src/worker.js`, consumer group `booking-worker-cg`. It runs as
  its own process, separate from the API.
- Scheduler: `src/scheduler.js`. It runs inside the worker on a timer and expires
  old requests and completes finished stays.
- Rules that depend on time: `src/policy.js` (who can cancel and when) and
  `src/timeutil.js` (check-in at 15:00 and check-out at 11:00 local time).
- Client pages: `client/src/pages/guest/MyBookings.jsx` and
  `client/src/pages/host/HostRequests.jsx`.
- Demos for the report: `scripts/demo-double-booking.js` and
  `scripts/demo-recovery.js`.

## How a booking moves

A guest request becomes REQUESTED when the worker has claimed the nights, or
REJECTED if the nights are taken (DATE_CONFLICT), the host blocked them
(DATE_CONFLICT), or the guest's account was deleted after the API accepted the
request (GUEST_DELETED). The host then
approves (CONFIRMED) or declines (DECLINED). Either side can cancel a REQUESTED
or CONFIRMED booking (CANCELLED). A request nobody answers for 24 hours becomes
EXPIRED. A CONFIRMED stay becomes COMPLETED once check-out time has passed.

Every change writes a row to `reservation_status_history` with who did it and
the trace id, so a reservation can be rebuilt after a restart. Declined,
cancelled and expired bookings free their nights.

The API never writes reservations. It checks the request, publishes an event and
answers 202. The worker is the only thing that changes reservation state.

## 13.1 Double booking

**Chosen design.** The table `reservation_nights` has a unique key on
(property_id, night). The worker inserts the reservation and one row per night in
a single transaction. If two requests race for the same night, MySQL lets one
transaction commit and gives the other a duplicate key error. That one is rolled
back to a savepoint and recorded as REJECTED with DATE_CONFLICT. A deadlock
between two racers is retried (up to 5 times), so a lost race always ends as
REJECTED and never as an error.

**Host blocks.** The worker takes a shared lock on the property row before it
checks the host's blocked dates. Sharan's block code takes the exclusive lock on
the same row. So a booking and a block on one property can never both pass their
checks at the same moment.

**Rejected alternatives.**
- A `SELECT ... FOR UPDATE` range check before inserting. It also works, but it
  locks more rows and only protects code paths that remember to do it.
- Relying on Kafka ordering alone. The key is the property id, so one partition
  handles a property in order, but a host blocking dates is a second writer and
  is not covered.
- A version number on the property row for every booking. It would make all
  bookings for one property wait for each other, even for different dates.

**Trade-off.** The guarantee sits in the database, so it holds even if a code
path is wrong. The cost is that losing requests do real work and then roll back.

**Evidence.** `npm run demo:booking` sends 10 requests for the same two nights
from 10 different guests. It prints one winner and nine DATE_CONFLICT rejections
with every trace id, the night rows in the database, and shows the nights
becoming bookable again after the winner cancels. It also passed with three
workers in the same group. `npm run test:db -w services/booking-service` runs
the same race as an automated test.

## 13.2 Consumer failure and recovery

Kafka keeps the event until a consumer finishes it. The worker turns auto-commit
off and commits the offset only after its handler is done. The handler writes the
database change and an `idempotency_key` row in one transaction.

**Fails before the database write.** The transaction rolls back, and the key row
rolls back with it. The offset is not committed, so the event comes back and is
processed normally. Covered by an integration test that makes the history write
fail once.

**Fails after the database write, before the offset commit.** The event comes
back, the key row is already there, and the handler skips the write. There is
still exactly one reservation. The demo shows this by moving the consumer offset
back by one message: the worker log says the event was seen again, and the
database counts do not change.

**Fails after the commit, before the outcome event is sent.** A plain duplicate
skip would lose the outcome event. So on a duplicate the worker sends the
outcome again, built from the database, with the same idempotency key. Other
consumers ignore the second copy. The scheduler does the same with a stored
"published" marker.

**Consumer down for a while.** The API keeps answering 202 and the events wait in
Kafka. The demo shows the consumer group lag at 1 while the worker is stopped,
and lag 0 after it restarts. Catching up took about 36 seconds in our runs,
mostly because Kafka has to rebalance the group.

**Bad messages.** Malformed JSON, an invalid envelope and permanent errors go
straight to `<topic>.dlq` with the original bytes and headers that say why. Every
consumer group that reads the topic rejects a bad message on its own, so one bad
message gives one record per group in the dead-letter topic. The `consumer_group`
header says who rejected it.

**Service down.** If the booking API is down the gateway answers 503
DEPENDENCY_UNAVAILABLE with retryable true. If Kafka is down the API answers 503
too and does not save the idempotency key, so a retry works. Both are in the
demo and the tests.

**Evidence.** `npm run demo:recovery` runs all of this live and prints Kafka
offsets, database counts and worker log lines.

## Idempotency

- HTTP: booking calls need an `Idempotency-Key` header. The same key with the
  same request returns the first answer. The same key with a different request
  returns 409 IDEMPOTENCY_KEY_REUSED. Keys are kept for 24 hours.
- A key belongs to whoever used it first. Another user sending the same key gets 409
  IDEMPOTENCY_KEY_REUSED. A retry with the same key is answered from the stored
  record before the date check, so it still works after midnight UTC.
- The reservation id is built from the key, so two simultaneous calls with the
  same key get the same id and the worker applies it once. It also lets a pending
  booking be found by primary key, with no table scan.
- Kafka: the worker stores (consumer group, idempotency key) in the same
  transaction as its change.
- A guest asking again for the same property and dates while the first request is
  still active gets 409 DUPLICATE_BOOKING.

## Where we went beyond the API doc

The doc comes first. These are the places it says nothing:

- Check-in is 15:00 and check-out is 11:00 in the listing's time zone
  (`America/Los_Angeles`, set with `BOOKING_TIMEZONE`). The 24 hour cancel window,
  expiry and completion use these times. The doc's own date rule
  (`check_in` today or later, in UTC) stays in UTC.
- A pending booking can only be read by the guest who asked for it. The doc says
  only people on the booking can read it, and the owner is stored in
  `idempotency_keys.actor_id`.
- A decline publishes `booking.rejected` with `new_status` DECLINED. The property
  worker clears its search cache on that event.
- Confirming a booking publishes a simulated `payment.completed`.
- `byGuest` also returns `property_title` and `city` so the trips page can show
  names without counting a listing view.
- A request from a guest whose account was deleted in the meantime is rejected
  with GUEST_DELETED. The worker reads the guest's row with a shared lock, and the
  user service takes the exclusive lock on that row when it deletes, so a delete
  and a new booking cannot pass each other. A guest id that does not exist at all
  is a permanent error and goes to the dead-letter topic.

## Database change

`idempotency_keys` has one extra column, `actor_id VARCHAR(40) NULL`, which stores
who made the request. It is how a booking that is still pending stays private to
the guest who asked. New databases get it from `infra/mysql/init/001_schema.sql`.
A database created before this change is upgraded by the booking services the
first time they need it, so nobody has to reset anything. To add it by hand:

```sql
ALTER TABLE idempotency_keys ADD COLUMN actor_id VARCHAR(40) NULL;
```

## Limits

- One time zone for the whole platform. A zone per listing would need a column on
  the properties table.
- Retries inside the consumer run in memory (3 tries, then the dead-letter
  topic), which is what section 10 of the API doc describes.
- The review form on My trips depends on the review service.
- New requests reach the host's page through the notification gateway, which
  pushes `booking.requested` to the host. The page also checks every 15 seconds in
  case a push is missed.

## Run it

```bash
npm run infra:up
npm test -w services/booking-service           # unit tests, no database needed
npm run test:db -w services/booking-service    # real MySQL: races, redelivery, scheduler
docker compose up -d --build
npm run demo:booking                           # 13.1 with evidence
npm run demo:recovery                          # 13.2 with evidence
```
