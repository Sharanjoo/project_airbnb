process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.BCRYPT_ROUNDS = '4'; // fast hashing for tests; production default is 10
process.env.PUBLISH_WAIT_MS = '50';
// Sign-up and login behaviour with in-memory repos (no MySQL, no Kafka).
// The same flows against the real MySQL are in test/integration/auth.int.js.
const test = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createApp, logger, validateEnvelope } = require('@airbnb/common');
const { buildRouter } = require('../src/routes');
const guestModel = require('../src/models/guest');
const hostModel = require('../src/models/host');

// ---------------------------------------------------------------- fakes
// Same interface as src/models/*.js. The email "unique key" is case-insensitive like the MySQL collation.
function fakeTable(idField, defaults, toApi) {
  const rows = new Map();
  const byEmail = (email) => [...rows.values()].find((r) => r.email.toLowerCase() === email.toLowerCase() && !r.is_deleted);
  return {
    rows,
    inserted: [],
    toApi,
    async findByEmail(email) { const r = byEmail(email); return r ? { ...r } : null; },
    async findById(id) { const r = rows.get(id); return r && !r.is_deleted ? { ...r } : null; },
    async insert(record) {
      this.inserted.push(record);
      if ([...rows.values()].some((r) => r.email.toLowerCase() === record.email.toLowerCase())) {
        const err = new Error(`Duplicate entry '${record.email}' for key 'uq_email'`);
        err.code = 'ER_DUP_ENTRY';
        throw err;
      }
      const row = { ...defaults(), ...record, is_deleted: 0, version: 1 };
      rows.set(row[idField], row);
      return { ...row };
    },
    seed(row) { rows.set(row[idField], { ...defaults(), is_deleted: 0, version: 1, ...row }); },
  };
}

const fakeGuests = () => fakeTable('guest_id', () => ({
  phone: null, location: null, profile_photo_url: null, preferences: null,
  saved_properties_count: 0, booking_count: 0, profile_created_datetime: '2026-11-22 18:00:00.000',
}), guestModel.toApi);

const fakeHosts = () => fakeTable('host_id', () => ({
  phone: null, profile_photo_url: null, verification_status: 'pending', response_rate: null, response_time: null,
  host_since: '2026-11-22 18:00:00.000', access_level: 'standard',
}), hostModel.toApi);

function fakeBus({ fail = false } = {}) {
  const sent = [];
  return { sent, publish: async (topic, env, key) => { if (fail) throw new Error('broker down'); sent.push({ topic, env, key }); } };
}

async function withServer(fn, { busFail = false } = {}) {
  const guests = fakeGuests();
  const hosts = fakeHosts();
  const bus = fakeBus({ fail: busFail });
  const app = createApp({ name: 'user-test', logger });
  app.use(buildRouter({ bus, guests, hosts }));
  app.finalize();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, guests, hosts, bus });
  } finally {
    server.close();
  }
}

const call = async (base, path, body, headers = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

const guestBody = (over = {}) => ({ first_name: 'Ana', last_name: 'Rivera', email: 'ana.new@example.com', password: 'correct-horse-1', ...over });
const hostBody = (over = {}) => ({ name: 'Maya Chen', email: 'maya.new@example.com', password: 'correct-horse-1', ...over });

// ---------------------------------------------------------------- guest sign-up
test('guests/create: 201, bcrypt hash stored, no secrets in the response, user.created published', () => withServer(async ({ base, guests, bus }) => {
  const r = await call(base, '/guests/create', guestBody({ location: 'San Jose, CA', preferences: { pet_friendly: true } }));
  assert.strictEqual(r.status, 201);
  const g = r.body.data;
  assert.match(g.guest_id, /^gst_[0-9a-f]{32}$/);
  assert.strictEqual(g.email, 'ana.new@example.com');
  assert.strictEqual(g.version, 1);
  assert.deepStrictEqual(g.preferences, { pet_friendly: true });
  assert.ok(r.body.trace_id);
  for (const secret of ['password', 'password_hash', 'is_deleted']) assert.ok(!(secret in g), `${secret} must not be returned`);

  const stored = guests.rows.get(g.guest_id);
  assert.match(stored.password_hash, /^\$2[aby]\$04\$/); // bcrypt, cost from BCRYPT_ROUNDS
  assert.notStrictEqual(stored.password_hash, 'correct-horse-1');
  assert.ok(await bcrypt.compare('correct-horse-1', stored.password_hash));

  assert.strictEqual(bus.sent.length, 1);
  const { topic, env, key } = bus.sent[0];
  assert.strictEqual(topic, 'user.created');
  assert.strictEqual(key, g.guest_id);
  assert.deepStrictEqual(validateEnvelope(env, topic), { valid: true });
  assert.strictEqual(env.entity.entity_id, g.guest_id);
  assert.strictEqual(env.payload.user_type, 'guest');
  assert.strictEqual(env.trace_id, r.body.trace_id);
  // No credentials or contact details in an event every consumer group stores
  const payloadText = JSON.stringify(env.payload);
  for (const leak of ['password', 'hash', 'ana.new@example.com']) assert.ok(!payloadText.includes(leak), `event payload leaks ${leak}`);
}));

test('guests/create: email is trimmed and lower-cased before it is stored', () => withServer(async ({ base, guests }) => {
  const r = await call(base, '/guests/create', guestBody({ email: '  Ana.New@Example.COM ' }));
  assert.strictEqual(r.status, 201);
  assert.strictEqual(guests.inserted[0].email, 'ana.new@example.com');
}));

test('guests/create: duplicate email (any case) -> 409 EMAIL_TAKEN, no event', () => withServer(async ({ base, bus }) => {
  assert.strictEqual((await call(base, '/guests/create', guestBody())).status, 201);
  const r = await call(base, '/guests/create', guestBody({ email: 'ANA.NEW@example.com', first_name: 'Other' }));
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'EMAIL_TAKEN');
  assert.strictEqual(r.body.error.details[0].field, 'email');
  assert.strictEqual(bus.sent.length, 1);
}));

test('guests/create: a duplicate on a key other than email is not reported as EMAIL_TAKEN', () => withServer(async ({ base, guests }) => {
  guests.insert = async () => { const err = new Error("Duplicate entry 'gst_x' for key 'guests.PRIMARY'"); err.code = 'ER_DUP_ENTRY'; throw err; };
  const r = await call(base, '/guests/create', guestBody());
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.body.error.code, 'INTERNAL_ERROR');
}));

test('guests/create: validation errors -> 400 with field details', () => withServer(async ({ base, guests }) => {
  const cases = [
    [{ password: 'short' }, 'password'],
    [{ email: 'not-an-email' }, 'email'],
    [{ first_name: '' }, 'first_name'],
    [{ phone: '4085550101' }, 'phone'],
    [{ profile_photo_url: 'javascript:alert(1)' }, 'profile_photo_url'],
    [{ password: 'é'.repeat(37) }, 'password'], // 74 bytes: bcrypt would silently ignore the tail
  ];
  for (const [over, field] of cases) {
    const r = await call(base, '/guests/create', guestBody(over));
    assert.strictEqual(r.status, 400, `${field} should be rejected`);
    assert.strictEqual(r.body.error.code, 'VALIDATION_ERROR');
    assert.ok(r.body.error.details.some((d) => d.field === field), `details mention ${field}`);
  }
  const missing = await call(base, '/guests/create', {});
  assert.strictEqual(missing.status, 400);
  assert.strictEqual(guests.inserted.length, 0);
}));

test('guests/create: cannot choose its own role, id, counters or access level', () => withServer(async ({ base, guests }) => {
  for (const extra of [{ role: 'admin' }, { access_level: 'admin' }, { guest_id: 'gst_0001' }, { booking_count: 99 }, { is_deleted: false }]) {
    const r = await call(base, '/guests/create', guestBody(extra));
    assert.strictEqual(r.status, 400, `${Object.keys(extra)[0]} must be rejected`);
  }
  assert.strictEqual(guests.inserted.length, 0);
}));

test('guests/create: Kafka down -> still 201 (row is committed, failure is logged)', () => withServer(async ({ base, guests }) => {
  const r = await call(base, '/guests/create', guestBody());
  assert.strictEqual(r.status, 201);
  assert.ok(guests.rows.has(r.body.data.guest_id));
}, { busFail: true }));

// ---------------------------------------------------------------- host sign-up
test('hosts/create: 201, standard access, pending verification, user.created published', () => withServer(async ({ base, hosts, bus }) => {
  const r = await call(base, '/hosts/create', hostBody({ phone: '+14085550101' }));
  assert.strictEqual(r.status, 201);
  const h = r.body.data;
  assert.match(h.host_id, /^hst_[0-9a-f]{32}$/);
  assert.strictEqual(h.verification_status, 'pending');
  assert.strictEqual(h.phone, '+14085550101');
  for (const secret of ['password', 'password_hash', 'access_level']) assert.ok(!(secret in h), `${secret} must not be returned`);
  assert.strictEqual(hosts.rows.get(h.host_id).access_level, 'standard');
  assert.ok(!('access_level' in hosts.inserted[0]), 'sign-up never passes access_level to the model');
  assert.strictEqual(bus.sent[0].topic, 'user.created');
  assert.strictEqual(bus.sent[0].env.payload.user_type, 'host');
  assert.strictEqual(bus.sent[0].env.actor_type, 'host');
}));

test('hosts/create: public sign-up can never grant admin or superhost', () => withServer(async ({ base, hosts }) => {
  for (const extra of [{ access_level: 'admin' }, { access_level: 'superhost' }, { role: 'admin' }, { verification_status: 'verified' }]) {
    const r = await call(base, '/hosts/create', hostBody(extra));
    assert.strictEqual(r.status, 400);
  }
  // Even a caller who is already an admin cannot pass access_level through sign-up
  const r = await call(base, '/hosts/create', hostBody({ access_level: 'admin' }), { 'X-User-Id': 'hst_admin', 'X-User-Role': 'admin' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(hosts.inserted.length, 0);
}));

test('hosts/create: duplicate email -> 409; the same email may still sign up as a guest', () => withServer(async ({ base }) => {
  assert.strictEqual((await call(base, '/hosts/create', hostBody())).status, 201);
  assert.strictEqual((await call(base, '/hosts/create', hostBody())).body.error.code, 'EMAIL_TAKEN');
  const asGuest = await call(base, '/guests/create', guestBody({ email: 'maya.new@example.com' }));
  assert.strictEqual(asGuest.status, 201);
}));

// ---------------------------------------------------------------- login
test('auth/login: guest -> { token, expires_at, user_id, role } and a token the gateway accepts', () => withServer(async ({ base }) => {
  const created = (await call(base, '/guests/create', guestBody())).body.data;
  const before = Math.floor(Date.now() / 1000);
  const r = await call(base, '/auth/login', { email: 'ana.new@example.com', password: 'correct-horse-1' });
  assert.strictEqual(r.status, 200);
  const s = r.body.data;
  assert.deepStrictEqual(Object.keys(s).sort(), ['expires_at', 'role', 'token', 'user_id']);
  assert.strictEqual(s.user_id, created.guest_id);
  assert.strictEqual(s.role, 'guest');

  const claims = jwt.verify(s.token, 'test-secret', { algorithms: ['HS256'] });
  assert.strictEqual(claims.sub, created.guest_id);
  assert.strictEqual(claims.role, 'guest');
  assert.strictEqual(jwt.decode(s.token, { complete: true }).header.alg, 'HS256');
  assert.strictEqual(new Date(claims.exp * 1000).toISOString(), s.expires_at);
  assert.ok(claims.exp - before >= 8 * 3600 - 5 && claims.exp - before <= 8 * 3600 + 5, 'default lifetime is 8 hours');
  assert.match(s.expires_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}));

test('auth/login: email is matched case-insensitively', () => withServer(async ({ base }) => {
  await call(base, '/guests/create', guestBody());
  const r = await call(base, '/auth/login', { email: ' ANA.new@Example.com ', password: 'correct-horse-1' });
  assert.strictEqual(r.status, 200);
}));

test('auth/login: accounts on reserved demo domains (e.g. slice 3 @demo.invalid guests) can log in', () => withServer(async ({ base, guests }) => {
  guests.seed({ guest_id: 'gst_demo01', first_name: 'Demo', last_name: 'Guest1', email: 'gst_demo01@demo.invalid', password_hash: await bcrypt.hash('password123', 4) });
  const r = await call(base, '/auth/login', { email: 'gst_demo01@demo.invalid', password: 'password123' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.user_id, 'gst_demo01');
}));

test('auth/login: host -> role host; role field picks the account type', () => withServer(async ({ base }) => {
  const host = (await call(base, '/hosts/create', hostBody())).body.data;
  const r = await call(base, '/auth/login', { email: 'maya.new@example.com', password: 'correct-horse-1', role: 'host' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.user_id, host.host_id);
  assert.strictEqual(r.body.data.role, 'host');
  // Asking for the guest account of a host-only email fails like any wrong login
  const wrongType = await call(base, '/auth/login', { email: 'maya.new@example.com', password: 'correct-horse-1', role: 'guest' });
  assert.strictEqual(wrongType.status, 401);
}));

test('auth/login: wrong password and unknown email give the same 401', () => withServer(async ({ base }) => {
  await call(base, '/guests/create', guestBody());
  const wrong = await call(base, '/auth/login', { email: 'ana.new@example.com', password: 'nope-nope-nope' });
  const unknown = await call(base, '/auth/login', { email: 'nobody@example.com', password: 'nope-nope-nope' });
  for (const r of [wrong, unknown]) {
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.error.code, 'UNAUTHENTICATED');
    assert.strictEqual(r.body.error.message, 'Invalid email or password.');
    assert.ok(!r.body.data);
  }
}));

test('auth/login: soft-deleted account cannot log in', () => withServer(async ({ base, guests }) => {
  const g = (await call(base, '/guests/create', guestBody())).body.data;
  guests.rows.get(g.guest_id).is_deleted = 1;
  const r = await call(base, '/auth/login', { email: 'ana.new@example.com', password: 'correct-horse-1' });
  assert.strictEqual(r.status, 401);
}));

test('auth/login: admin role comes only from hosts.access_level set in the database', () => withServer(async ({ base, hosts }) => {
  const hash = await bcrypt.hash('admin-pass-123', 4);
  hosts.seed({ host_id: 'hst_admin', name: 'Ops', email: 'ops@example.com', password_hash: hash, access_level: 'admin' });
  const r = await call(base, '/auth/login', { email: 'ops@example.com', password: 'admin-pass-123', role: 'host' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.role, 'admin');
  assert.strictEqual(jwt.verify(r.body.data.token, 'test-secret').role, 'admin');

  // A superhost is still a host
  hosts.seed({ host_id: 'hst_super', name: 'Super', email: 'super@example.com', password_hash: hash, access_level: 'superhost' });
  const s = await call(base, '/auth/login', { email: 'super@example.com', password: 'admin-pass-123' });
  assert.strictEqual(s.body.data.role, 'host');
}));

test('auth/login: same email as guest and host -> role required only once the password matched both', () => withServer(async ({ base }) => {
  await call(base, '/guests/create', guestBody({ email: 'both@example.com' }));
  await call(base, '/hosts/create', hostBody({ email: 'both@example.com' }));
  const ambiguous = await call(base, '/auth/login', { email: 'both@example.com', password: 'correct-horse-1' });
  assert.strictEqual(ambiguous.status, 409);
  assert.strictEqual(ambiguous.body.error.code, 'AMBIGUOUS_ACCOUNT');
  // A wrong password does not reveal that both accounts exist
  const wrong = await call(base, '/auth/login', { email: 'both@example.com', password: 'wrong-wrong-1' });
  assert.strictEqual(wrong.status, 401);
  const guest = await call(base, '/auth/login', { email: 'both@example.com', password: 'correct-horse-1', role: 'guest' });
  assert.strictEqual(guest.body.data.role, 'guest');
}));

test('auth/login: validation -> 400; unknown role values rejected', () => withServer(async ({ base }) => {
  for (const body of [{}, { email: 'a@example.com' }, { password: 'x' }, { email: 'a@example.com', password: 'x', role: 'admin' }, { email: 'a@example.com', password: 'x', extra: 1 }]) {
    const r = await call(base, '/auth/login', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
}));

test('auth/login: JWT_EXPIRES_IN_SECONDS controls the lifetime', () => withServer(async ({ base }) => {
  await call(base, '/guests/create', guestBody());
  process.env.JWT_EXPIRES_IN_SECONDS = '60';
  try {
    const s = (await call(base, '/auth/login', { email: 'ana.new@example.com', password: 'correct-horse-1' })).body.data;
    const ttl = Date.parse(s.expires_at) - Date.now();
    assert.ok(ttl > 50_000 && ttl <= 60_000, `ttl ${ttl}ms`);
  } finally {
    delete process.env.JWT_EXPIRES_IN_SECONDS;
  }
}));
