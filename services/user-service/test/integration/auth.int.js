// Integration test against the real MySQL from docker compose.
//   npm run infra:up   then   npm run test:db -w services/user-service
// Covers what the in-memory tests cannot: the real UNIQUE key under concurrent
// sign-ups, column defaults, the case-insensitive collation, the seed accounts,
// and the foreign keys that require a signed-up user before a property, booking
// or saved listing can reference them.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'int-secret';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { createApp, logger, getMysql, newId } = require('@airbnb/common');
const { buildRouter } = require('../../src/routes');
const guests = require('../../src/models/guest');
const hosts = require('../../src/models/host');

const DOMAIN = `int-${Date.now()}.example.com`; // unique per run, so reruns never collide
const mail = (local) => `${local}@${DOMAIN}`;
const db = () => getMysql();

let server;
let base;
const sent = [];

test.before(async () => {
  const app = createApp({ name: 'user-int', logger });
  app.use(buildRouter({ bus: { publish: async (topic, env, key) => { sent.push({ topic, env, key }); } } }));
  app.finalize();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  const like = `%@${DOMAIN}`;
  await db().execute('DELETE FROM saved_properties WHERE guest_id IN (SELECT guest_id FROM guests WHERE email LIKE ?)', [like]);
  await db().execute('DELETE FROM reservations WHERE guest_id IN (SELECT guest_id FROM guests WHERE email LIKE ?)', [like]);
  await db().execute('DELETE FROM properties WHERE host_id IN (SELECT host_id FROM hosts WHERE email LIKE ?)', [like]);
  await db().execute('DELETE FROM guests WHERE email LIKE ?', [like]);
  await db().execute('DELETE FROM hosts WHERE email LIKE ?', [like]);
  await db().end();
});

const call = async (path, body) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('guest sign-up writes a real row: bcrypt hash, column defaults, JSON preferences', async () => {
  const r = await call('/guests/create', {
    first_name: 'Int', last_name: 'Guest', email: mail('guest1'), password: 'correct-horse-1',
    location: 'San Jose, CA', preferences: { budget_max: 200, amenities: ['wifi'] },
  });
  assert.strictEqual(r.status, 201);
  const g = r.body.data;
  assert.strictEqual(g.saved_properties_count, 0);
  assert.strictEqual(g.booking_count, 0);
  assert.strictEqual(g.version, 1);
  assert.deepStrictEqual(g.preferences, { budget_max: 200, amenities: ['wifi'] });
  assert.match(g.profile_created_datetime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const [[row]] = await db().execute('SELECT password_hash, is_deleted FROM guests WHERE guest_id = ?', [g.guest_id]);
  assert.match(row.password_hash, /^\$2[aby]\$\d{2}\$.{53}$/);
  assert.strictEqual(row.is_deleted, 0);
  assert.strictEqual(sent.at(-1).topic, 'user.created');
});

test('host sign-up: access_level standard and verification pending come from the column defaults', async () => {
  const r = await call('/hosts/create', { name: 'Int Host', email: mail('host1'), password: 'correct-horse-1' });
  assert.strictEqual(r.status, 201);
  const [[row]] = await db().execute('SELECT access_level, verification_status FROM hosts WHERE host_id = ?', [r.body.data.host_id]);
  assert.deepStrictEqual({ ...row }, { access_level: 'standard', verification_status: 'pending' });
});

test('10 concurrent sign-ups with one email: exactly one row, the rest 409 EMAIL_TAKEN', async () => {
  const email = mail('race');
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => call('/guests/create', {
    first_name: `Racer${i}`, last_name: 'Test', email, password: 'correct-horse-1',
  })));
  const statuses = results.map((r) => r.status).sort();
  assert.deepStrictEqual(statuses, [201, ...Array(9).fill(409)]);
  assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'EMAIL_TAKEN'));
  const [[{ n }]] = await db().execute('SELECT COUNT(*) AS n FROM guests WHERE email = ?', [email]);
  assert.strictEqual(n, 1);
});

test('the database itself rejects a duplicate that differs only in case', async () => {
  await guests.insert({ guest_id: newId('gst'), first_name: 'A', last_name: 'B', email: mail('case'), password_hash: 'x' });
  await assert.rejects(
    guests.insert({ guest_id: newId('gst'), first_name: 'A', last_name: 'B', email: mail('CASE').toUpperCase(), password_hash: 'x' }),
    (err) => err.code === 'ER_DUP_ENTRY',
  );
});

test('sign up -> log in -> token claims match the MySQL row', async () => {
  const created = (await call('/hosts/create', { name: 'Login Host', email: mail('login'), password: 'correct-horse-1' })).body.data;
  const r = await call('/auth/login', { email: mail('login'), password: 'correct-horse-1', role: 'host' });
  assert.strictEqual(r.status, 200);
  const claims = jwt.verify(r.body.data.token, 'int-secret', { algorithms: ['HS256'] });
  assert.strictEqual(claims.sub, created.host_id);
  assert.strictEqual(claims.role, 'host');
  assert.ok(await hosts.findById(claims.sub), 'the token subject exists in MySQL');

  const wrong = await call('/auth/login', { email: mail('login'), password: 'wrong-password', role: 'host' });
  assert.strictEqual(wrong.status, 401);
});

test('seed accounts from 002_seed.sql log in with password123 (compatibility with slice 2/3 demos)', async () => {
  const guest = await call('/auth/login', { email: 'ana@example.com', password: 'password123', role: 'guest' });
  assert.strictEqual(guest.status, 200);
  assert.strictEqual(guest.body.data.user_id, 'gst_0001');
  const host = await call('/auth/login', { email: 'maya.host@example.com', password: 'password123', role: 'host' });
  assert.strictEqual(host.body.data.user_id, 'hst_0001');
  assert.strictEqual(host.body.data.role, 'host'); // superhost is still role host
});

test('admin role only after access_level is set in the database, never through sign-up', async () => {
  const h = (await call('/hosts/create', { name: 'Ops', email: mail('ops'), password: 'correct-horse-1' })).body.data;
  assert.strictEqual((await call('/auth/login', { email: mail('ops'), password: 'correct-horse-1' })).body.data.role, 'host');
  await db().execute("UPDATE hosts SET access_level = 'admin' WHERE host_id = ?", [h.host_id]);
  assert.strictEqual((await call('/auth/login', { email: mail('ops'), password: 'correct-horse-1' })).body.data.role, 'admin');
});

test('soft-deleted account cannot log in', async () => {
  const g = (await call('/guests/create', { first_name: 'Gone', last_name: 'User', email: mail('gone'), password: 'correct-horse-1' })).body.data;
  await db().execute('UPDATE guests SET is_deleted = TRUE WHERE guest_id = ?', [g.guest_id]);
  assert.strictEqual((await call('/auth/login', { email: mail('gone'), password: 'correct-horse-1' })).status, 401);
});

// ---- the user must exist in MySQL before slice 2/3 rows can point at them
test('a signed-up host can own a property; an unknown host id cannot (fk_properties_host)', async () => {
  const h = (await call('/hosts/create', { name: 'FK Host', email: mail('fkhost'), password: 'correct-horse-1' })).body.data;
  const insertProperty = (hostId) => db().execute(
    `INSERT INTO properties (property_id, host_id, title, description, property_type, address_line1, city, state, zip,
       capacity, bedrooms, bathrooms, amenities, nightly_price) VALUES (?, ?, 'FK test', 'x', 'apartment', '1 Main', 'San Jose', 'CA', '95113', 2, 1, 1, '[]', 100)`,
    [newId('prp'), hostId],
  );
  await insertProperty(h.host_id);
  await assert.rejects(insertProperty(newId('hst')), (err) => err.code === 'ER_NO_REFERENCED_ROW_2');
});

test('a signed-up guest can have a reservation and a saved listing; an unknown guest id cannot', async () => {
  const g = (await call('/guests/create', { first_name: 'FK', last_name: 'Guest', email: mail('fkguest'), password: 'correct-horse-1' })).body.data;
  const reserve = (guestId) => db().execute(
    `INSERT INTO reservations (reservation_id, property_id, guest_id, host_id, check_in, check_out, guest_count, price_breakdown, total_price, status, trace_id)
     VALUES (?, 'prp_0001', ?, 'hst_0001', '2030-01-01', '2030-01-03', 1, '{}', 100, 'REQUESTED', ?)`,
    [newId('res'), guestId, '00000000-0000-4000-8000-000000000000'],
  );
  await reserve(g.guest_id);
  await assert.rejects(reserve(newId('gst')), (err) => err.code === 'ER_NO_REFERENCED_ROW_2');
  await db().execute('INSERT INTO saved_properties (guest_id, property_id) VALUES (?, ?)', [g.guest_id, 'prp_0001']);
  await assert.rejects(
    db().execute('INSERT INTO saved_properties (guest_id, property_id) VALUES (?, ?)', [newId('gst'), 'prp_0001']),
    (err) => err.code === 'ER_NO_REFERENCED_ROW_2',
  );
});
