process.env.NODE_ENV = 'test';
// Tests for /bookings/approve, /decline and /cancel, plus the cancellation rule and local time.
const test = require('node:test');
const assert = require('node:assert');
const { createApp, logger } = require('@airbnb/common');
const { buildRouter } = require('../src/routes');
const { hashBody } = require('../src/models/booking');
const { guestMayCancel, hoursUntilCheckIn } = require('../src/policy');
const { localDate, checkInInstant, checkOutInstant } = require('../src/timeutil');

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const localDay = (offset) => localDate(Date.now() + offset * 86400000); // a date on the listing's clock
const KEY = () => crypto.randomUUID();
const GUEST = { id: 'gst_0001', role: 'guest' };
const HOST = { id: 'hst_0001', role: 'host' };

function reservation(overrides = {}) {
  return {
    reservation_id: 'res_51a', property_id: 'prp_0001', guest_id: 'gst_0001', host_id: 'hst_0001',
    check_in: day(10), check_out: day(12), status: 'REQUESTED', ...overrides,
  };
}

function fakeRepo(rowOverrides = {}) {
  const saved = new Map();
  return {
    saved,
    findReservation: async (id) => (id === 'res_51a' ? reservation(rowOverrides) : null),
    findIdempotentResponse: async (k) => saved.get(k) || null,
    saveIdempotentResponse: async (k, fp, status, body) =>
      saved.set(k, { request_hash: hashBody(fp), response_status: status, response_body: body }),
  };
}

async function start(repo, bus) {
  const app = createApp({ name: 'booking-test', logger });
  app.use(buildRouter({ bus, repo }));
  app.finalize();
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const call = (base, path, body, { user = HOST, key = KEY(), trace = 'aaaaaaaa-0d3f-4f8e-9a11-2b6c5d8e9f01' } = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-User-Id': user.id, 'X-User-Role': user.role,
      ...(key ? { 'Idempotency-Key': key } : {}), 'X-Trace-Id': trace,
    },
    body: JSON.stringify(body),
  });

function harness(rowOverrides) {
  const published = [];
  const repo = fakeRepo(rowOverrides);
  return { repo, published, bus: { publish: async (t, e, k) => published.push({ t, e, k }) } };
}

// approve

test('approve: owning host returns 202 APPROVING and booking.approved is published', async () => {
  const h = harness();
  const { server, base } = await start(h.repo, h.bus);
  try {
    const key = KEY();
    const res = await call(base, '/bookings/approve', { reservation_id: 'res_51a' }, { key });
    assert.strictEqual(res.status, 202);
    const body = await res.json();
    assert.deepStrictEqual(body.data, { reservation_id: 'res_51a', status: 'APPROVING' });
    assert.strictEqual(h.published.length, 1);
    const { t, e, k } = h.published[0];
    assert.strictEqual(t, 'booking.approved');
    assert.strictEqual(k, 'prp_0001');
    assert.strictEqual(e.trace_id, 'aaaaaaaa-0d3f-4f8e-9a11-2b6c5d8e9f01');
    assert.strictEqual(e.idempotency_key, key);
    assert.strictEqual(e.actor_id, 'hst_0001');
    assert.strictEqual(e.entity.entity_id, 'res_51a');
    assert.strictEqual(e.payload.host_id, 'hst_0001');
    assert.strictEqual(e.payload.requested_by, 'hst_0001');
  } finally { server.close(); }
});

test('approve: same Idempotency-Key twice publishes once', async () => {
  const h = harness();
  const { server, base } = await start(h.repo, h.bus);
  try {
    const key = KEY();
    const a = await (await call(base, '/bookings/approve', { reservation_id: 'res_51a' }, { key })).json();
    const b = await (await call(base, '/bookings/approve', { reservation_id: 'res_51a' }, { key })).json();
    assert.deepStrictEqual(a.data, b.data);
    assert.strictEqual(h.published.length, 1);
  } finally { server.close(); }
});

test('approve: same key reused for a different reservation returns 409 IDEMPOTENCY_KEY_REUSED', async () => {
  const h = harness();
  const { server, base } = await start(h.repo, h.bus);
  try {
    const key = KEY();
    await call(base, '/bookings/approve', { reservation_id: 'res_51a' }, { key });
    const res = await call(base, '/bookings/approve', { reservation_id: 'res_other' }, { key });
    assert.strictEqual(res.status, 409);
    assert.strictEqual((await res.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
  } finally { server.close(); }
});

test('approve: a booking that was already cancelled returns 409 INVALID_STATE_TRANSITION', async () => {
  const h = harness({ status: 'CANCELLED' });
  const { server, base } = await start(h.repo, h.bus);
  try {
    const res = await call(base, '/bookings/approve', { reservation_id: 'res_51a' });
    assert.strictEqual(res.status, 409);
    const { error } = await res.json();
    assert.strictEqual(error.code, 'INVALID_STATE_TRANSITION');
    assert.strictEqual(error.message, 'Cannot approve a CANCELLED reservation.');
    assert.strictEqual(h.published.length, 0);
  } finally { server.close(); }
});

test('approve: another host returns 403; guest returns 403; unknown reservation -> 404; no key -> 400', async () => {
  const h = harness();
  const { server, base } = await start(h.repo, h.bus);
  try {
    assert.strictEqual((await call(base, '/bookings/approve', { reservation_id: 'res_51a' }, { user: { id: 'hst_0002', role: 'host' } })).status, 403);
    assert.strictEqual((await call(base, '/bookings/approve', { reservation_id: 'res_51a' }, { user: GUEST })).status, 403);
    assert.strictEqual((await call(base, '/bookings/approve', { reservation_id: 'res_nope' })).status, 404);
    assert.strictEqual((await call(base, '/bookings/approve', { reservation_id: 'res_51a' }, { key: '' })).status, 400);
    assert.strictEqual(h.published.length, 0);
  } finally { server.close(); }
});

test('approve: Kafka down returns 503 retryable and the key is not remembered', async () => {
  const h = harness();
  const { server, base } = await start(h.repo, { publish: async () => { throw new Error('broker down'); } });
  try {
    const res = await call(base, '/bookings/approve', { reservation_id: 'res_51a' });
    assert.strictEqual(res.status, 503);
    assert.strictEqual((await res.json()).error.retryable, true);
    assert.strictEqual(h.repo.saved.size, 0);
  } finally { server.close(); }
});

// decline

test('decline: owning host with a reason returns 202 DECLINING and booking.declined carries the reason', async () => {
  const h = harness();
  const { server, base } = await start(h.repo, h.bus);
  try {
    const res = await call(base, '/bookings/decline', { reservation_id: 'res_51a', reason: 'Property under maintenance' });
    assert.strictEqual(res.status, 202);
    assert.strictEqual((await res.json()).data.status, 'DECLINING');
    assert.strictEqual(h.published[0].t, 'booking.declined');
    assert.strictEqual(h.published[0].e.payload.reason, 'Property under maintenance');
  } finally { server.close(); }
});

test('decline: reason is required; a confirmed booking cannot be declined', async () => {
  const h = harness();
  const { server, base } = await start(h.repo, h.bus);
  try {
    assert.strictEqual((await call(base, '/bookings/decline', { reservation_id: 'res_51a' })).status, 400);
  } finally { server.close(); }
  const c = harness({ status: 'CONFIRMED' });
  const s2 = await start(c.repo, c.bus);
  try {
    const res = await call(s2.base, '/bookings/decline', { reservation_id: 'res_51a', reason: 'no' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual((await res.json()).error.code, 'INVALID_STATE_TRANSITION');
  } finally { s2.server.close(); }
});

// cancel

test('cancel: guest on the booking, well before check-in returns 202 CANCELLING', async () => {
  const h = harness({ status: 'CONFIRMED' });
  const { server, base } = await start(h.repo, h.bus);
  try {
    const res = await call(base, '/bookings/cancel', { reservation_id: 'res_51a', cancellation_reason: 'Trip dates changed' }, { user: GUEST });
    assert.strictEqual(res.status, 202);
    assert.strictEqual((await res.json()).data.status, 'CANCELLING');
    const { t, e } = h.published[0];
    assert.strictEqual(t, 'booking.cancel_requested');
    assert.strictEqual(e.actor_type, 'guest');
    assert.deepStrictEqual(e.payload, { reservation_id: 'res_51a', requested_by: 'gst_0001', cancellation_reason: 'Trip dates changed' });
  } finally { server.close(); }
});

test('cancel: guest within 24 h of check-in returns 422 with the API doc message, nothing published (CONFIRMED and REQUESTED alike)', async () => {
  for (const status of ['CONFIRMED', 'REQUESTED']) {
    const h = harness({ status, check_in: localDay(0), check_out: localDay(2) });
    const { server, base } = await start(h.repo, h.bus);
    try {
      const res = await call(base, '/bookings/cancel', { reservation_id: 'res_51a', cancellation_reason: 'x' }, { user: GUEST });
      assert.strictEqual(res.status, 422, status);
      const { error } = await res.json();
      assert.strictEqual(error.code, 'BUSINESS_RULE_VIOLATION');
      assert.strictEqual(error.message, 'Guests cannot cancel within 24 hours of check-in.');
      assert.strictEqual(h.published.length, 0);
    } finally { server.close(); }
  }
});

test('cancel: the host can cancel at any time, even on the check-in day', async () => {
  const h = harness({ status: 'CONFIRMED', check_in: day(0), check_out: day(2) });
  const { server, base } = await start(h.repo, h.bus);
  try {
    const res = await call(base, '/bookings/cancel', { reservation_id: 'res_51a', cancellation_reason: 'Burst pipe' });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(h.published[0].e.actor_type, 'host');
  } finally { server.close(); }
});

test('cancel: someone who is not on the booking returns 403', async () => {
  const h = harness({ status: 'CONFIRMED' });
  const { server, base } = await start(h.repo, h.bus);
  try {
    assert.strictEqual((await call(base, '/bookings/cancel', { reservation_id: 'res_51a', cancellation_reason: 'x' }, { user: { id: 'gst_0002', role: 'guest' } })).status, 403);
    assert.strictEqual((await call(base, '/bookings/cancel', { reservation_id: 'res_51a', cancellation_reason: 'x' }, { user: { id: 'hst_0002', role: 'host' } })).status, 403);
  } finally { server.close(); }
});

test('cancel: already cancelled, completed or declined returns 409 INVALID_STATE_TRANSITION', async () => {
  for (const status of ['CANCELLED', 'COMPLETED', 'DECLINED', 'EXPIRED', 'REJECTED']) {
    const h = harness({ status });
    const { server, base } = await start(h.repo, h.bus);
    try {
      const res = await call(base, '/bookings/cancel', { reservation_id: 'res_51a', cancellation_reason: 'x' }, { user: GUEST });
      assert.strictEqual(res.status, 409, status);
    } finally { server.close(); }
  }
});

test('cancel: reason is required', async () => {
  const h = harness({ status: 'CONFIRMED' });
  const { server, base } = await start(h.repo, h.bus);
  try {
    assert.strictEqual((await call(base, '/bookings/cancel', { reservation_id: 'res_51a' }, { user: GUEST })).status, 400);
  } finally { server.close(); }
});

// cancellation rule and local time

test('policy: guests are locked out 24 h before check-in time (15:00 local = 22:00 UTC in June)', () => {
  const checkIn = '2030-06-10';
  const at = (iso) => Date.parse(iso);
  assert.strictEqual(hoursUntilCheckIn(checkIn, at('2030-06-09T22:00:00Z')), 24);
  assert.strictEqual(guestMayCancel(checkIn, at('2030-06-09T22:00:00Z')), true); // exactly 24 hours left
  assert.strictEqual(guestMayCancel(checkIn, at('2030-06-09T22:00:01Z')), false); // one second inside the window
  assert.strictEqual(guestMayCancel(checkIn, at('2030-06-01T12:00:00Z')), true);
  assert.strictEqual(guestMayCancel(checkIn, at('2030-06-11T09:00:00Z')), false); // after check-in
});

test('time: stays run on the listing clock (America/Los_Angeles), including daylight saving', () => {
  // it can still be the 18th in California when it is already the 19th in UTC
  assert.strictEqual(localDate(Date.parse('2026-11-19T02:34:00Z')), '2026-11-18');
  assert.strictEqual(localDate(Date.parse('2026-11-19T08:00:00Z')), '2026-11-19');
  // 15:00 local is 8 hours behind UTC in winter and 7 hours behind in summer
  assert.strictEqual(new Date(checkInInstant('2026-12-01')).toISOString(), '2026-12-01T23:00:00.000Z');
  assert.strictEqual(new Date(checkInInstant('2030-06-10')).toISOString(), '2030-06-10T22:00:00.000Z');
  // 11:00 local check-out
  assert.strictEqual(new Date(checkOutInstant('2026-12-01')).toISOString(), '2026-12-01T19:00:00.000Z');
  // the two days the clocks change in 2026: March 8 and November 1
  assert.strictEqual(new Date(checkInInstant('2026-03-08')).toISOString(), '2026-03-08T22:00:00.000Z');
  assert.strictEqual(new Date(checkInInstant('2026-11-01')).toISOString(), '2026-11-01T23:00:00.000Z');
});
