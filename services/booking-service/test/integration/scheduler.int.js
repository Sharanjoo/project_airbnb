// Scheduler tests against real MySQL: expiring after 24 hours, completing after check-out,
// announcements that survive a Kafka outage, and several schedulers running at once.
//   npm run infra:up   then   npm run test:db -w services/booking-service
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { createEnvelope, getMysql, newId } = require('@airbnb/common');
const worker = require('../../src/worker');
const scheduler = require('../../src/scheduler');
const repo = require('../../src/models/booking');
const { priceBreakdown } = require('../../src/pricing');
const { localDate, checkInInstant, checkOutInstant } = require('../../src/timeutil');

const db = () => getMysql();
const PROPERTY = 'prp_0002'; // the other integration files use prp_0001
// Dates on the listing's clock (America/Los_Angeles), the same one the scheduler uses.
const day = (offset) => localDate(Date.now() + offset * 86400000);

let published = [];
let failPublish = false;
const bus = {
  publish: async (topic, env, key) => {
    if (failPublish) throw new Error('broker down');
    published.push({ topic, env, key });
  },
};
worker.bus.publish = async () => {}; // this file does not look at the worker's own events
const sentFor = (id, topic) => published.filter((p) => p.topic === topic && p.env.payload.reservation_id === id);

const created = [];
async function clean() {
  for (const id of created) {
    await db().execute('DELETE FROM reservation_status_history WHERE reservation_id = ?', [id]);
    await db().execute('DELETE FROM reservations WHERE reservation_id = ?', [id]);
    await db().execute('DELETE FROM processed_events WHERE consumer_group = ? AND idempotency_key LIKE ?', [repo.SCHEDULER_GROUP, `%:${id}`]);
  }
}
test.beforeEach(() => { published = []; failPublish = false; });

async function reserve(checkIn, checkOut, { hoursOld = 0 } = {}) {
  const reservationId = newId('res');
  created.push(reservationId);
  await worker.handleBookingRequested(createEnvelope({
    eventType: 'booking.requested', traceId: randomUUID(), actorId: 'gst_0001', actorType: 'guest',
    entityType: 'reservation', entityId: reservationId,
    payload: {
      reservation_id: reservationId, property_id: PROPERTY, guest_id: 'gst_0001', host_id: 'hst_0001',
      check_in: checkIn, check_out: checkOut, guest_count: 2, guest_message: null,
      price_breakdown: priceBreakdown({ nightly_price: 229, cleaning_fee: 60 }, 2),
    },
  }), { topic: 'booking.requested' });
  if (hoursOld) await db().execute('UPDATE reservations SET booking_datetime = NOW(3) - INTERVAL ? HOUR WHERE reservation_id = ?', [hoursOld, reservationId]);
  return reservationId;
}
const approve = (id) => worker.handleTransition(createEnvelope({
  eventType: 'booking.approved', traceId: randomUUID(), actorId: 'hst_0001', actorType: 'host',
  entityType: 'reservation', entityId: id, payload: { reservation_id: id, host_id: 'hst_0001' },
}), { topic: 'booking.approved' });

const statusOf = async (id) => (await repo.findReservation(id))?.status;
const nightsOf = async (id) => Number((await db().execute('SELECT COUNT(*) AS n FROM reservation_nights WHERE reservation_id = ?', [id]))[0][0].n);
const historyOf = async (id) => (await repo.listStatusHistory(id)).map((h) => `${h.from_status}>${h.to_status}`);
const markerOf = async (status, id) => (await db().execute(
  'SELECT 1 FROM processed_events WHERE consumer_group = ? AND idempotency_key = ?', [repo.SCHEDULER_GROUP, `published:${status}:${id}`]))[0].length;

// expiring

test('a request with no host action for 25 h expires, frees its nights and announces booking.cancelled(EXPIRED)', async () => {
  const stale = await reserve(day(30), day(32), { hoursOld: 25 });
  const fresh = await reserve(day(40), day(42), { hoursOld: 1 });
  assert.strictEqual(await nightsOf(stale), 2);

  const result = await scheduler.runOnce(bus);
  assert.ok(result.expired >= 1);

  assert.strictEqual(await statusOf(stale), 'EXPIRED');
  assert.strictEqual(await nightsOf(stale), 0);
  assert.strictEqual((await repo.findReservation(stale)).cancellation_reason, 'NO_HOST_RESPONSE');
  assert.deepStrictEqual(await historyOf(stale), ['null>REQUESTED', 'REQUESTED>EXPIRED']);
  const [h] = (await db().execute("SELECT actor_id FROM reservation_status_history WHERE reservation_id = ? AND to_status = 'EXPIRED'", [stale]))[0];
  assert.strictEqual(h.actor_id, 'svc:booking-scheduler');

  const [out] = sentFor(stale, 'booking.cancelled');
  assert.strictEqual(out.key, PROPERTY);
  assert.strictEqual(out.env.payload.property_id, PROPERTY);
  assert.strictEqual(out.env.payload.previous_status, 'REQUESTED');
  assert.strictEqual(out.env.payload.new_status, 'EXPIRED');
  assert.strictEqual(out.env.trace_id, (await repo.findReservation(stale)).trace_id, 'the original request trace continues');
  assert.strictEqual(await markerOf('EXPIRED', stale), 1);

  assert.strictEqual(await statusOf(fresh), 'REQUESTED', 'a recent request is left alone');
  assert.strictEqual(await nightsOf(fresh), 2);
});

test('a pending request expires when check-in time (15:00 local) arrives, not before', async () => {
  const checkIn = day(0);
  const id = await reserve(checkIn, day(2));
  await scheduler.runOnce(bus, checkInInstant(checkIn) - 3600000); // 14:00 on check-in day
  assert.strictEqual(await statusOf(id), 'REQUESTED', 'still has until 15:00');
  await scheduler.runOnce(bus, checkInInstant(checkIn) + 60000); // 15:01
  assert.strictEqual(await statusOf(id), 'EXPIRED');
  assert.strictEqual(await nightsOf(id), 0);
});

test('a host who approved in time keeps the booking: the scheduler never expires a CONFIRMED stay', async () => {
  const id = await reserve(day(50), day(52), { hoursOld: 30 });
  await approve(id);
  await scheduler.runOnce(bus);
  assert.strictEqual(await statusOf(id), 'CONFIRMED');
  assert.strictEqual(await nightsOf(id), 2);
});

// completing

test('a confirmed stay whose check-out day has arrived becomes COMPLETED and announces booking.completed once', async () => {
  const id = await reserve(day(-5), day(-3));
  await approve(id);
  assert.strictEqual(await statusOf(id), 'CONFIRMED');

  await scheduler.runOnce(bus);
  assert.strictEqual(await statusOf(id), 'COMPLETED');
  assert.deepStrictEqual(await historyOf(id), ['null>REQUESTED', 'REQUESTED>CONFIRMED', 'CONFIRMED>COMPLETED']);
  const [out] = sentFor(id, 'booking.completed');
  assert.deepStrictEqual(
    { r: out.env.payload.reservation_id, p: out.env.payload.property_id, g: out.env.payload.guest_id, h: out.env.payload.host_id },
    { r: id, p: PROPERTY, g: 'gst_0001', h: 'hst_0001' },
  );
  assert.strictEqual(out.env.idempotency_key, `completed:${id}`);
  assert.strictEqual(await markerOf('COMPLETED', id), 1);

  published = [];
  await scheduler.runOnce(bus);
  assert.strictEqual(sentFor(id, 'booking.completed').length, 0, 'announced once, not on every pass');
});

test('a stay completes at check-out time (11:00 local) on its last day, not before; a stay still in progress does not', async () => {
  const checkOut = day(0);
  const ends = await reserve(day(-2), checkOut);
  const ongoing = await reserve(day(0), day(2));
  await approve(ends);
  await approve(ongoing);

  await scheduler.runOnce(bus, checkOutInstant(checkOut) - 3600000); // 10:00 on check-out day
  assert.strictEqual(await statusOf(ends), 'CONFIRMED', 'the guest is still entitled to the room until 11:00');
  await scheduler.runOnce(bus, checkOutInstant(checkOut) + 3600000); // 12:00
  assert.strictEqual(await statusOf(ends), 'COMPLETED');
  assert.strictEqual(await statusOf(ongoing), 'CONFIRMED');
});

// crashes and outages

test('Kafka down during the announcement: the status is saved, nothing is lost, the next pass announces it', async () => {
  const id = await reserve(day(-8), day(-6));
  await approve(id);

  failPublish = true;
  const down = await scheduler.runOnce(bus);
  assert.ok(down.failed >= 1);
  assert.strictEqual(await statusOf(id), 'COMPLETED', 'the database change is not undone');
  assert.strictEqual(await markerOf('COMPLETED', id), 0, 'no marker, so it will be retried');
  assert.strictEqual(sentFor(id, 'booking.completed').length, 0);

  failPublish = false;
  await scheduler.runOnce(bus);
  assert.strictEqual(sentFor(id, 'booking.completed').length, 1);
  assert.strictEqual(await markerOf('COMPLETED', id), 1);
});

test('three schedulers at the same moment: each change happens exactly once', async () => {
  const stale = await reserve(day(60), day(62), { hoursOld: 26 });
  const done = await reserve(day(-10), day(-9));
  await approve(done);

  await Promise.all([scheduler.runOnce(bus), scheduler.runOnce(bus), scheduler.runOnce(bus)]);
  assert.deepStrictEqual(await historyOf(stale), ['null>REQUESTED', 'REQUESTED>EXPIRED']);
  assert.deepStrictEqual(await historyOf(done), ['null>REQUESTED', 'REQUESTED>CONFIRMED', 'CONFIRMED>COMPLETED']);
  // racing schedulers may send an announcement more than once, but it always has the same key
  const keys = new Set(sentFor(stale, 'booking.cancelled').map((p) => p.env.idempotency_key));
  assert.strictEqual(keys.size, 1);
});

test('expired nights can be booked by someone else', async () => {
  const stale = await reserve(day(70), day(72), { hoursOld: 25 });
  await scheduler.runOnce(bus);
  assert.strictEqual(await statusOf(stale), 'EXPIRED');
  const other = await reserve(day(70), day(72));
  assert.strictEqual(await statusOf(other), 'REQUESTED');
});

test.after(async () => {
  await clean();
  await getMysql().end();
});
