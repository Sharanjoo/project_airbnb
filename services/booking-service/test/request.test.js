process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { createApp, logger } = require('@airbnb/common');
const { buildRouter } = require('../src/routes');
const { priceBreakdown, eachNight } = require('../src/pricing');

const IDEM = '4f0b6a1e-1c22-4d7f-9a0a-8d2b7c3e5f10';
const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

function fakeRepo(overrides = {}) {
  const saved = new Map();
  return {
    saved,
    findPropertyForBooking: async (id) =>
      id === 'prp_0001' ? { property_id: id, host_id: 'hst_0001', status: 'active', capacity: 3, nightly_price: '189.00', cleaning_fee: '40.00' } : null,
    findIdempotentResponse: async (k) => saved.get(k) || null,
    saveIdempotentResponse: async (k, _b, status, body) => saved.set(k, { response_status: status, response_body: body }),
    ...overrides,
  };
}

async function start(repo, bus) {
  const app = createApp({ name: 'booking-test', logger });
  app.use(buildRouter({ bus, repo }));
  app.finalize();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

const post = (base, path, body, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': 'gst_0001', 'X-User-Role': 'guest', 'Idempotency-Key': IDEM, ...headers },
    body: JSON.stringify(body),
  });

const goodBody = () => ({ property_id: 'prp_0001', check_in: future(10), check_out: future(12), guest_count: 2 });

test('valid request publishes booking.requested and returns 202 PENDING', async () => {
  const published = [];
  const { server, base } = await start(fakeRepo(), { publish: async (t, e, k) => published.push({ t, e, k }) });
  try {
    const res = await post(base, '/bookings/request', goodBody(), { 'X-Trace-Id': '7c1e4b2a-0d3f-4f8e-9a11-2b6c5d8e9f01' });
    assert.strictEqual(res.status, 202);
    const body = await res.json();
    assert.strictEqual(body.data.status, 'PENDING');
    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].t, 'booking.requested');
    assert.strictEqual(published[0].k, 'prp_0001');
    assert.strictEqual(published[0].e.trace_id, '7c1e4b2a-0d3f-4f8e-9a11-2b6c5d8e9f01');
    assert.strictEqual(published[0].e.idempotency_key, IDEM);
    assert.strictEqual(published[0].e.payload.price_breakdown.total, 509.96);
  } finally { server.close(); }
});

test('same Idempotency-Key twice publishes once and returns the same reservation', async () => {
  const published = [];
  const { server, base } = await start(fakeRepo(), { publish: async (t, e) => published.push(e) });
  try {
    const a = await (await post(base, '/bookings/request', goodBody())).json();
    const b = await (await post(base, '/bookings/request', goodBody())).json();
    assert.strictEqual(published.length, 1);
    assert.strictEqual(a.data.reservation_id, b.data.reservation_id);
  } finally { server.close(); }
});

test('missing Idempotency-Key -> 400', async () => {
  const { server, base } = await start(fakeRepo(), { publish: async () => {} });
  try {
    const res = await post(base, '/bookings/request', goodBody(), { 'Idempotency-Key': '' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error.code, 'VALIDATION_ERROR');
  } finally { server.close(); }
});

test('check_out before check_in -> 400', async () => {
  const { server, base } = await start(fakeRepo(), { publish: async () => {} });
  try {
    const res = await post(base, '/bookings/request', { ...goodBody(), check_out: future(9) });
    assert.strictEqual(res.status, 400);
  } finally { server.close(); }
});

test('over capacity -> 422', async () => {
  const { server, base } = await start(fakeRepo(), { publish: async () => {} });
  try {
    const res = await post(base, '/bookings/request', { ...goodBody(), guest_count: 5 });
    assert.strictEqual(res.status, 422);
  } finally { server.close(); }
});

test('unknown property -> 404', async () => {
  const { server, base } = await start(fakeRepo(), { publish: async () => {} });
  try {
    const res = await post(base, '/bookings/request', { ...goodBody(), property_id: 'prp_nope' });
    assert.strictEqual(res.status, 404);
  } finally { server.close(); }
});

test('Kafka down -> 503 retryable', async () => {
  const { server, base } = await start(fakeRepo(), { publish: async () => { throw new Error('broker down'); } });
  try {
    const res = await post(base, '/bookings/request', goodBody());
    assert.strictEqual(res.status, 503);
    assert.strictEqual((await res.json()).error.retryable, true);
  } finally { server.close(); }
});

test('host role cannot request a booking -> 403', async () => {
  const { server, base } = await start(fakeRepo(), { publish: async () => {} });
  try {
    const res = await post(base, '/bookings/request', goodBody(), { 'X-User-Role': 'host' });
    assert.strictEqual(res.status, 403);
  } finally { server.close(); }
});

test('price breakdown matches API doc example', () => {
  assert.deepStrictEqual(priceBreakdown({ nightly_price: 189, cleaning_fee: 40 }, 2), {
    nights: 2, nightly_price: 189, subtotal: 378, cleaning_fee: 40, service_fee: 41.8, taxes: 50.16, total: 509.96, currency: 'USD',
  });
});

test('eachNight excludes check_out', () => {
  assert.deepStrictEqual(eachNight('2026-11-14', '2026-11-16'), ['2026-11-14', '2026-11-15']);
});

