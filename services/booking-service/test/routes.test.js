process.env.NODE_ENV = 'test';
// Every endpoint listed in the API doc must exist (anything but 404).
// Keep this list in sync with the doc; add behaviour tests next to it as you implement.
const test = require('node:test');
const assert = require('node:assert');
const app = require('../src/index');

const ENDPOINTS = [
  ['POST', '/bookings/request'],
  ['POST', '/bookings/get'],
  ['POST', '/bookings/byProperty'],
  ['POST', '/bookings/byGuest'],
  ['POST', '/bookings/approve'],
  ['POST', '/bookings/decline'],
  ['POST', '/bookings/cancel'],
];

test('booking-service endpoints from the API doc are all routed', async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.strictEqual(health.status, 200);
    for (const [method, path] of ENDPOINTS) {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-User-Id': 'admin_test', 'X-User-Role': 'admin' },
        body: method === 'GET' ? undefined : '{}',
      });
      const body = await res.json();
      assert.ok(body.trace_id, `${method} ${path} response has trace_id`);
      assert.notStrictEqual(res.status, 404, `${method} ${path} is not routed`);
    }
  } finally {
    server.close();
  }
});

test('unknown route returns the common 404 error body', async () => {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/nope`, { method: 'POST' });
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'NOT_FOUND');
  } finally {
    server.close();
  }
});
