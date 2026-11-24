process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
// Token handling at the gateway: stale tokens on public routes, protected routes
// stay strict, forged tokens rejected, and the rate limit cannot be dodged by
// sending a different made-up token each time.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const jwt = require('jsonwebtoken');
// Account-status stub: every account exists (revocation is covered in accounts.test.js)
const ALL_ACTIVE = { check: async () => 'active' };

// Fake upstream that echoes what the gateway forwarded
const upstream = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    path: req.url, user: req.headers['x-user-id'] || null, role: req.headers['x-user-role'] || null, authorization: req.headers.authorization || null,
  }));
});

const valid = (claims = { sub: 'gst_0001', role: 'guest' }, opts = {}) => jwt.sign(claims, 'test-secret', { expiresIn: '10m', ...opts });
const expired = () => jwt.sign({ sub: 'gst_0001', role: 'guest', exp: Math.floor(Date.now() / 1000) - 60 }, 'test-secret');
const wrongSecret = () => jwt.sign({ sub: 'gst_0001', role: 'admin' }, 'some-other-secret');
// alg "none": header + payload with an empty signature
const unsigned = () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'hst_0001', role: 'admin' })}.`;
};

function loadGateway(env = {}) {
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../src/index')];
  return require('../src/index').createGateway;
}

const post = (base, path, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

test('gateway token handling', async (t) => {
  await new Promise((r) => upstream.listen(0, r));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const createGateway = loadGateway({ USER_SERVICE_URL: target, PROPERTY_SERVICE_URL: target, BOOKING_SERVICE_URL: target, RATE_LIMIT_PER_MIN: '1000' });
  const gw = createGateway({ accounts: ALL_ACTIVE }).listen(0);
  const base = `http://127.0.0.1:${gw.address().port}`;
  t.after(() => { gw.close(); upstream.close(); });

  await t.test('stale (expired) token on login -> request still reaches user-service, anonymously', async () => {
    const res = await post(base, '/api/v1/user/auth/login', bearer(expired()));
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.path, '/auth/login');
    assert.strictEqual(body.user, null);
    assert.strictEqual(body.role, null);
    assert.strictEqual(body.authorization, null, 'the bad token is not forwarded');
    assert.strictEqual(res.headers.get('x-auth-status'), 'invalid', 'client is told to drop its session');
  });

  await t.test('no token or a valid token on a public route -> no X-Auth-Status flag', async () => {
    assert.strictEqual((await post(base, '/api/v1/user/auth/login')).headers.get('x-auth-status'), null);
    assert.strictEqual((await post(base, '/api/v1/property/properties/get', bearer(valid()))).headers.get('x-auth-status'), null);
  });

  await t.test('garbage or wrong-secret token on sign-up and search -> anonymous, never elevated', async () => {
    for (const path of ['/api/v1/user/guests/create', '/api/v1/user/hosts/create', '/api/v1/property/properties/search']) {
      for (const token of ['garbage', wrongSecret(), unsigned()]) {
        const res = await post(base, path, bearer(token));
        assert.strictEqual(res.status, 200, `${path} with a bad token`);
        const body = await res.json();
        assert.strictEqual(body.user, null);
        assert.strictEqual(body.role, null, 'a forged admin claim must not get through');
      }
    }
  });

  await t.test('stale token on a protected route -> still 401', async () => {
    for (const token of [expired(), 'garbage', wrongSecret(), unsigned()]) {
      const res = await post(base, '/api/v1/booking/bookings/request', bearer(token));
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'UNAUTHENTICATED');
      assert.strictEqual(body.error.message, 'Invalid or expired token.');
    }
  });

  await t.test('no token on a protected route -> 401 Missing token', async () => {
    const res = await post(base, '/api/v1/property/properties/create');
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).error.message, 'Missing token.');
  });

  await t.test('valid token on a public route -> identity still forwarded (e.g. property.viewed viewer_id)', async () => {
    const res = await post(base, '/api/v1/property/properties/get', bearer(valid()));
    const body = await res.json();
    assert.strictEqual(body.user, 'gst_0001');
    assert.strictEqual(body.role, 'guest');
  });

  await t.test('token missing sub or role -> rejected on protected routes', async () => {
    for (const claims of [{ role: 'guest' }, { sub: 'gst_0001' }, { sub: '', role: 'guest' }, { sub: 123, role: 'guest' }]) {
      const res = await post(base, '/api/v1/booking/bookings/get', bearer(valid(claims)));
      assert.strictEqual(res.status, 401, JSON.stringify(claims));
    }
  });

  await t.test('token signed with a different algorithm (HS512) -> rejected', async () => {
    const res = await post(base, '/api/v1/booking/bookings/get', bearer(valid(undefined, { algorithm: 'HS512' })));
    assert.strictEqual(res.status, 401);
  });

  await t.test('a public route with a query string still counts as public', async () => {
    const res = await post(base, '/api/v1/property/properties/search?x=1', bearer('garbage'));
    assert.strictEqual(res.status, 200);
  });
});

test('rate limit is keyed on the verified user or the IP, not on the raw Authorization header', async (t) => {
  await new Promise((r) => (upstream.listening ? r() : upstream.listen(0, r)));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const createGateway = loadGateway({ USER_SERVICE_URL: target, BOOKING_SERVICE_URL: target, RATE_LIMIT_PER_MIN: '3' });
  const gw = createGateway({ accounts: ALL_ACTIVE }).listen(0);
  const base = `http://127.0.0.1:${gw.address().port}`;
  t.after(() => { gw.close(); upstream.close(); delete process.env.RATE_LIMIT_PER_MIN; });

  // A login brute force rotating made-up tokens shares one per-IP bucket
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await post(base, '/api/v1/user/auth/login', bearer(`made-up-${i}`))).status);
  assert.deepStrictEqual(statuses, [200, 200, 200, 429, 429]);
  const limited = await post(base, '/api/v1/user/auth/login', bearer('made-up-again'));
  assert.strictEqual((await limited.json()).error.code, 'RATE_LIMITED');

  // A logged-in user has their own bucket, separate from the anonymous one
  const res = await post(base, '/api/v1/booking/bookings/get', bearer(valid({ sub: 'gst_0042', role: 'guest' })));
  assert.strictEqual(res.status, 200);
});
