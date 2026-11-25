// Worker tests against real MySQL: approve, decline, cancel, host-blocked dates,
// duplicate delivery and rebooking nights that were freed. Kafka is replaced by a stub.
//   npm run infra:up   then   npm run test:db -w services/booking-service
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { createEnvelope, getMysql, newId } = require('@airbnb/common');
const worker = require('../../src/worker');
const repo = require('../../src/models/booking');
const { priceBreakdown } = require('../../src/pricing');

const published = [];
worker.bus.publish = async (topic, env, key) => published.push({ topic, env, key });
const sent = (topic) => published.filter((p) => p.topic === topic);

// This file only uses dates in 2028. The other files use 2029 and 2030 on, and node runs them at the same time.
const day = (d) => new Date(Date.UTC(2028, 0, 1) + d * 86400000).toISOString().slice(0, 10);
const db = () => getMysql();

async function clean() {
  const [rows] = await db().execute("SELECT reservation_id FROM reservations WHERE check_in >= '2028-01-01' AND check_in < '2029-01-01'");
  for (const { reservation_id: id } of rows) {
    await db().execute('DELETE FROM reservation_status_history WHERE reservation_id = ?', [id]);
    await db().execute('DELETE FROM reservations WHERE reservation_id = ?', [id]);
  }
  await db().execute("DELETE FROM availability_blocks WHERE start_date >= '2028-01-01' AND start_date < '2029-01-01'");
  await db().execute("DELETE FROM guests WHERE guest_id LIKE 'gst_deltest%'");
}
test.before(clean);
test.beforeEach(() => { published.length = 0; });

const META = (topic) => ({ topic });

function requestedEvent(guestId, checkIn, checkOut, propertyId = 'prp_0001', hostId = 'hst_0001') {
  const reservationId = newId('res');
  return createEnvelope({
    eventType: 'booking.requested', traceId: randomUUID(), actorId: guestId, actorType: 'guest',
    entityType: 'reservation', entityId: reservationId,
    payload: {
      reservation_id: reservationId, property_id: propertyId, guest_id: guestId, host_id: hostId,
      check_in: checkIn, check_out: checkOut, guest_count: 2, guest_message: null,
      price_breakdown: priceBreakdown({ nightly_price: 189, cleaning_fee: 40 }, 2),
    },
  });
}

/** A command event as the Booking API publishes it. */
function command(eventType, reservationId, actorId, actorType, payload) {
  return createEnvelope({
    eventType, traceId: randomUUID(), actorId, actorType,
    entityType: 'reservation', entityId: reservationId, payload: { reservation_id: reservationId, ...payload },
  });
}
const approve = (id, host = 'hst_0001') => command('booking.approved', id, host, 'host', { host_id: host });
const decline = (id, reason = 'Maintenance', host = 'hst_0001') => command('booking.declined', id, host, 'host', { host_id: host, reason });
const cancel = (id, by, type, reason = 'Plans changed') => command('booking.cancel_requested', id, by, type, { requested_by: by, cancellation_reason: reason });

async function reserve(guestId, checkIn, checkOut) {
  const e = requestedEvent(guestId, checkIn, checkOut);
  await worker.handleBookingRequested(e, META('booking.requested'));
  return e.payload.reservation_id;
}
const statusOf = async (id) => (await repo.findReservation(id))?.status;
const nightsOf = async (id) => Number((await db().execute('SELECT COUNT(*) AS n FROM reservation_nights WHERE reservation_id = ?', [id]))[0][0].n);
const historyOf = async (id) => (await repo.listStatusHistory(id)).map((h) => `${h.from_status}>${h.to_status}`);

// approve

test('approve: moves REQUESTED to CONFIRMED, writes history, sends booking.confirmed with property_id and a simulated payment', async () => {
  const id = await reserve('gst_0001', day(0), day(2));
  published.length = 0;
  const env = approve(id);
  assert.strictEqual(await worker.handleTransition(env, META('booking.approved')), 'applied');

  assert.strictEqual(await statusOf(id), 'CONFIRMED');
  assert.strictEqual(await nightsOf(id), 2, 'confirmed stays keep their nights');
  assert.deepStrictEqual(await historyOf(id), ['null>REQUESTED', 'REQUESTED>CONFIRMED']);

  const [confirmed] = sent('booking.confirmed');
  assert.strictEqual(confirmed.key, 'prp_0001');
  assert.strictEqual(confirmed.env.trace_id, env.trace_id, 'trace_id carried through');
  assert.deepStrictEqual(
    { property_id: confirmed.env.payload.property_id, host_id: confirmed.env.payload.host_id, guest_id: confirmed.env.payload.guest_id,
      previous_status: confirmed.env.payload.previous_status, new_status: confirmed.env.payload.new_status },
    { property_id: 'prp_0001', host_id: 'hst_0001', guest_id: 'gst_0001', previous_status: 'REQUESTED', new_status: 'CONFIRMED' },
  );
  const [payment] = sent('payment.completed');
  assert.strictEqual(payment.env.payload.amount, 509.96);
  assert.strictEqual(payment.env.payload.method, 'simulated');
});

test('approve delivered twice (crash after the DB write, before the publish): one transition, outcome re-sent', async () => {
  const id = await reserve('gst_0001', day(10), day(12));
  const env = approve(id);
  await worker.handleTransition(env, META('booking.approved'));
  const first = sent('booking.confirmed')[0];
  published.length = 0;

  assert.strictEqual(await worker.handleTransition(env, META('booking.approved')), 'duplicate');
  assert.deepStrictEqual(await historyOf(id), ['null>REQUESTED', 'REQUESTED>CONFIRMED'], 'no second history row');
  const resent = sent('booking.confirmed')[0];
  assert.ok(resent, 'the outcome is published again so it cannot be lost');
  assert.strictEqual(resent.env.idempotency_key, first.env.idempotency_key, 'same idempotency_key lets consumers dedupe');
  assert.strictEqual(resent.env.payload.previous_status, 'REQUESTED');
});

test('a failure before the commit leaves no trace, so the redelivery is processed normally (13.2)', async () => {
  const id = await reserve('gst_0001', day(14), day(16));
  const env = approve(id);
  const original = repo.recordStatus;
  repo.recordStatus = async () => { throw new Error('simulated crash mid-transaction'); };
  try {
    await assert.rejects(worker.handleTransition(env, META('booking.approved')), /simulated crash/);
  } finally { repo.recordStatus = original; }

  assert.strictEqual(await statusOf(id), 'REQUESTED', 'rolled back');
  const [claimed] = await db().execute('SELECT 1 FROM processed_events WHERE consumer_group = ? AND idempotency_key = ?', ['booking-worker-cg', env.idempotency_key]);
  assert.strictEqual(claimed.length, 0, 'the claim rolled back with it');

  assert.strictEqual(await worker.handleTransition(env, META('booking.approved')), 'applied');
  assert.strictEqual(await statusOf(id), 'CONFIRMED');
});

test('approving a reservation that was cancelled meanwhile is ignored: no status change, no events', async () => {
  const id = await reserve('gst_0001', day(18), day(20));
  await worker.handleTransition(cancel(id, 'gst_0001', 'guest'), META('booking.cancel_requested'));
  published.length = 0;

  assert.strictEqual(await worker.handleTransition(approve(id), META('booking.approved')), 'ignored');
  assert.strictEqual(await statusOf(id), 'CANCELLED');
  assert.strictEqual(published.length, 0);
});

test('approve from a host who does not own the reservation is a permanent error (goes to the DLQ)', async () => {
  const id = await reserve('gst_0001', day(22), day(24));
  await assert.rejects(
    worker.handleTransition(approve(id, 'hst_0002'), META('booking.approved')),
    (err) => err.permanent === true,
  );
  assert.strictEqual(await statusOf(id), 'REQUESTED');
});

test('an event for a reservation that does not exist is a permanent error', async () => {
  await assert.rejects(
    worker.handleTransition(approve('res_does_not_exist'), META('booking.approved')),
    (err) => err.permanent === true,
  );
});

// decline

test('decline: DECLINED, reason stored, nights released, booking.rejected(new_status DECLINED); dates can be booked again', async () => {
  const id = await reserve('gst_0001', day(30), day(32));
  published.length = 0;
  assert.strictEqual(await worker.handleTransition(decline(id, 'Property under maintenance'), META('booking.declined')), 'applied');

  const row = await repo.findReservation(id);
  assert.strictEqual(row.status, 'DECLINED');
  assert.strictEqual(row.cancellation_reason, 'Property under maintenance');
  assert.strictEqual(await nightsOf(id), 0);
  assert.deepStrictEqual(await historyOf(id), ['null>REQUESTED', 'REQUESTED>DECLINED']);
  const [out] = sent('booking.rejected');
  assert.strictEqual(out.env.payload.new_status, 'DECLINED');
  assert.strictEqual(out.env.payload.reason, 'Property under maintenance');
  assert.strictEqual(out.env.payload.property_id, 'prp_0001');

  const other = await reserve('gst_0002', day(30), day(32));
  assert.strictEqual(await statusOf(other), 'REQUESTED', 'the released nights are bookable again');
});

test('a confirmed reservation cannot be declined', async () => {
  const id = await reserve('gst_0001', day(34), day(36));
  await worker.handleTransition(approve(id), META('booking.approved'));
  assert.strictEqual(await worker.handleTransition(decline(id), META('booking.declined')), 'ignored');
  assert.strictEqual(await statusOf(id), 'CONFIRMED');
});

// cancel

test('guest cancels a CONFIRMED stay: CANCELLED, nights released, booking.cancelled with property_id', async () => {
  const id = await reserve('gst_0001', day(40), day(42));
  await worker.handleTransition(approve(id), META('booking.approved'));
  published.length = 0;

  assert.strictEqual(await worker.handleTransition(cancel(id, 'gst_0001', 'guest', 'Trip dates changed'), META('booking.cancel_requested')), 'applied');
  const row = await repo.findReservation(id);
  assert.strictEqual(row.status, 'CANCELLED');
  assert.strictEqual(row.cancellation_reason, 'Trip dates changed');
  assert.strictEqual(await nightsOf(id), 0);
  assert.deepStrictEqual(await historyOf(id), ['null>REQUESTED', 'REQUESTED>CONFIRMED', 'CONFIRMED>CANCELLED']);
  const [out] = sent('booking.cancelled');
  assert.strictEqual(out.env.payload.property_id, 'prp_0001');
  assert.strictEqual(out.env.payload.previous_status, 'CONFIRMED');
  assert.strictEqual(out.env.payload.new_status, 'CANCELLED');
  assert.strictEqual(out.env.actor_id, 'svc:booking-worker');

  const [hist] = await db().execute("SELECT actor_id FROM reservation_status_history WHERE reservation_id = ? AND to_status = 'CANCELLED'", [id]);
  assert.strictEqual(hist[0].actor_id, 'gst_0001', 'history records who cancelled');
});

test('host cancels a REQUESTED stay; cancelling twice only does it once', async () => {
  const id = await reserve('gst_0001', day(44), day(46));
  const env = cancel(id, 'hst_0001', 'host', 'Burst pipe');
  assert.strictEqual(await worker.handleTransition(env, META('booking.cancel_requested')), 'applied');
  assert.strictEqual(await worker.handleTransition(cancel(id, 'gst_0001', 'guest'), META('booking.cancel_requested')), 'ignored');
  assert.deepStrictEqual(await historyOf(id), ['null>REQUESTED', 'REQUESTED>CANCELLED']);
});

test('cancel: a stranger claiming to cancel is refused', async () => {
  const id = await reserve('gst_0001', day(48), day(50));
  await assert.rejects(
    worker.handleTransition(cancel(id, 'gst_0002', 'guest'), META('booking.cancel_requested')),
    (err) => err.permanent === true,
  );
  assert.strictEqual(await statusOf(id), 'REQUESTED');
});

test('13.1 after a cancel: ten concurrent requests for the freed nights give exactly one winner', async () => {
  const id = await reserve('gst_0001', day(60), day(62));
  await worker.handleTransition(cancel(id, 'gst_0001', 'guest'), META('booking.cancel_requested'));
  const events = Array.from({ length: 10 }, (_, i) => requestedEvent(i % 2 ? 'gst_0001' : 'gst_0002', day(60), day(62)));
  await Promise.all(events.map((e) => worker.handleBookingRequested(e, META('booking.requested'))));
  const statuses = await Promise.all(events.map((e) => statusOf(e.payload.reservation_id)));
  assert.strictEqual(statuses.filter((s) => s === 'REQUESTED').length, 1, `statuses: ${statuses}`);
  assert.strictEqual(statuses.filter((s) => s === 'REJECTED').length, 9);
});

// host blocked dates

async function block(start, end) {
  await db().execute(
    "INSERT INTO availability_blocks (availability_id, property_id, start_date, end_date, status, source) VALUES (?, 'prp_0001', ?, ?, 'blocked', 'host')",
    [newId('avl'), start, end],
  );
}

test('a request that overlaps dates the host blocked is REJECTED with DATE_CONFLICT and claims no nights', async () => {
  await block(day(70), day(73));
  for (const [a, b] of [[day(69), day(71)], [day(71), day(72)], [day(72), day(75)], [day(68), day(76)]]) {
    published.length = 0;
    const e = requestedEvent('gst_0001', a, b);
    await worker.handleBookingRequested(e, META('booking.requested'));
    const id = e.payload.reservation_id;
    assert.strictEqual(await statusOf(id), 'REJECTED', `${a}..${b}`);
    assert.strictEqual(await nightsOf(id), 0);
    assert.strictEqual(sent('booking.rejected')[0].env.payload.reason, 'DATE_CONFLICT');
  }
});

test('stays that only touch a blocked range (check-out on the first blocked day, check-in on the day after the last) are fine', async () => {
  await block(day(80), day(82)); // nights 80 and 81 are blocked
  const before = await reserve('gst_0001', day(78), day(80));
  const after = await reserve('gst_0002', day(82), day(84));
  assert.strictEqual(await statusOf(before), 'REQUESTED');
  assert.strictEqual(await statusOf(after), 'REQUESTED');
});

test('a duplicate delivery of a rejected request re-sends booking.rejected and writes nothing new', async () => {
  await block(day(90), day(92));
  const e = requestedEvent('gst_0001', day(90), day(92));
  await worker.handleBookingRequested(e, META('booking.requested'));
  const id = e.payload.reservation_id;
  published.length = 0;
  await worker.handleBookingRequested(e, META('booking.requested'));
  assert.strictEqual(sent('booking.rejected').length, 1);
  assert.deepStrictEqual(await historyOf(id), ['null>REJECTED']);
});

// guests whose account is gone

async function makeGuest(isDeleted) {
  const id = `gst_deltest${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await db().execute(
    'INSERT INTO guests (guest_id, first_name, last_name, email, password_hash, is_deleted) VALUES (?, ?, ?, ?, ?, ?)',
    [id, 'Test', 'Guest', `${id}@test.invalid`, 'not-a-real-hash', isDeleted],
  );
  return id;
}

test('a request from a guest who was deleted after the API accepted it is REJECTED with GUEST_DELETED and claims no nights', async () => {
  const guestId = await makeGuest(true);
  const e = requestedEvent(guestId, day(95), day(97));
  await worker.handleBookingRequested(e, META('booking.requested'));
  const id = e.payload.reservation_id;

  const row = await repo.findReservation(id);
  assert.strictEqual(row.status, 'REJECTED');
  assert.strictEqual(row.cancellation_reason, 'GUEST_DELETED');
  assert.strictEqual(await nightsOf(id), 0);
  assert.strictEqual(sent('booking.rejected')[0].env.payload.reason, 'GUEST_DELETED');
  assert.deepStrictEqual(await historyOf(id), ['null>REJECTED']);

  const other = await reserve('gst_0001', day(95), day(97));
  assert.strictEqual(await statusOf(other), 'REQUESTED', 'the dates stay free for someone else');
});

test('a delete that is still in progress holds the request back, then the request is rejected', async () => {
  const guestId = await makeGuest(false);
  const deleting = await db().getConnection();
  await deleting.beginTransaction();
  await deleting.execute('UPDATE guests SET is_deleted = TRUE WHERE guest_id = ?', [guestId]); // the delete holds the row

  const e = requestedEvent(guestId, day(110), day(112));
  let finished = false;
  const running = worker.handleBookingRequested(e, META('booking.requested')).then(() => { finished = true; });
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(finished, false, 'the worker waits for the delete to finish');

  await deleting.commit();
  deleting.release();
  await running;
  const row = await repo.findReservation(e.payload.reservation_id);
  assert.strictEqual(row.status, 'REJECTED');
  assert.strictEqual(row.cancellation_reason, 'GUEST_DELETED');
});

test('a request from a guest who is not deleted is processed as usual', async () => {
  const guestId = await makeGuest(false);
  const e = requestedEvent(guestId, day(100), day(102));
  await worker.handleBookingRequested(e, META('booking.requested'));
  assert.strictEqual(await statusOf(e.payload.reservation_id), 'REQUESTED');
});

test('a request from a guest who does not exist is a permanent error (goes to the dead-letter topic)', async () => {
  const e = requestedEvent('gst_nobody_here', day(105), day(107));
  await assert.rejects(worker.handleBookingRequested(e, META('booking.requested')), (err) => err.permanent === true);
  assert.strictEqual(await statusOf(e.payload.reservation_id), undefined, 'nothing was written');
  const [claimed] = await db().execute('SELECT 1 FROM processed_events WHERE consumer_group = ? AND idempotency_key = ?', ['booking-worker-cg', e.idempotency_key]);
  assert.strictEqual(claimed.length, 0, 'the claim rolled back too, so a redelivery is not skipped');
});

test.after(async () => {
  await clean();
  await getMysql().end();
});
