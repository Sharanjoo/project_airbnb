process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { createApp, logger } = require('@airbnb/common');
const { buildRouter } = require('../src/routes');
const { toApi } = require('../src/models/property');

// ---------------------------------------------------------------- fakes
// In-memory repo with the same interface as src/models/property.js.
function fakeRepo({ upcoming = 0 } = {}) {
  const rows = new Map();
  const repo = {
    rows,
    toApi,
    async findByIdAnyStatus(id) { return rows.has(id) ? { ...rows.get(id) } : null; },
    async findById(id) { const r = rows.get(id); return r && r.status !== 'deleted' ? { ...r } : null; },
    async insert(p) {
      rows.set(p.property_id, {
        property_id: p.property_id, host_id: p.host_id, title: p.title, description: p.description,
        property_type: p.property_type, address_line1: p.address.line1, city: p.address.city,
        state: p.address.state, zip: p.address.zip, lat: p.address.lat ?? null, lng: p.address.lng ?? null,
        capacity: p.capacity, bedrooms: p.bedrooms, bathrooms: String(p.bathrooms), amenities: p.amenities,
        pet_friendly: p.pet_friendly ? 1 : 0, nightly_price: p.nightly_price.toFixed(2), cleaning_fee: p.cleaning_fee.toFixed(2),
        status: 'active', rating: null, review_count: 0, availability_version: 1, version: 1,
        created_datetime: '2026-11-09 18:00:00.000',
      });
      return { ...rows.get(p.property_id) };
    },
    async updateWithVersion(id, version, changes) {
      const r = rows.get(id);
      if (!r || r.version !== version || r.status === 'deleted') return { updated: false, row: r ? { ...r } : null };
      for (const [k, v] of Object.entries(changes)) {
        if (k === 'address') Object.assign(r, { address_line1: v.line1 ?? r.address_line1, city: v.city ?? r.city });
        else r[k] = k === 'nightly_price' ? Number(v).toFixed(2) : v;
      }
      r.version += 1;
      return { updated: true, row: { ...r } };
    },
    async countUpcomingBookings() { return upcoming; },
    async softDelete(id) { const r = rows.get(id); r.status = 'deleted'; r.version += 1; },
  };
  return repo;
}

function fakeBus({ fail = false } = {}) {
  const sent = [];
  return { sent, publish: async (topic, env, key) => { if (fail) throw new Error('broker down'); sent.push({ topic, env, key }); } };
}

function fakeCache() {
  const invalidated = [];
  return { invalidated, invalidateProperty: async (id) => { invalidated.push(id); return true; } };
}

async function start(deps) {
  const app = createApp({ name: 'property-test', logger });
  app.use(buildRouter(deps));
  app.finalize();
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const HOST = { 'X-User-Id': 'hst_0001', 'X-User-Role': 'host' };
const OTHER_HOST = { 'X-User-Id': 'hst_0002', 'X-User-Role': 'host' };
const GUEST = { 'X-User-Id': 'gst_0001', 'X-User-Role': 'guest' };

const call = async (base, path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const listing = (over = {}) => ({
  title: 'Downtown loft with parking',
  description: 'Bright loft two blocks from SAP Center.',
  property_type: 'apartment',
  address: { line1: '100 S Market St', city: 'San Jose', state: 'CA', zip: '95113', lat: 37.333, lng: -121.89 },
  capacity: 3, bedrooms: 1, bathrooms: 1,
  amenities: ['wifi', 'kitchen', 'parking', 'ac'],
  nightly_price: 189, cleaning_fee: 40, pet_friendly: false,
  ...over,
});

async function withServer(fn, opts = {}) {
  const repo = fakeRepo(opts.repo);
  const bus = fakeBus(opts.bus);
  const cache = fakeCache();
  const { server, base } = await start({ bus, repo, cache });
  try {
    await fn({ base, repo, bus, cache });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------- create
test('create: host creates a listing -> 201, property.created, cache invalidated', () => withServer(async ({ base, bus, cache }) => {
  const r = await call(base, '/properties/create', listing(), HOST);
  assert.strictEqual(r.status, 201);
  const p = r.body.data;
  assert.match(p.property_id, /^prp_/);
  assert.strictEqual(p.host_id, 'hst_0001');
  assert.strictEqual(p.status, 'active');
  assert.strictEqual(p.version, 1);
  assert.strictEqual(p.nightly_price, 189);
  assert.deepStrictEqual(p.address.city, 'San Jose');
  assert.strictEqual(bus.sent.length, 1);
  assert.strictEqual(bus.sent[0].topic, 'property.created');
  assert.strictEqual(bus.sent[0].key, p.property_id);
  assert.deepStrictEqual(cache.invalidated, [p.property_id]);
}));

test('create: host_id comes from the token, not the body', () => withServer(async ({ base }) => {
  const r = await call(base, '/properties/create', { ...listing(), host_id: 'hst_9999' }, HOST);
  assert.strictEqual(r.status, 400); // unknown field rejected
}));

test('create: guest token -> 403', () => withServer(async ({ base }) => {
  const r = await call(base, '/properties/create', listing(), GUEST);
  assert.strictEqual(r.status, 403);
}));

test('create: validation errors name the field', () => withServer(async ({ base }) => {
  const cases = [
    [{ nightly_price: 5 }, 'nightly_price'],
    [{ capacity: 20 }, 'capacity'],
    [{ bathrooms: 1.3 }, 'bathrooms'],
    [{ amenities: ['wifi', 'jacuzzi'] }, 'amenities.1'],
    [{ property_type: 'castle' }, 'property_type'],
    [{ address: { line1: 'x', city: 'San Jose', state: 'CA', zip: 'abc' } }, 'address.zip'],
  ];
  for (const [over, field] of cases) {
    const r = await call(base, '/properties/create', listing(over), HOST);
    assert.strictEqual(r.status, 400, field);
    assert.ok(r.body.error.details.some((d) => d.field === field), `expected error on ${field}: ${JSON.stringify(r.body.error.details)}`);
  }
}));

test('create: Kafka down still returns 201 (row is already saved)', () => withServer(async ({ base }) => {
  const r = await call(base, '/properties/create', listing(), HOST);
  assert.strictEqual(r.status, 201);
}, { bus: { fail: true } }));

// ---------------------------------------------------------------- get
test('get: public read returns the listing and publishes property.viewed', () => withServer(async ({ base, bus }) => {
  const id = (await call(base, '/properties/create', listing(), HOST)).body.data.property_id;
  const r = await call(base, '/properties/get', { property_id: id });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.title, 'Downtown loft with parking');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const viewed = bus.sent.find((s) => s.topic === 'property.viewed');
  assert.ok(viewed);
  assert.strictEqual(viewed.env.payload.viewer_id, null);
  assert.strictEqual(viewed.env.payload.source, 'direct');
}));

test('get: unknown id -> 404, deleted -> 410', () => withServer(async ({ base }) => {
  assert.strictEqual((await call(base, '/properties/get', { property_id: 'prp_nope' })).status, 404);
  const id = (await call(base, '/properties/create', listing(), HOST)).body.data.property_id;
  await call(base, '/properties/delete', { property_id: id }, HOST);
  const r = await call(base, '/properties/get', { property_id: id });
  assert.strictEqual(r.status, 410);
  assert.strictEqual(r.body.error.code, 'PROPERTY_UNAVAILABLE');
}));

// ---------------------------------------------------------------- update
test('update: owner changes price -> version bumps, event lists changed fields, cache invalidated', () => withServer(async ({ base, bus, cache }) => {
  const id = (await call(base, '/properties/create', listing(), HOST)).body.data.property_id;
  const r = await call(base, '/properties/update', { property_id: id, version: 1, nightly_price: 199 }, HOST);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.nightly_price, 199);
  assert.strictEqual(r.body.data.version, 2);
  const ev = bus.sent.find((s) => s.topic === 'property.updated');
  assert.deepStrictEqual(ev.env.payload.changed_fields, ['nightly_price']);
  assert.strictEqual(cache.invalidated.filter((x) => x === id).length, 2); // create + update
}));

test('update: stale version -> 409 VERSION_CONFLICT with the current version', () => withServer(async ({ base }) => {
  const id = (await call(base, '/properties/create', listing(), HOST)).body.data.property_id;
  await call(base, '/properties/update', { property_id: id, version: 1, nightly_price: 199 }, HOST);
  const r = await call(base, '/properties/update', { property_id: id, version: 1, nightly_price: 209 }, HOST);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'VERSION_CONFLICT');
  assert.strictEqual(r.body.error.retryable, true);
  assert.match(r.body.error.details[0].issue, /current version is 2/);
}));

test("update: another host's listing -> 403", () => withServer(async ({ base }) => {
  const id = (await call(base, '/properties/create', listing(), HOST)).body.data.property_id;
  const r = await call(base, '/properties/update', { property_id: id, version: 1, nightly_price: 99 }, OTHER_HOST);
  assert.strictEqual(r.status, 403);
}));

test('update: no fields to change -> 400; cannot set status to deleted -> 400', () => withServer(async ({ base }) => {
  const id = (await call(base, '/properties/create', listing(), HOST)).body.data.property_id;
  assert.strictEqual((await call(base, '/properties/update', { property_id: id, version: 1 }, HOST)).status, 400);
  assert.strictEqual((await call(base, '/properties/update', { property_id: id, version: 1, status: 'deleted' }, HOST)).status, 400);
}));

// ---------------------------------------------------------------- delete
test('delete: soft delete, then deleting again is a no-op', () => withServer(async ({ base, bus }) => {
  const id = (await call(base, '/properties/create', listing(), HOST)).body.data.property_id;
  const a = await call(base, '/properties/delete', { property_id: id }, HOST);
  assert.strictEqual(a.status, 200);
  assert.deepStrictEqual(a.body.data, { property_id: id, status: 'deleted' });
  const b = await call(base, '/properties/delete', { property_id: id }, HOST);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(bus.sent.filter((s) => s.topic === 'property.updated').length, 1);
}));

test('delete: listing with upcoming bookings -> 409', () => withServer(async ({ base }) => {
  const id = (await call(base, '/properties/create', listing(), HOST)).body.data.property_id;
  const r = await call(base, '/properties/delete', { property_id: id }, HOST);
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.error.code, 'INVALID_STATE_TRANSITION');
  assert.match(r.body.error.message, /2 upcoming bookings/);
}, { repo: { upcoming: 2 } }));
