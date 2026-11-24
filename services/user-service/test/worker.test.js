process.env.NODE_ENV = 'test';
// User worker handlers with fakes. Real MySQL (claimEvent, concurrency, recompute)
// is covered in test/integration/counters.int.js.
const test = require('node:test');
const assert = require('node:assert');
const { createEnvelope, processMessage } = require('@airbnb/common');
const { buildHandlers } = require('../src/worker');

// processed_events + guests counters in memory, mimicking claimEvent's PK and a transaction
function fakeDb() {
  const claimed = new Map(); // `${group}|${key}` -> event_id
  const counts = new Map([['gst_0001', { booking_count: 0, saved_properties_count: 0 }]]);
  const saved = new Map([['gst_0001', new Set()]]);
  return {
    claimed,
    counts,
    saved,
    withTransaction: async (fn) => fn({}),
    claimEvent: async (conn, group, env) => {
      const k = `${group}|${env.idempotency_key}`;
      if (claimed.has(k)) return false;
      claimed.set(k, env.event_id);
      return true;
    },
    guests: {
      async incrementBookingCount(conn, guestId) {
        if (!counts.has(guestId)) return false;
        counts.get(guestId).booking_count += 1;
        return true;
      },
      async recomputeSavedCount(guestId) {
        if (!counts.has(guestId)) return null;
        counts.get(guestId).saved_properties_count = saved.get(guestId).size;
        return saved.get(guestId).size;
      },
    },
  };
}

// The exact shapes the producers publish (booking-service worker on slice3/booking-reads, property-service routes on main)
const confirmed = (reservationId, over = {}) => createEnvelope({
  eventType: 'booking.confirmed',
  traceId: '11111111-1111-4111-8111-111111111111',
  actorId: 'svc:booking-worker',
  actorType: 'service',
  entityType: 'reservation',
  entityId: reservationId,
  idempotencyKey: `${reservationId}-approve-key:confirmed`,
  payload: {
    reservation_id: reservationId, property_id: 'prp_0001', guest_id: 'gst_0001', host_id: 'hst_0001',
    check_in: '2030-01-01', check_out: '2030-01-03', previous_status: 'REQUESTED', new_status: 'CONFIRMED', reason: null,
  },
  ...over,
});

const savedEvent = (saved, traceId = '22222222-2222-4222-8222-222222222222') => createEnvelope({
  eventType: 'property.saved',
  traceId,
  actorId: 'gst_0001',
  actorType: 'guest',
  entityType: 'property',
  entityId: 'prp_0001',
  idempotencyKey: `gst_0001:prp_0001:${saved ? 'save' : 'unsave'}:${traceId}`,
  payload: { property_id: 'prp_0001', guest_id: 'gst_0001', saved },
});

const meta = (topic) => ({ topic, partition: 0, offset: '0', attempt: 0 });

test('booking.confirmed: +1 booking for the guest in the payload', async () => {
  const db = fakeDb();
  const h = buildHandlers(db);
  assert.strictEqual(await h['booking.confirmed'](confirmed('res_a'), meta('booking.confirmed')), 'counted');
  assert.strictEqual(db.counts.get('gst_0001').booking_count, 1);
  assert.ok(db.claimed.has('user-cg|booking_count:res_a'), 'claimed per reservation in group user-cg');
});

test('booking.confirmed: redelivery of the same event does not count twice', async () => {
  const db = fakeDb();
  const h = buildHandlers(db);
  const env = confirmed('res_a');
  await h['booking.confirmed'](env, meta('booking.confirmed'));
  assert.strictEqual(await h['booking.confirmed'](env, meta('booking.confirmed')), 'duplicate');
  assert.strictEqual(db.counts.get('gst_0001').booking_count, 1);
});

test('booking.confirmed: a different event for the same reservation (new event_id and key) does not count twice', async () => {
  const db = fakeDb();
  const h = buildHandlers(db);
  await h['booking.confirmed'](confirmed('res_a'), meta('booking.confirmed'));
  const replay = confirmed('res_a', { idempotencyKey: 'some-other-approve:confirmed' });
  assert.strictEqual(await h['booking.confirmed'](replay, meta('booking.confirmed')), 'duplicate');
  assert.strictEqual(db.counts.get('gst_0001').booking_count, 1);
  await h['booking.confirmed'](confirmed('res_b'), meta('booking.confirmed'));
  assert.strictEqual(db.counts.get('gst_0001').booking_count, 2, 'a second reservation counts');
});

test('booking.confirmed: unknown guest is logged, not retried forever', async () => {
  const db = fakeDb();
  const h = buildHandlers(db);
  const env = confirmed('res_x');
  env.payload.guest_id = 'gst_missing';
  assert.strictEqual(await h['booking.confirmed'](env, meta('booking.confirmed')), 'unknown_guest');
});

test('booking.confirmed: payload with another new_status is ignored', async () => {
  const db = fakeDb();
  const env = confirmed('res_a');
  env.payload.new_status = 'CANCELLED';
  assert.strictEqual(await buildHandlers(db)['booking.confirmed'](env, meta('booking.confirmed')), 'ignored');
  assert.strictEqual(db.counts.get('gst_0001').booking_count, 0);
});

test('booking.confirmed / property.saved: missing guest_id or reservation_id -> permanent error -> DLQ, no retries', async () => {
  const db = fakeDb();
  const h = buildHandlers(db);
  const noGuest = confirmed('res_a');
  delete noGuest.payload.guest_id;
  await assert.rejects(h['booking.confirmed'](noGuest, meta('booking.confirmed')), (e) => e.permanent === true);
  const noRes = confirmed('res_a');
  delete noRes.payload.reservation_id;
  await assert.rejects(h['booking.confirmed'](noRes, meta('booking.confirmed')), (e) => e.permanent === true);

  // Through the shared consumer logic: goes to the DLQ on the first attempt
  const dlq = [];
  const calls = [];
  const result = await processMessage({
    topic: 'booking.confirmed', partition: 0, groupId: 'user-cg', maxRetries: 3, baseDelayMs: 1,
    message: { key: Buffer.from('prp_0001'), value: Buffer.from(JSON.stringify(noGuest)), offset: '7' },
    handler: (env, m) => { calls.push(m.attempt); return h['booking.confirmed'](env, m); },
    sendToDlq: async (rec) => { dlq.push(rec); },
  });
  assert.strictEqual(result, 'dlq');
  assert.deepStrictEqual(calls, [0]);
  assert.match(dlq[0].headers.failure_reason, /missing guest_id/);
  assert.strictEqual(db.counts.get('gst_0001').booking_count, 0);
});

test('property.saved: count follows saved_properties for save, unsave and duplicates', async () => {
  const db = fakeDb();
  const h = buildHandlers(db);
  const set = db.saved.get('gst_0001');

  set.add('prp_0001');
  const save = savedEvent(true);
  assert.strictEqual(await h['property.saved'](save, meta('property.saved')), 'recomputed');
  assert.strictEqual(db.counts.get('gst_0001').saved_properties_count, 1);
  await h['property.saved'](save, meta('property.saved')); // redelivery
  assert.strictEqual(db.counts.get('gst_0001').saved_properties_count, 1);

  set.delete('prp_0001');
  await h['property.saved'](savedEvent(false, '33333333-3333-4333-8333-333333333333'), meta('property.saved'));
  assert.strictEqual(db.counts.get('gst_0001').saved_properties_count, 0);
  // The old "save" arriving late (out of order) cannot push the count back up
  await h['property.saved'](save, meta('property.saved'));
  assert.strictEqual(db.counts.get('gst_0001').saved_properties_count, 0);
});

test('property.saved: unknown guest is logged and skipped', async () => {
  const db = fakeDb();
  const env = savedEvent(true);
  env.payload.guest_id = 'gst_missing';
  assert.strictEqual(await buildHandlers(db)['property.saved'](env, meta('property.saved')), 'unknown_guest');
});

test('worker subscribes to exactly booking.confirmed and property.saved', () => {
  assert.deepStrictEqual(Object.keys(buildHandlers(fakeDb())).sort(), ['booking.confirmed', 'property.saved']);
});

// booking_count is a lifetime count of unique confirmed reservations (team decision).
// Same shape as the booking worker's booking.cancelled outcome on slice3/booking-reads.
const cancelled = (reservationId) => createEnvelope({
  eventType: 'booking.cancelled',
  traceId: '44444444-4444-4444-8444-444444444444',
  actorId: 'svc:booking-worker',
  actorType: 'service',
  entityType: 'reservation',
  entityId: reservationId,
  idempotencyKey: `${reservationId}-cancel-key:cancelled`,
  payload: {
    reservation_id: reservationId, property_id: 'prp_0001', guest_id: 'gst_0001', host_id: 'hst_0001',
    check_in: '2030-01-01', check_out: '2030-01-03', previous_status: 'CONFIRMED', new_status: 'CANCELLED', reason: 'plans changed',
  },
});

test('booking_count: cancelling a confirmed booking does not reduce it, and a replay does not re-count it', async () => {
  const db = fakeDb();
  const h = buildHandlers(db);
  const confirm = confirmed('res_a');
  await h['booking.confirmed'](confirm, meta('booking.confirmed'));
  assert.strictEqual(db.counts.get('gst_0001').booking_count, 1);

  // The worker does not subscribe to booking.cancelled at all...
  assert.strictEqual(h['booking.cancelled'], undefined);
  // ...and a cancellation that somehow lands on the confirmed topic is ignored, not subtracted
  assert.strictEqual(await h['booking.confirmed'](cancelled('res_a'), meta('booking.confirmed')), 'ignored');
  assert.strictEqual(db.counts.get('gst_0001').booking_count, 1);

  // Replaying the original confirmation after the cancellation is still a duplicate
  assert.strictEqual(await h['booking.confirmed'](confirm, meta('booking.confirmed')), 'duplicate');
  assert.strictEqual(db.counts.get('gst_0001').booking_count, 1);

  // A new reservation for the same guest still counts: lifetime total 2, one of them cancelled
  await h['booking.confirmed'](confirmed('res_b'), meta('booking.confirmed'));
  assert.strictEqual(db.counts.get('gst_0001').booking_count, 2);
});
