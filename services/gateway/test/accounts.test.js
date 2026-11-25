process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
// Deleted-account revocation at the gateway: the account-status cache and its failure
// modes, and what a revoked / unverifiable account gets on protected and public routes.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const jwt = require('jsonwebtoken');
const { createAccountStatus, mysqlLookup, REVOKED_KEY_PREFIX } = require('../src/accountStatus');
const { REVOKED_KEY_PREFIX: USER_SERVICE_PREFIX } = require('../../user-service/src/revocation');

const quietLog = { warn: () => {}, error: () => {} };

/** MySQL and Redis stand-ins with call counters and switchable outages. */
function sources() {
  const db = new Map([['gst_live', 'active'], ['gst_gone', 'revoked'], ['hst_live', 'active']]);
  const marks = new Set();
  const s = {
    db, marks, lookups: 0, redisCalls: 0, mysqlDown: false, redisDown: false, clock: 1_000_000,
    lookup: async (id) => { s.lookups++; if (s.mysqlDown) throw new Error('ECONNREFUSED'); return db.get(id) || 'revoked'; },
    revoked: async (id) => { s.redisCalls++; if (s.redisDown) throw new Error('redis reconnecting'); return marks.has(id); },
  };
  s.status = (opts = {}) => createAccountStatus({ lookup: s.lookup, revoked: s.revoked, activeTtlMs: 5000, now: () => s.clock, log: quietLog, ...opts });
  return s;
}

// ---------------------------------------------------------------- the account-status cache
test('user-service and gateway agree on the Redis key', () => {
  assert.strictEqual(REVOKED_KEY_PREFIX, USER_SERVICE_PREFIX);
});

test('active account: one MySQL lookup, then cached for the TTL, then checked again', async () => {
  const s = sources();
  const a = s.status();
  assert.strictEqual(await a.check('gst_live'), 'active');
  assert.strictEqual(await a.check('gst_live'), 'active');
  assert.strictEqual(s.lookups, 1);
  s.clock += 5001;
  assert.strictEqual(await a.check('gst_live'), 'active');
  assert.strictEqual(s.lookups, 2);
});

test('deleted in MySQL: revoked, and remembered for good (no further lookups)', async () => {
  const s = sources();
  const a = s.status();
  assert.strictEqual(await a.check('gst_gone'), 'revoked');
  s.clock += 10 * 60 * 1000;
  assert.strictEqual(await a.check('gst_gone'), 'revoked');
  assert.strictEqual(s.lookups, 1);
});

test('Redis marker revokes immediately, even while an "active" answer is still cached', async () => {
  const s = sources();
  const a = s.status();
  assert.strictEqual(await a.check('gst_live'), 'active'); // cached as active
  s.marks.add('gst_live'); // user-service deletes the account
  assert.strictEqual(await a.check('gst_live'), 'revoked', 'no waiting for the cache to expire');
});

test('Redis lost the marker (restart/flush): MySQL still revokes once the short cache expires', async () => {
  const s = sources();
  const a = s.status();
  assert.strictEqual(await a.check('gst_live'), 'active');
  s.db.set('gst_live', 'revoked'); // deleted in MySQL, but no Redis marker
  s.clock += 5001;
  assert.strictEqual(await a.check('gst_live'), 'revoked');
});

test('Redis down: decisions come from MySQL, active users keep working', async () => {
  const s = sources();
  s.redisDown = true;
  const a = s.status();
  assert.strictEqual(await a.check('gst_live'), 'active');
  assert.strictEqual(await a.check('gst_gone'), 'revoked');
});

test('MySQL down: a recently active user keeps working; an unknown one is "unavailable", never active', async () => {
  const s = sources();
  const a = s.status();
  assert.strictEqual(await a.check('gst_live'), 'active');
  s.mysqlDown = true;
  s.clock += 5001; // past the TTL, within the stale grace
  assert.strictEqual(await a.check('gst_live'), 'active');
  s.clock += 60_000; // past the grace too
  assert.strictEqual(await a.check('gst_live'), 'unavailable');
  assert.strictEqual(await a.check('hst_live'), 'unavailable', 'never seen before');
});

test('MySQL and Redis both down, deleted account cached as revoked: still revoked', async () => {
  const s = sources();
  const a = s.status();
  await a.check('gst_gone');
  s.mysqlDown = true;
  s.redisDown = true;
  assert.strictEqual(await a.check('gst_gone'), 'revoked');
});

test('mysqlLookup: ids user-service never issues are revoked without a query', async () => {
  for (const id of ['admin_test', 'svc:booking-worker', 'prp_0001', '']) {
    assert.strictEqual(await mysqlLookup(id), 'revoked', id);
  }
});

// ---------------------------------------------------------------- what the gateway does with it
const upstream = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ path: req.url, user: req.headers['x-user-id'] || null, authorization: req.headers.authorization || null }));
});
const token = (sub, role = 'guest') => jwt.sign({ sub, role }, 'test-secret', { expiresIn: '10m' });
const post = (base, path, t) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: '{}' });

test('gateway: deleted account vs active account vs unverifiable account', async (t) => {
  await new Promise((r) => upstream.listen(0, r));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(process.env, { USER_SERVICE_URL: target, PROPERTY_SERVICE_URL: target, BOOKING_SERVICE_URL: target, MESSAGING_SERVICE_URL: target, RATE_LIMIT_PER_MIN: '1000' });
  delete require.cache[require.resolve('../src/index')];
  const { createGateway } = require('../src/index');
  const s = sources();
  const gw = createGateway({ accounts: s.status() }).listen(0);
  const base = `http://127.0.0.1:${gw.address().port}`;
  t.after(() => { gw.close(); upstream.close(); });

  await t.test('active account: identity forwarded as before', async () => {
    const res = await post(base, '/api/v1/booking/bookings/get', token('gst_live'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).user, 'gst_live');
  });

  await t.test('deleted account: 401 UNAUTHENTICATED on every protected service (booking, save, messaging)', async () => {
    for (const path of ['/api/v1/booking/bookings/request', '/api/v1/property/properties/save', '/api/v1/messaging/threads/open', '/api/v1/user/guests/get']) {
      const res = await post(base, path, token('gst_gone'));
      assert.strictEqual(res.status, 401, path);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'UNAUTHENTICATED', path); // the client clears its session on this
      assert.match(body.error.message, /no longer active/);
    }
  });

  await t.test('deleted account on a public route: continues anonymously and the client is told to drop the session', async () => {
    const res = await post(base, '/api/v1/property/properties/get', token('gst_gone'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-auth-status'), 'invalid');
    const body = await res.json();
    assert.deepStrictEqual([body.user, body.authorization], [null, null]);
  });

  await t.test('account deleted mid-session: the very next request is refused (Redis marker)', async () => {
    assert.strictEqual((await post(base, '/api/v1/booking/bookings/get', token('hst_live', 'host'))).status, 200);
    s.marks.add('hst_live');
    assert.strictEqual((await post(base, '/api/v1/booking/bookings/get', token('hst_live', 'host'))).status, 401);
  });

  await t.test('MySQL down for a new user: protected -> 503 retryable (not 401), public -> anonymous without logging out', async () => {
    s.mysqlDown = true;
    s.db.set('gst_new', 'active');
    const res = await post(base, '/api/v1/booking/bookings/request', token('gst_new'));
    assert.strictEqual(res.status, 503);
    const body = await res.json();
    assert.deepStrictEqual([body.error.code, body.error.retryable], ['DEPENDENCY_UNAVAILABLE', true]);
    const pub = await post(base, '/api/v1/property/properties/get', token('gst_new'));
    assert.strictEqual(pub.status, 200);
    assert.strictEqual(pub.headers.get('x-auth-status'), null, 'an outage must not clear the session');
    assert.strictEqual((await pub.json()).user, null, 'but no unverified identity is forwarded');
    s.mysqlDown = false;
  });

  await t.test('forged or expired tokens are still refused before any account lookup', async () => {
    const before = s.lookups;
    const forged = jwt.sign({ sub: 'gst_live', role: 'guest' }, 'other-secret');
    assert.strictEqual((await post(base, '/api/v1/booking/bookings/get', forged)).status, 401);
    assert.strictEqual(s.lookups, before);
  });
});
