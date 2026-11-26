process.env.NODE_ENV = 'test';
// The routes now really query MySQL and Mongo. Fail fast when they are not running (CI), instead of
// waiting 30 s for Mongo server selection on every endpoint.
process.env.MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27018/?serverSelectionTimeoutMS=1500';
// Every endpoint listed in the API doc must exist (anything but 404).
// Keep this list in sync with the doc; add behaviour tests next to it as you implement.
const test = require('node:test');
const assert = require('node:assert');
const { getMysql, getMongo } = require('@airbnb/common');
const app = require('../src/index');

const ENDPOINTS = [
  ['POST', '/events/ingest'],
  ['GET', '/analytics/properties/top'],
  ['GET', '/analytics/funnel'],
  ['GET', '/analytics/geo'],
  ['GET', '/analytics/host/dashboard'],
  ['GET', '/analytics/guest/dashboard'],
  ['GET', '/analytics/platform'],
  ['GET', '/analytics/ai'],
  ['GET', '/traces/7c1e4b2a-0d3f-4f8e-9a11-2b6c5d8e9f01'],
];

test('analytics-service endpoints from the API doc are all routed', async () => {
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
      // a 404 for a missing resource (e.g. an unknown trace) is fine; only "Route ... not found" means unrouted
      const unrouted = res.status === 404 && /^Route /.test(body.error?.message || '');
      assert.ok(!unrouted, `${method} ${path} is not routed`);
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

// Close the database connections so the test process can exit.
test.after(async () => {
  await getMysql().end().catch(() => {});
  await getMongo().then((db) => db.client.close()).catch(() => {});
});
