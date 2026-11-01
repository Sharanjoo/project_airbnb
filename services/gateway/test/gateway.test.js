process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const jwt = require('jsonwebtoken');

// Fake upstream that echoes the identity headers it received
const upstream = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ path: req.url, user: req.headers['x-user-id'] || null, role: req.headers['x-user-role'] || null, trace: req.headers['x-trace-id'] }));
});

test('gateway routes, authenticates and propagates identity + trace id', async (t) => {
  await new Promise((r) => upstream.listen(0, r));
  process.env.BOOKING_SERVICE_URL = `http://127.0.0.1:${upstream.address().port}`;
  process.env.PROPERTY_SERVICE_URL = process.env.BOOKING_SERVICE_URL;
  delete require.cache[require.resolve('../src/index')];
  const { createGateway } = require('../src/index');
  const gw = createGateway().listen(0);
  const base = `http://127.0.0.1:${gw.address().port}`;
  t.after(() => { gw.close(); upstream.close(); });

  await t.test('no token on a private route -> 401', async () => {
    const res = await fetch(`${base}/api/v1/booking/bookings/get`, { method: 'POST' });
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).error.code, 'UNAUTHENTICATED');
  });

  await t.test('public route works without a token', async () => {
    const res = await fetch(`${base}/api/v1/property/properties/search`, { method: 'POST' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).path, '/properties/search');
  });

  await t.test('valid token -> identity headers set from JWT, spoofed headers dropped', async () => {
    const token = jwt.sign({ sub: 'gst_0001', role: 'guest' }, 'test-secret');
    const res = await fetch(`${base}/api/v1/booking/bookings/get`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-User-Role': 'admin', 'X-Trace-Id': 'abc-trace' },
    });
    const body = await res.json();
    assert.strictEqual(body.user, 'gst_0001');
    assert.strictEqual(body.role, 'guest');
    assert.strictEqual(body.trace, 'abc-trace');
    assert.strictEqual(res.headers.get('x-trace-id'), 'abc-trace');
  });

  await t.test('bad token -> 401', async () => {
    const res = await fetch(`${base}/api/v1/booking/bookings/get`, { method: 'POST', headers: { Authorization: 'Bearer nope' } });
    assert.strictEqual(res.status, 401);
  });

  await t.test('service down -> 503 with common error body', async () => {
    const token = jwt.sign({ sub: 'gst_0001', role: 'guest' }, 'test-secret');
    const res = await fetch(`${base}/api/v1/review/reviews/create`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(res.status, 503);
    assert.strictEqual((await res.json()).error.code, 'DEPENDENCY_UNAVAILABLE');
  });
});
