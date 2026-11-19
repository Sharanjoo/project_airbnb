// Read queries against real MySQL: get, history, pending lookup, byProperty and byGuest.
//   npm run infra:up   then   npm run test:db -w services/booking-service
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { createEnvelope, getMysql, newId } = require('@airbnb/common');
const { handleBookingRequested, bus } = require('../../src/worker');
const repo = require('../../src/models/booking');
const { priceBreakdown } = require('../../src/pricing');

bus.publish = async () => {};

// This file only uses dates in 2029. double-booking.int.js wipes everything from 2030 on,
// and node runs the test files at the same time.
const day = (d) => new Date(Date.UTC(2029, 0, 1) + d * 86400000).toISOString().slice(0, 10);

async function clean() {
  const db = getMysql();
  const [rows] = await db.execute("SELECT reservation_id FROM reservations WHERE check_in >= '2029-01-01' AND check_in < '2030-01-01'");
  for (const { reservation_id: id } of rows) {
    await db.execute('DELETE FROM reservation_status_history WHERE reservation_id = ?', [id]);
    await db.execute('DELETE FROM reservations WHERE reservation_id = ?', [id]);
  }
  await db.execute("DELETE FROM idempotency_keys WHERE idempotency_key LIKE 'reads-int-%'");
}
test.before(clean);

async function book(guestId, checkIn, checkOut) {
  const reservationId = newId('res');
  const env = createEnvelope({
    eventType: 'booking.requested', traceId: randomUUID(), actorId: guestId, actorType: 'guest',
    entityType: 'reservation', entityId: reservationId,
    payload: {
      reservation_id: reservationId, property_id: 'prp_0001', guest_id: guestId, host_id: 'hst_0001',
      check_in: checkIn, check_out: checkOut, guest_count: 2, guest_message: 'hi',
      price_breakdown: priceBreakdown({ nightly_price: 189, cleaning_fee: 40 }, 2),
    },
  });
  await handleBookingRequested(env, { topic: 'booking.requested' });
  return reservationId;
}

test('findReservation + listStatusHistory return the API shape', async () => {
  const id = await book('gst_0001', day(0), day(2));
  const row = await repo.findReservation(id);
  assert.strictEqual(row.status, 'REQUESTED');
  assert.strictEqual(row.check_in, day(0));
  assert.strictEqual(row.price_breakdown.total, 509.96);
  const hist = await repo.listStatusHistory(id);
  assert.strictEqual(hist.length, 1);
  assert.strictEqual(hist[0].to_status, 'REQUESTED');
  assert.match(hist[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.strictEqual(await repo.findReservation('res_missing'), null);
});

test('findPendingReservation finds an accepted request the worker has not written yet, with its owner', async () => {
  const resId = newId('res');
  await repo.saveIdempotentResponse(`reads-int-${randomUUID()}`, {}, 202, { data: { reservation_id: resId, status: 'PENDING' }, trace_id: 'x' }, 'gst_0001');
  assert.deepStrictEqual(await repo.findPendingReservation(resId), { reservation_id: resId, status: 'PENDING', owner_id: 'gst_0001' });
  assert.strictEqual(await repo.findPendingReservation('res_unknown'), null);
});

test('an approve/decline/cancel record is not mistaken for a pending booking', async () => {
  const resId = newId('res');
  await repo.saveIdempotentResponse(`reads-int-${randomUUID()}`, {}, 202, { data: { reservation_id: resId, status: 'APPROVING' }, trace_id: 'x' }, 'hst_0001');
  assert.strictEqual(await repo.findPendingReservation(resId), null);
});

test('listByProperty filters by status and date overlap, and paginates', async () => {
  const a = await book('gst_0001', day(10), day(12));
  const b = await book('gst_0002', day(14), day(16));
  const all = await repo.listByProperty({ propertyId: 'prp_0001', statuses: ['REQUESTED'], from: day(10), to: day(16), page: 1, pageSize: 20 });
  assert.deepStrictEqual(all.rows.map((r) => r.reservation_id).sort(), [a, b].sort());
  assert.strictEqual(all.total, 2);

  // stay b starts on day 14, so a window ending on day 13 only touches stay a
  const early = await repo.listByProperty({ propertyId: 'prp_0001', from: day(10), to: day(13), page: 1, pageSize: 20 });
  assert.deepStrictEqual(early.rows.map((r) => r.reservation_id), [a]);

  // stay a ends on day 12 and that day is not counted, so a window starting on day 12 leaves it out
  const late = await repo.listByProperty({ propertyId: 'prp_0001', from: day(12), to: day(20), page: 1, pageSize: 20 });
  assert.deepStrictEqual(late.rows.map((r) => r.reservation_id), [b]);

  const page = await repo.listByProperty({ propertyId: 'prp_0001', from: day(10), to: day(16), page: 2, pageSize: 1 });
  assert.strictEqual(page.rows.length, 1);
  assert.strictEqual(page.total, 2);

  const none = await repo.listByProperty({ propertyId: 'prp_0001', statuses: ['CANCELLED'], from: day(10), to: day(16), page: 1, pageSize: 20 });
  assert.strictEqual(none.total, 0);
});

test('listByGuest returns only that guest, newest stay first', async () => {
  const early = await book('gst_0002', day(30), day(32));
  const later = await book('gst_0002', day(40), day(42));
  const mine = await repo.listByGuest({ guestId: 'gst_0002', from: day(30), to: day(45), page: 1, pageSize: 20 });
  assert.deepStrictEqual(mine.rows.map((r) => r.reservation_id), [later, early]);
  assert.ok(mine.rows.every((r) => r.property_id === 'prp_0001'));
});

test('findActiveDuplicate: same guest, property and dates while REQUESTED or CONFIRMED; not for CANCELLED or other dates', async () => {
  const id = await book('gst_0001', day(50), day(52));
  assert.strictEqual((await repo.findActiveDuplicate('gst_0001', 'prp_0001', day(50), day(52))).reservation_id, id);
  assert.strictEqual(await repo.findActiveDuplicate('gst_0002', 'prp_0001', day(50), day(52)), null, 'another guest');
  assert.strictEqual(await repo.findActiveDuplicate('gst_0001', 'prp_0002', day(50), day(52)), null, 'another property');
  assert.strictEqual(await repo.findActiveDuplicate('gst_0001', 'prp_0001', day(50), day(53)), null, 'other dates');
  await getMysql().execute("UPDATE reservations SET status = 'CANCELLED' WHERE reservation_id = ?", [id]);
  assert.strictEqual(await repo.findActiveDuplicate('gst_0001', 'prp_0001', day(50), day(52)), null, 'cancelled stays do not count');
});

test('findPropertyOwner', async () => {
  assert.strictEqual((await repo.findPropertyOwner('prp_0001')).host_id, 'hst_0001');
  assert.strictEqual(await repo.findPropertyOwner('prp_nope'), null);
});

test.after(async () => {
  await clean();
  await getMysql().end();
});
