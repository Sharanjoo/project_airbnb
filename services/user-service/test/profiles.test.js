process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4';
process.env.PUBLISH_WAIT_MS = '50';
// Profile endpoints (phase 2) with in-memory repos: ownership, roles, optimistic
// locking, soft delete, admin search and user.updated events.
// The same flows against the real MySQL are in test/integration/profiles.int.js.
const test = require('node:test');
const assert = require('node:assert');
const { createApp, logger, validateEnvelope } = require('@airbnb/common');
const { buildRouter } = require('../src/routes');
const guestModel = require('../src/models/guest');
const hostModel = require('../src/models/host');

// ---------------------------------------------------------------- fakes (same interface as src/models/*.js)
function fakeGuests() {
  const rows = new Map();
  const active = new Map(); // guest_id -> active reservation count
  const api = {
    rows,
    active,
    toApi: guestModel.toApi,
    seed(over) {
      const row = {
        guest_id: 'gst_0001', first_name: 'Ana', last_name: 'Rivera', email: 'ana@example.com', phone: '+14085550201',
        location: 'San Jose, CA', profile_photo_url: null, preferences: { budget_max: 250 }, saved_properties_count: 2,
        booking_count: 1, profile_created_datetime: '2026-11-01 10:00:00.000', is_deleted: 0, version: 1, ...over,
      };
      rows.set(row.guest_id, row);
      return row;
    },
    async findById(id) { const r = rows.get(id); return r && !r.is_deleted ? { ...r } : null; },
    async findByIdAnyStatus(id) { const r = rows.get(id); return r ? { ...r } : null; },
    async updateWithVersion(id, version, changes) {
      const r = rows.get(id);
      if (!r || r.is_deleted || r.version !== version) return { updated: false, row: r ? { ...r } : null };
      for (const field of Object.keys(changes)) if (!guestModel.EDITABLE[field]) throw new Error(`not editable ${field}`);
      Object.assign(r, changes, { version: r.version + 1 });
      return { updated: true, row: { ...r } };
    },
    async softDelete(id) {
      const r = rows.get(id);
      if (!r || r.is_deleted) return false;
      r.is_deleted = 1;
      r.version += 1;
      return true;
    },
    async countActiveReservations(id) { return active.get(id) || 0; },
    async softDeleteIfNoActiveReservations(id) {
      const r = rows.get(id);
      if (!r) return { outcome: 'missing' };
      if (r.is_deleted) return { outcome: 'already' };
      if (active.get(id)) return { outcome: 'active', active: active.get(id) };
      r.is_deleted = 1;
      r.version += 1;
      return { outcome: 'deleted', version: r.version };
    },
    async search({ q, includeDeleted, page, pageSize }) {
      api.lastSearch = { q, includeDeleted, page, pageSize };
      const all = [...rows.values()].filter((r) => includeDeleted || !r.is_deleted)
        .filter((r) => !q || `${r.first_name} ${r.last_name}`.includes(q) || r.email.startsWith(q.toLowerCase()));
      return { rows: all.slice((page - 1) * pageSize, page * pageSize), total: all.length };
    },
  };
  return api;
}

function fakeHosts() {
  const rows = new Map();
  return {
    rows,
    toApi: hostModel.toApi,
    toPublic: hostModel.toPublic,
    seed(over) {
      const row = {
        host_id: 'hst_0001', name: 'Maya Chen', email: 'maya.host@example.com', phone: '+14085550101', profile_photo_url: null,
        verification_status: 'verified', response_rate: '0.950', response_time: 45, host_since: '2026-01-01 00:00:00.000',
        access_level: 'superhost', is_deleted: 0, version: 1, ...over,
      };
      rows.set(row.host_id, row);
      return row;
    },
    async findById(id) { const r = rows.get(id); return r && !r.is_deleted ? { ...r } : null; },
    async updateWithVersion(id, version, changes) {
      const r = rows.get(id);
      if (!r || r.is_deleted || r.version !== version) return { updated: false, row: r ? { ...r } : null };
      Object.assign(r, changes, { version: r.version + 1 });
      return { updated: true, row: { ...r } };
    },
  };
}

function fakeRevocation() {
  const marked = [];
  return { marked, redisUp: true, async markRevoked(id) { marked.push(id); return this.redisUp; } };
}

function fakeBus() {
  const sent = [];
  return { sent, publish: async (topic, env, key) => { sent.push({ topic, env, key }); } };
}

async function withServer(fn) {
  const guests = fakeGuests();
  const hosts = fakeHosts();
  guests.seed();
  guests.seed({ guest_id: 'gst_0002', first_name: 'Ben', last_name: 'Okafor', email: 'ben@example.com' });
  hosts.seed();
  hosts.seed({ host_id: 'hst_0002', name: 'Luis Ortega', email: 'luis.host@example.com', access_level: 'standard' });
  const bus = fakeBus();
  const revocation = fakeRevocation();
  const app = createApp({ name: 'user-test', logger });
  app.use(buildRouter({ bus, guests, hosts, revocation }));
  app.finalize();
  const server = app.listen(0);
  try {
    await fn({ base: `http://127.0.0.1:${server.address().port}`, guests, hosts, bus, revocation });
  } finally {
    server.close();
  }
}

const as = (id, role) => ({ 'X-User-Id': id, 'X-User-Role': role });
const ANA = as('gst_0001', 'guest');
const BEN = as('gst_0002', 'guest');
const MAYA = as('hst_0001', 'host');
const LUIS = as('hst_0002', 'host');
const ADMIN = as('hst_admin', 'admin');

const call = async (base, path, body, headers = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

// ---------------------------------------------------------------- guests/get
test('guests/get: guest reads their own profile, with counters and no secrets', () => withServer(async ({ base }) => {
  const r = await call(base, '/guests/get', { guest_id: 'gst_0001' }, ANA);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.guest_id, 'gst_0001');
  assert.strictEqual(r.body.data.booking_count, 1);
  assert.strictEqual(r.body.data.saved_properties_count, 2);
  assert.strictEqual(r.body.data.version, 1);
  for (const k of ['password_hash', 'is_deleted']) assert.ok(!(k in r.body.data));
}));

test('guests/get: another guest -> 403, a host -> 403, no token -> 401, admin -> 200', () => withServer(async ({ base }) => {
  assert.strictEqual((await call(base, '/guests/get', { guest_id: 'gst_0001' }, BEN)).status, 403);
  assert.strictEqual((await call(base, '/guests/get', { guest_id: 'gst_0001' }, MAYA)).status, 403);
  assert.strictEqual((await call(base, '/guests/get', { guest_id: 'gst_0001' })).status, 401);
  assert.strictEqual((await call(base, '/guests/get', { guest_id: 'gst_0001' }, ADMIN)).status, 200);
}));

test('guests/get: unknown or deleted guest -> 404; bad ids -> 400', () => withServer(async ({ base, guests }) => {
  assert.strictEqual((await call(base, '/guests/get', { guest_id: 'gst_9999' }, ADMIN)).status, 404);
  guests.rows.get('gst_0002').is_deleted = 1;
  assert.strictEqual((await call(base, '/guests/get', { guest_id: 'gst_0002' }, BEN)).status, 404);
  for (const body of [{}, { guest_id: 'hst_0001' }, { guest_id: "gst_1' OR 1=1" }, { guest_id: 'gst_0001', extra: 1 }]) {
    assert.strictEqual((await call(base, '/guests/get', body, ADMIN)).status, 400, JSON.stringify(body));
  }
}));

// ---------------------------------------------------------------- guests/update
test('guests/update: version matches -> 200, version + 1, user.updated with field names only', () => withServer(async ({ base, bus }) => {
  const r = await call(base, '/guests/update', { guest_id: 'gst_0001', version: 1, location: 'Oakland, CA', phone: null }, ANA);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.location, 'Oakland, CA');
  assert.strictEqual(r.body.data.phone, null);
  assert.strictEqual(r.body.data.version, 2);

  assert.strictEqual(bus.sent.length, 1);
  const { topic, env, key } = bus.sent[0];
  assert.strictEqual(topic, 'user.updated');
  assert.strictEqual(key, 'gst_0001');
  assert.deepStrictEqual(validateEnvelope(env, topic), { valid: true });
  assert.deepStrictEqual(env.payload, { user_id: 'gst_0001', user_type: 'guest', changed_fields: ['location', 'phone'], version: 2, deleted: false });
  assert.strictEqual(env.idempotency_key, 'gst_0001:v2');
  assert.strictEqual(env.actor_id, 'gst_0001');
  assert.ok(!JSON.stringify(env.payload).includes('Oakland'), 'no values in the event');
}));

test('guests/update: stale version -> 409 VERSION_CONFLICT with the current version, nothing changed', () => withServer(async ({ base, guests, bus }) => {
  await call(base, '/guests/update', { guest_id: 'gst_0001', version: 1, first_name: 'Anna' }, ANA);
  const r = await call(base, '/guests/update', { guest_id: 'gst_0001', version: 1, first_name: 'Annie' }, ANA);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'VERSION_CONFLICT');
  assert.strictEqual(r.body.error.retryable, true);
  assert.match(r.body.error.details[0].issue, /current version is 2/);
  assert.strictEqual(guests.rows.get('gst_0001').first_name, 'Anna');
  assert.strictEqual(bus.sent.length, 1);
}));

test('guests/update: cannot change email, password, counters, version source or deleted flag', () => withServer(async ({ base, guests }) => {
  for (const extra of [{ email: 'x@example.com' }, { password: 'new-password-1' }, { booking_count: 99 },
    { saved_properties_count: 0 }, { is_deleted: true }, { role: 'admin' }, { guest_id_new: 'x' }]) {
    const r = await call(base, '/guests/update', { guest_id: 'gst_0001', version: 1, ...extra }, ANA);
    assert.strictEqual(r.status, 400, JSON.stringify(extra));
  }
  assert.strictEqual(guests.rows.get('gst_0001').version, 1);
}));

test('guests/update: validation -> 400 (no change, blank name, bad phone, bad url, missing version)', () => withServer(async ({ base }) => {
  for (const body of [
    { guest_id: 'gst_0001', version: 1 },
    { guest_id: 'gst_0001', version: 1, first_name: '' },
    { guest_id: 'gst_0001', version: 1, first_name: null },
    { guest_id: 'gst_0001', version: 1, phone: '555' },
    { guest_id: 'gst_0001', version: 1, profile_photo_url: 'javascript:alert(1)' },
    { guest_id: 'gst_0001', location: 'x' },
    { guest_id: 'gst_0001', version: 0, location: 'x' },
  ]) {
    assert.strictEqual((await call(base, '/guests/update', body, ANA)).status, 400, JSON.stringify(body));
  }
}));

test("guests/update: another guest's profile -> 403; admin may, and is the event actor", () => withServer(async ({ base, bus }) => {
  assert.strictEqual((await call(base, '/guests/update', { guest_id: 'gst_0001', version: 1, location: 'x' }, BEN)).status, 403);
  const r = await call(base, '/guests/update', { guest_id: 'gst_0001', version: 1, location: 'Fixed by support' }, ADMIN);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(bus.sent[0].env.actor_id, 'hst_admin');
  assert.strictEqual(bus.sent[0].env.actor_type, 'admin');
}));

test('guests/update: deleted guest -> 404', () => withServer(async ({ base, guests }) => {
  guests.rows.get('gst_0001').is_deleted = 1;
  assert.strictEqual((await call(base, '/guests/update', { guest_id: 'gst_0001', version: 1, location: 'x' }, ANA)).status, 404);
}));

// ---------------------------------------------------------------- guests/delete
test('guests/delete: soft delete -> 200, user.updated deleted:true; repeat is harmless', () => withServer(async ({ base, guests, bus }) => {
  const r = await call(base, '/guests/delete', { guest_id: 'gst_0001' }, ANA);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.data, { guest_id: 'gst_0001', deleted: true });
  assert.strictEqual(guests.rows.get('gst_0001').is_deleted, 1);
  assert.strictEqual(bus.sent[0].topic, 'user.updated');
  assert.strictEqual(bus.sent[0].env.payload.deleted, true);
  assert.deepStrictEqual(bus.sent[0].env.payload.changed_fields, ['is_deleted']);
  assert.strictEqual(bus.sent[0].env.idempotency_key, 'gst_0001:deleted');

  const again = await call(base, '/guests/delete', { guest_id: 'gst_0001' }, ANA);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(bus.sent.length, 1, 'no second event');
  // A deleted guest's still-valid token can no longer read the profile
  assert.strictEqual((await call(base, '/guests/get', { guest_id: 'gst_0001' }, ANA)).status, 404);
}));

test('guests/delete: revokes the account\'s tokens (Redis marker), and re-arms it on a repeat', () => withServer(async ({ base, revocation }) => {
  await call(base, '/guests/delete', { guest_id: 'gst_0001' }, ANA);
  assert.deepStrictEqual(revocation.marked, ['gst_0001']);
  await call(base, '/guests/delete', { guest_id: 'gst_0001' }, ANA);
  assert.deepStrictEqual(revocation.marked, ['gst_0001', 'gst_0001'], 'a repeat restores the marker in case Redis lost it');
}));

test('guests/delete: Redis down -> still deleted (MySQL is the source of truth), 200', () => withServer(async ({ base, guests, revocation }) => {
  revocation.redisUp = false;
  const r = await call(base, '/guests/delete', { guest_id: 'gst_0001' }, ANA);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(guests.rows.get('gst_0001').is_deleted, 1);
}));

test('guests/delete: active reservations -> 409 INVALID_STATE_TRANSITION, not deleted, not revoked', () => withServer(async ({ base, guests, bus, revocation }) => {
  guests.active.set('gst_0001', 2);
  const r = await call(base, '/guests/delete', { guest_id: 'gst_0001' }, ANA);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'INVALID_STATE_TRANSITION');
  assert.strictEqual(guests.rows.get('gst_0001').is_deleted, 0);
  assert.strictEqual(bus.sent.length, 0);
  assert.deepStrictEqual(revocation.marked, []);
}));

test('guests/delete: someone else -> 403, host -> 403, unknown -> 404, admin -> 200', () => withServer(async ({ base }) => {
  assert.strictEqual((await call(base, '/guests/delete', { guest_id: 'gst_0001' }, BEN)).status, 403);
  assert.strictEqual((await call(base, '/guests/delete', { guest_id: 'gst_0001' }, MAYA)).status, 403);
  assert.strictEqual((await call(base, '/guests/delete', { guest_id: 'gst_9999' }, ADMIN)).status, 404);
  assert.strictEqual((await call(base, '/guests/delete', { guest_id: 'gst_0001' }, ADMIN)).status, 200);
}));

// ---------------------------------------------------------------- guests/search
test('guests/search: admin only; paginated { items, page, page_size, total }', () => withServer(async ({ base, guests }) => {
  assert.strictEqual((await call(base, '/guests/search', {}, ANA)).status, 403);
  assert.strictEqual((await call(base, '/guests/search', {}, MAYA)).status, 403);
  const r = await call(base, '/guests/search', { q: 'Ana', page_size: 10 }, ADMIN);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.total, 1);
  assert.strictEqual(r.body.data.page, 1);
  assert.strictEqual(r.body.data.page_size, 10);
  assert.strictEqual(r.body.data.items[0].guest_id, 'gst_0001');
  assert.strictEqual(r.body.data.items[0].deleted, false);
  assert.ok(!('password_hash' in r.body.data.items[0]));
  assert.deepStrictEqual(guests.lastSearch, { q: 'Ana', includeDeleted: false, page: 1, pageSize: 10 });
}));

test('guests/search: deleted guests only with include_deleted; page_size capped at 100', () => withServer(async ({ base, guests }) => {
  guests.rows.get('gst_0002').is_deleted = 1;
  assert.strictEqual((await call(base, '/guests/search', {}, ADMIN)).body.data.total, 1);
  const all = await call(base, '/guests/search', { include_deleted: true }, ADMIN);
  assert.strictEqual(all.body.data.total, 2);
  assert.strictEqual(all.body.data.items.find((g) => g.guest_id === 'gst_0002').deleted, true);
  assert.strictEqual((await call(base, '/guests/search', { page_size: 101 }, ADMIN)).status, 400);
  assert.strictEqual((await call(base, '/guests/search', { sort: 'email' }, ADMIN)).status, 400);
}));

// ---------------------------------------------------------------- hosts
test('hosts/get: a guest sees the public profile (no email, phone or version)', () => withServer(async ({ base }) => {
  const r = await call(base, '/hosts/get', { host_id: 'hst_0001' }, ANA);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.name, 'Maya Chen');
  assert.strictEqual(r.body.data.verification_status, 'verified');
  assert.strictEqual(r.body.data.response_rate, 0.95);
  for (const k of ['email', 'phone', 'version', 'access_level', 'password_hash']) assert.ok(!(k in r.body.data), k);
}));

test('hosts/get: the host themself and admins see contact details; another host does not', () => withServer(async ({ base }) => {
  assert.strictEqual((await call(base, '/hosts/get', { host_id: 'hst_0001' }, MAYA)).body.data.email, 'maya.host@example.com');
  assert.strictEqual((await call(base, '/hosts/get', { host_id: 'hst_0001' }, ADMIN)).body.data.phone, '+14085550101');
  assert.strictEqual((await call(base, '/hosts/get', { host_id: 'hst_0001' }, LUIS)).body.data.email, undefined);
  assert.ok(!('access_level' in (await call(base, '/hosts/get', { host_id: 'hst_0001' }, MAYA)).body.data));
}));

test('hosts/get: no identity -> 401, unknown or deleted -> 404', () => withServer(async ({ base, hosts }) => {
  assert.strictEqual((await call(base, '/hosts/get', { host_id: 'hst_0001' })).status, 401);
  assert.strictEqual((await call(base, '/hosts/get', { host_id: 'hst_9999' }, ANA)).status, 404);
  hosts.rows.get('hst_0002').is_deleted = 1;
  assert.strictEqual((await call(base, '/hosts/get', { host_id: 'hst_0002' }, ANA)).status, 404);
}));

test('hosts/update: own profile -> 200 + user.updated; stale version -> 409', () => withServer(async ({ base, bus }) => {
  const r = await call(base, '/hosts/update', { host_id: 'hst_0001', version: 1, name: 'Maya C.' }, MAYA);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.name, 'Maya C.');
  assert.strictEqual(r.body.data.version, 2);
  assert.strictEqual(bus.sent[0].topic, 'user.updated');
  assert.deepStrictEqual(bus.sent[0].env.payload, { user_id: 'hst_0001', user_type: 'host', changed_fields: ['name'], version: 2, deleted: false });
  const stale = await call(base, '/hosts/update', { host_id: 'hst_0001', version: 1, name: 'Other' }, MAYA);
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.error.code, 'VERSION_CONFLICT');
}));

test('hosts/update: cannot self-verify, self-promote or edit analytics fields', () => withServer(async ({ base, hosts }) => {
  for (const extra of [{ access_level: 'admin' }, { verification_status: 'verified' }, { response_rate: 1 },
    { response_time: 1 }, { email: 'x@example.com' }, { password: 'new-password-1' }]) {
    assert.strictEqual((await call(base, '/hosts/update', { host_id: 'hst_0002', version: 1, ...extra }, LUIS)).status, 400, JSON.stringify(extra));
  }
  assert.strictEqual(hosts.rows.get('hst_0002').access_level, 'standard');
}));

test("hosts/update: another host's profile -> 403, guest -> 403, admin -> 200", () => withServer(async ({ base }) => {
  assert.strictEqual((await call(base, '/hosts/update', { host_id: 'hst_0001', version: 1, name: 'x' }, LUIS)).status, 403);
  assert.strictEqual((await call(base, '/hosts/update', { host_id: 'hst_0001', version: 1, name: 'x' }, ANA)).status, 403);
  assert.strictEqual((await call(base, '/hosts/update', { host_id: 'hst_0001', version: 1, name: 'Support edit' }, ADMIN)).status, 200);
}));
