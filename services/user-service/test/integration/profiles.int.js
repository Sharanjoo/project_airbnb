// Profile endpoints against the real MySQL from docker compose.
//   npm run infra:up   then   npm run test:db -w services/user-service
process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert');
const { createApp, logger, getMysql, newId } = require('@airbnb/common');
const { buildRouter } = require('../../src/routes');
const guests = require('../../src/models/guest');

const DOMAIN = `prof-${Date.now()}.example.com`;
const mail = (local) => `${local}@${DOMAIN}`;
const db = () => getMysql();
const sent = [];
let server;
let base;

test.before(() => {
  const app = createApp({ name: 'user-int', logger });
  app.use(buildRouter({ bus: { publish: async (topic, env) => { sent.push({ topic, env }); } } }));
  app.finalize();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  const like = `%@${DOMAIN}`;
  await db().execute('DELETE FROM reservations WHERE guest_id IN (SELECT guest_id FROM guests WHERE email LIKE ?)', [like]);
  await db().execute('DELETE FROM guests WHERE email LIKE ?', [like]);
  await db().execute('DELETE FROM hosts WHERE email LIKE ?', [like]);
  await db().end();
});

const call = async (path, body, user) => {
  const headers = { 'Content-Type': 'application/json' };
  if (user) Object.assign(headers, { 'X-User-Id': user.id, 'X-User-Role': user.role });
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

async function newGuest(local, over = {}) {
  const r = await call('/guests/create', { first_name: 'Int', last_name: 'Guest', email: mail(local), password: 'correct-horse-1', ...over });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.data;
}

const ADMIN = { id: 'hst_admin_int', role: 'admin' };

test('update: real optimistic lock, JSON preferences round trip, null clears a field', async () => {
  const g = await newGuest('upd', { phone: '+14085550999', location: 'San Jose, CA' });
  const me = { id: g.guest_id, role: 'guest' };
  const r = await call('/guests/update', {
    guest_id: g.guest_id, version: 1, phone: null, preferences: { amenities: ['wifi', 'kitchen'], pet_friendly: true },
  }, me);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.version, 2);
  assert.strictEqual(r.body.data.phone, null);
  assert.deepStrictEqual(r.body.data.preferences, { amenities: ['wifi', 'kitchen'], pet_friendly: true });
  const [[row]] = await db().execute('SELECT phone, version, location FROM guests WHERE guest_id = ?', [g.guest_id]);
  assert.deepStrictEqual({ ...row }, { phone: null, version: 2, location: 'San Jose, CA' });

  const stale = await call('/guests/update', { guest_id: g.guest_id, version: 1, location: 'Oakland, CA' }, me);
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.error.code, 'VERSION_CONFLICT');
});

test('update: 8 concurrent edits with the same version -> exactly one wins, the rest 409', async () => {
  const g = await newGuest('race');
  const me = { id: g.guest_id, role: 'guest' };
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call('/guests/update', { guest_id: g.guest_id, version: 1, location: `City ${i}` }, me)));
  const statuses = results.map((r) => r.status).sort();
  assert.deepStrictEqual(statuses, [200, ...Array(7).fill(409)]);
  const [[row]] = await db().execute('SELECT version, location FROM guests WHERE guest_id = ?', [g.guest_id]);
  assert.strictEqual(row.version, 2);
  const winner = results.find((r) => r.status === 200).body.data;
  assert.strictEqual(row.location, winner.location);
  assert.strictEqual(winner.version, 2, 'the response is this edit, not a later one');
  const events = sent.filter((e) => e.topic === 'user.updated' && e.env.entity.entity_id === g.guest_id);
  assert.strictEqual(events.length, 1, 'only the winner publishes user.updated');
  assert.strictEqual(events[0].env.idempotency_key, `${g.guest_id}:v2`);
  assert.strictEqual(events[0].env.payload.version, 2);
});

test('update: back-to-back edits each publish their own version (no shared idempotency key)', async () => {
  const g = await newGuest('seq');
  const me = { id: g.guest_id, role: 'guest' };
  // Second edit fires as soon as the first returns, using the version it handed back
  const first = await call('/guests/update', { guest_id: g.guest_id, version: 1, location: 'A' }, me);
  const second = await call('/guests/update', { guest_id: g.guest_id, version: first.body.data.version, location: 'B' }, me);
  assert.deepStrictEqual([first.body.data.version, second.body.data.version], [2, 3]);
  const keys = sent.filter((e) => e.topic === 'user.updated' && e.env.entity.entity_id === g.guest_id).map((e) => e.env.idempotency_key);
  assert.deepStrictEqual(keys, [`${g.guest_id}:v2`, `${g.guest_id}:v3`]);
});

test('counters are untouched by a profile update (derived data never bumps version)', async () => {
  const g = await newGuest('counters');
  await db().execute('UPDATE guests SET booking_count = 4, saved_properties_count = 7 WHERE guest_id = ?', [g.guest_id]);
  const r = await call('/guests/update', { guest_id: g.guest_id, version: 1, first_name: 'Renamed' }, { id: g.guest_id, role: 'guest' });
  assert.strictEqual(r.body.data.booking_count, 4);
  assert.strictEqual(r.body.data.saved_properties_count, 7);
});

test('delete: blocked by an upcoming REQUESTED reservation, allowed once it is cancelled, then login fails', async () => {
  const g = await newGuest('del');
  const me = { id: g.guest_id, role: 'guest' };
  const resId = newId('res');
  await db().execute(
    `INSERT INTO reservations (reservation_id, property_id, guest_id, host_id, check_in, check_out, guest_count, price_breakdown, total_price, status, trace_id)
     VALUES (?, 'prp_0001', ?, 'hst_0001', DATE_ADD(CURRENT_DATE(), INTERVAL 30 DAY), DATE_ADD(CURRENT_DATE(), INTERVAL 32 DAY), 1, '{}', 100, 'REQUESTED', ?)`,
    [resId, g.guest_id, '00000000-0000-4000-8000-000000000000'],
  );
  const blocked = await call('/guests/delete', { guest_id: g.guest_id }, me);
  assert.strictEqual(blocked.status, 409);
  assert.strictEqual(blocked.body.error.code, 'INVALID_STATE_TRANSITION');

  await db().execute("UPDATE reservations SET status = 'CANCELLED' WHERE reservation_id = ?", [resId]);
  const r = await call('/guests/delete', { guest_id: g.guest_id }, me);
  assert.strictEqual(r.status, 200);
  const [[row]] = await db().execute('SELECT is_deleted, version FROM guests WHERE guest_id = ?', [g.guest_id]);
  assert.strictEqual(row.is_deleted, 1);
  assert.strictEqual(row.version, 2);
  assert.strictEqual(sent.at(-1).env.payload.deleted, true);

  assert.strictEqual((await call('/auth/login', { email: mail('del'), password: 'correct-horse-1' })).status, 401);
  assert.strictEqual((await call('/guests/get', { guest_id: g.guest_id }, me)).status, 404);
  assert.strictEqual((await call('/guests/delete', { guest_id: g.guest_id }, me)).status, 200, 'repeat is harmless');
});

test('delete: a past CONFIRMED stay does not block deletion', async () => {
  const g = await newGuest('past');
  await db().execute(
    `INSERT INTO reservations (reservation_id, property_id, guest_id, host_id, check_in, check_out, guest_count, price_breakdown, total_price, status, trace_id)
     VALUES (?, 'prp_0001', ?, 'hst_0001', '2020-01-01', '2020-01-03', 1, '{}', 100, 'CONFIRMED', ?)`,
    [newId('res'), g.guest_id, '00000000-0000-4000-8000-000000000000'],
  );
  assert.strictEqual(await guests.countActiveReservations(g.guest_id), 0);
});

test('search: name and email prefix, LIKE wildcards are literal, deleted only on request, pagination', async () => {
  const a = await newGuest('zed.search', { first_name: 'Zedekiah', last_name: 'Searchable' });
  await newGuest('zed.other', { first_name: 'Zedekiah', last_name: 'Other' });
  await newGuest('pct', { first_name: '100%', last_name: 'Literal' });

  const byName = await call('/guests/search', { q: 'Zedekiah', page_size: 1 }, ADMIN);
  assert.strictEqual(byName.status, 200);
  assert.strictEqual(byName.body.data.total, 2);
  assert.strictEqual(byName.body.data.items.length, 1);
  const page2 = await call('/guests/search', { q: 'Zedekiah', page: 2, page_size: 1 }, ADMIN);
  assert.notStrictEqual(page2.body.data.items[0].guest_id, byName.body.data.items[0].guest_id);

  const byEmail = await call('/guests/search', { q: 'ZED.SEARCH@' }, ADMIN);
  assert.deepStrictEqual(byEmail.body.data.items.map((x) => x.guest_id), [a.guest_id]);

  const pct = await call('/guests/search', { q: '100%' }, ADMIN);
  assert.strictEqual(pct.body.data.total, 1, '% is matched literally, not as a wildcard');
  const underscore = await call('/guests/search', { q: 'Zed_kiah' }, ADMIN);
  assert.strictEqual(underscore.body.data.total, 0, '_ is matched literally');

  await db().execute('UPDATE guests SET is_deleted = TRUE WHERE guest_id = ?', [a.guest_id]);
  assert.strictEqual((await call('/guests/search', { q: 'Zedekiah' }, ADMIN)).body.data.total, 1);
  const withDeleted = await call('/guests/search', { q: 'Zedekiah', include_deleted: true }, ADMIN);
  assert.strictEqual(withDeleted.body.data.total, 2);
  assert.strictEqual(withDeleted.body.data.items.find((x) => x.guest_id === a.guest_id).deleted, true);
});

test('hosts: get public vs full view, versioned update, verification and access level untouched', async () => {
  const h = (await call('/hosts/create', { name: 'Int Host', email: mail('host'), password: 'correct-horse-1', phone: '+14085550123' })).body.data;
  const host = { id: h.host_id, role: 'host' };
  const publicView = await call('/hosts/get', { host_id: h.host_id }, { id: 'gst_0001', role: 'guest' });
  assert.strictEqual(publicView.body.data.name, 'Int Host');
  assert.strictEqual(publicView.body.data.phone, undefined);
  assert.strictEqual((await call('/hosts/get', { host_id: h.host_id }, host)).body.data.phone, '+14085550123');

  const r = await call('/hosts/update', { host_id: h.host_id, version: 1, name: 'Renamed Host', phone: null }, host);
  assert.strictEqual(r.status, 200);
  const [[row]] = await db().execute('SELECT name, phone, version, access_level, verification_status FROM hosts WHERE host_id = ?', [h.host_id]);
  assert.deepStrictEqual({ ...row }, { name: 'Renamed Host', phone: null, version: 2, access_level: 'standard', verification_status: 'pending' });
  assert.strictEqual((await call('/hosts/update', { host_id: h.host_id, version: 1, name: 'x' }, host)).status, 409);
});
