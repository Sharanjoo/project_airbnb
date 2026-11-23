// User worker handlers against the real MySQL: claimEvent idempotency, concurrent
// redeliveries, and saved counts recomputed from saved_properties.
//   npm run infra:up   then   npm run test:db -w services/user-service
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { getMysql, newId, createEnvelope } = require('@airbnb/common');
const { buildHandlers, GROUP } = require('../../src/worker');

const RUN = Date.now();
const db = () => getMysql();
const handlers = buildHandlers();
const guestIds = [];
const reservationIds = [];

async function newGuest() {
  const id = newId('gst');
  guestIds.push(id);
  await db().execute(
    'INSERT INTO guests (guest_id, first_name, last_name, email, password_hash) VALUES (?, ?, ?, ?, ?)',
    [id, 'Counter', 'Test', `${id}@ctr-${RUN}.example.com`, 'x'],
  );
  return id;
}

const counts = async (guestId) => {
  const [[row]] = await db().execute('SELECT booking_count, saved_properties_count, version FROM guests WHERE guest_id = ?', [guestId]);
  return { ...row };
};

// Same shape as the booking worker's outcome event (slice3/booking-reads)
function confirmed(guestId, reservationId = newId('res'), idempotencyKey = `${randomKey()}:confirmed`) {
  reservationIds.push(reservationId);
  return createEnvelope({
    eventType: 'booking.confirmed',
    traceId: '00000000-0000-4000-8000-000000000001',
    actorId: 'svc:booking-worker',
    actorType: 'service',
    entityType: 'reservation',
    entityId: reservationId,
    idempotencyKey,
    payload: {
      reservation_id: reservationId, property_id: 'prp_0001', guest_id: guestId, host_id: 'hst_0001',
      check_in: '2030-01-01', check_out: '2030-01-03', previous_status: 'REQUESTED', new_status: 'CONFIRMED', reason: null,
    },
  });
}
const randomKey = () => newId('k');

// Same shape as property-service's /properties/save event (main)
const savedEvent = (guestId, propertyId, saved) => createEnvelope({
  eventType: 'property.saved',
  traceId: '00000000-0000-4000-8000-000000000002',
  actorId: guestId,
  actorType: 'guest',
  entityType: 'property',
  entityId: propertyId,
  idempotencyKey: `${guestId}:${propertyId}:${saved ? 'save' : 'unsave'}:${randomKey()}`,
  payload: { property_id: propertyId, guest_id: guestId, saved },
});

const onConfirmed = (env) => handlers['booking.confirmed'](env, { topic: 'booking.confirmed' });
const onSaved = (env) => handlers['property.saved'](env, { topic: 'property.saved' });

test.after(async () => {
  if (reservationIds.length) {
    await db().query('DELETE FROM processed_events WHERE consumer_group = ? AND idempotency_key IN (?)',
      [GROUP, reservationIds.map((r) => `booking_count:${r}`)]);
  }
  if (guestIds.length) {
    await db().query('DELETE FROM saved_properties WHERE guest_id IN (?)', [guestIds]);
    await db().query('DELETE FROM guests WHERE guest_id IN (?)', [guestIds]);
  }
  await db().end();
});

test('booking.confirmed: counted once, with a processed_events row for group user-cg', async () => {
  const g = await newGuest();
  const env = confirmed(g);
  assert.strictEqual(await onConfirmed(env), 'counted');
  assert.strictEqual((await counts(g)).booking_count, 1);
  const [[row]] = await db().execute('SELECT event_id, topic FROM processed_events WHERE consumer_group = ? AND idempotency_key = ?',
    [GROUP, `booking_count:${env.payload.reservation_id}`]);
  assert.deepStrictEqual({ ...row }, { event_id: env.event_id, topic: 'booking.confirmed' });
});

test('booking.confirmed: the same event redelivered 10 times at once -> still +1', async () => {
  const g = await newGuest();
  const env = confirmed(g);
  const outcomes = await Promise.all(Array.from({ length: 10 }, () => onConfirmed(env)));
  assert.deepStrictEqual(outcomes.sort(), ['counted', ...Array(9).fill('duplicate')]);
  assert.strictEqual((await counts(g)).booking_count, 1);
});

test('booking.confirmed: a second event for the same reservation (new key, new event_id) -> still +1', async () => {
  const g = await newGuest();
  const resId = newId('res');
  await onConfirmed(confirmed(g, resId, 'approve-1:confirmed'));
  assert.strictEqual(await onConfirmed(confirmed(g, resId, 'approve-2:confirmed')), 'duplicate');
  assert.strictEqual((await counts(g)).booking_count, 1);
});

test('booking.confirmed: three reservations -> 3; version unchanged; another guest unaffected', async () => {
  const g = await newGuest();
  const other = await newGuest();
  for (let i = 0; i < 3; i++) await onConfirmed(confirmed(g));
  assert.deepStrictEqual(await counts(g), { booking_count: 3, saved_properties_count: 0, version: 1 });
  assert.strictEqual((await counts(other)).booking_count, 0);
});

test('booking.confirmed: unknown guest -> claimed and skipped, nothing else changes', async () => {
  assert.strictEqual(await onConfirmed(confirmed(newId('gst'))), 'unknown_guest');
});

test('property.saved: count follows saved_properties through save, unsave, duplicates and reordering', async () => {
  const g = await newGuest();
  // property-service writes the row, then publishes; the worker sees the event afterwards
  await db().execute('INSERT INTO saved_properties (guest_id, property_id) VALUES (?, ?)', [g, 'prp_0001']);
  const save1 = savedEvent(g, 'prp_0001', true);
  await onSaved(save1);
  assert.strictEqual((await counts(g)).saved_properties_count, 1);

  await db().execute('INSERT INTO saved_properties (guest_id, property_id) VALUES (?, ?), (?, ?)', [g, 'prp_0002', g, 'prp_0003']);
  await Promise.all([onSaved(savedEvent(g, 'prp_0002', true)), onSaved(savedEvent(g, 'prp_0003', true))]);
  assert.strictEqual((await counts(g)).saved_properties_count, 3);

  await onSaved(save1); // redelivery
  assert.strictEqual((await counts(g)).saved_properties_count, 3);

  await db().execute('DELETE FROM saved_properties WHERE guest_id = ? AND property_id = ?', [g, 'prp_0002']);
  await onSaved(savedEvent(g, 'prp_0002', false));
  assert.strictEqual((await counts(g)).saved_properties_count, 2);
  await onSaved(savedEvent(g, 'prp_0002', true)); // the old "save" arriving late
  assert.strictEqual((await counts(g)).saved_properties_count, 2, 'a late event cannot push the count away from the table');
  assert.strictEqual((await counts(g)).version, 1, 'counters do not bump version');
});

test('property.saved: heals drift from a lost event', async () => {
  const g = await newGuest();
  // Two saves whose events were lost (Kafka down when the guest saved)
  await db().execute('INSERT INTO saved_properties (guest_id, property_id) VALUES (?, ?), (?, ?)', [g, 'prp_0001', g, 'prp_0002']);
  await db().execute('INSERT INTO saved_properties (guest_id, property_id) VALUES (?, ?)', [g, 'prp_0003']);
  await onSaved(savedEvent(g, 'prp_0003', true)); // only this one arrived
  assert.strictEqual((await counts(g)).saved_properties_count, 3);
});

test('property.saved: unknown guest -> skipped', async () => {
  assert.strictEqual(await onSaved(savedEvent(newId('gst'), 'prp_0001', true)), 'unknown_guest');
});
