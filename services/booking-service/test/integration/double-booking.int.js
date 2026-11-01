// Integration test against real MySQL (13.1 and 13.2 evidence).
// Needs the schema loaded:  npm run infra:up   then   npm run test:db -w services/booking-service
// Kafka is stubbed; this test is about the database guarantee.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { createEnvelope, getMysql, newId } = require('@airbnb/common');
const { handleBookingRequested, bus } = require('../../src/worker');
const { priceBreakdown } = require('../../src/pricing');

const published = [];
bus.publish = async (topic, env) => published.push({ topic, env });

// Test-only date range (2030+), wiped before each run so reruns are deterministic
const day = (d) => new Date(Date.UTC(2030, 0, 1) + d * 86400000).toISOString().slice(0, 10);

async function cleanTestRange() {
  const db = getMysql();
  const [rows] = await db.execute("SELECT reservation_id FROM reservations WHERE check_in >= '2030-01-01'");
  for (const { reservation_id: id } of rows) {
    await db.execute('DELETE FROM reservation_status_history WHERE reservation_id = ?', [id]);
    await db.execute('DELETE FROM reservations WHERE reservation_id = ?', [id]); // nights cascade
  }
}

test.before(cleanTestRange);

function requestEvent(guestId, checkIn, checkOut) {
  const reservationId = newId('res');
  return createEnvelope({
    eventType: 'booking.requested', traceId: randomUUID(), actorId: guestId, actorType: 'guest',
    entityType: 'reservation', entityId: reservationId,
    payload: {
      reservation_id: reservationId, property_id: 'prp_0001', guest_id: guestId, host_id: 'hst_0001',
      check_in: checkIn, check_out: checkOut, guest_count: 2, guest_message: null,
      price_breakdown: priceBreakdown({ nightly_price: 189, cleaning_fee: 40 }, 2),
    },
  });
}

const statusOf = async (id) => (await getMysql().execute('SELECT status FROM reservations WHERE reservation_id = ?', [id]))[0][0]?.status;

test('10 concurrent requests for the same nights -> exactly one REQUESTED', async () => {
  const events = Array.from({ length: 10 }, (_, i) => requestEvent(i % 2 ? 'gst_0001' : 'gst_0002', day(0), day(2)));
  await Promise.all(events.map((e) => handleBookingRequested(e, { topic: 'booking.requested' })));

  const statuses = await Promise.all(events.map((e) => statusOf(e.payload.reservation_id)));
  assert.strictEqual(statuses.filter((s) => s === 'REQUESTED').length, 1, `statuses: ${statuses}`);
  assert.strictEqual(statuses.filter((s) => s === 'REJECTED').length, 9);

  const [nights] = await getMysql().execute(
    'SELECT COUNT(*) AS n FROM reservation_nights WHERE property_id = ? AND night IN (?, ?)', ['prp_0001', day(0), day(1)]);
  assert.strictEqual(Number(nights[0].n), 2);
  assert.strictEqual(published.filter((p) => p.topic === 'booking.rejected').length, 9);
});

test('same event delivered twice -> one reservation, second delivery skipped', async () => {
  const e = requestEvent('gst_0001', day(10), day(12));
  await handleBookingRequested(e, { topic: 'booking.requested' });
  await handleBookingRequested(e, { topic: 'booking.requested' }); // redelivery after a crash

  const [rows] = await getMysql().execute('SELECT COUNT(*) AS n FROM reservations WHERE reservation_id = ?', [e.payload.reservation_id]);
  assert.strictEqual(Number(rows[0].n), 1);
  const [hist] = await getMysql().execute('SELECT COUNT(*) AS n FROM reservation_status_history WHERE reservation_id = ?', [e.payload.reservation_id]);
  assert.strictEqual(Number(hist[0].n), 1);
});

test('back-to-back stays sharing a checkout/checkin day both succeed', async () => {
  const a = requestEvent('gst_0001', day(20), day(22));
  const b = requestEvent('gst_0002', day(22), day(24));
  await handleBookingRequested(a, { topic: 'booking.requested' });
  await handleBookingRequested(b, { topic: 'booking.requested' });
  assert.strictEqual(await statusOf(a.payload.reservation_id), 'REQUESTED');
  assert.strictEqual(await statusOf(b.payload.reservation_id), 'REQUESTED');
});

test.after(async () => {
  await cleanTestRange();
  await getMysql().end();
});
