process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { createApp, logger } = require('@airbnb/common');
const { buildRouter } = require('../src/routes');
const { toApi } = require('../src/models/property');
const { AvailabilityConflict } = require('../src/models/availability');
const { toSql, toMongo, boundingBox } = require('../src/search/filters');
const { searchKey, canonical } = require('../src/cache');

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const HOST = { 'X-User-Id': 'hst_0001', 'X-User-Role': 'host' };
const OTHER_HOST = { 'X-User-Id': 'hst_0002', 'X-User-Role': 'host' };
const GUEST = { 'X-User-Id': 'gst_0001', 'X-User-Role': 'guest' };

// ---------------------------------------------------------------- fakes
const PROPERTY = {
  property_id: 'prp_1', host_id: 'hst_0001', title: 'Loft', status: 'active', nightly_price: '189.00', version: 1,
};

function deps(over = {}) {
  const calls = { search: [], saved: [], published: [], invalidated: [], blocks: [] };
  const d = {
    calls,
    bus: { publish: async (topic, env, key) => calls.published.push({ topic, env, key }) },
    repo: {
      toApi,
      findByIdAnyStatus: async (id) => (id === 'prp_1' ? { ...PROPERTY } : id === 'prp_gone' ? { ...PROPERTY, property_id: id, status: 'deleted' } : null),
    },
    strategies: {
      mysql: async (f, opts) => { calls.search.push({ strategy: 'mysql', f, opts }); return { items: [{ property_id: 'prp_1' }], total: 1, page: f.page, page_size: f.page_size }; },
      mongo: async (f, opts) => { calls.search.push({ strategy: 'mongo', f, opts }); return { items: [], total: 0, page: f.page, page_size: f.page_size }; },
    },
    cache: {
      cachedSearch: async (strategy, body, compute, { bypass }) => ({ result: await compute(), cache: bypass ? 'BYPASS' : 'MISS' }),
      cachedCalendar: async (id, compute) => ({ result: await compute(), cache: 'MISS' }),
      invalidateProperty: async (id) => { calls.invalidated.push(id); return true; },
    },
    saved: { setSaved: async (guest, id, saved) => { calls.saved.push({ guest, id, saved }); return true; } },
    availability: {
      AvailabilityConflict,
      getCalendar: async (id, from, to) => ({ property_id: id, from, to, availability_version: 3, unavailable: [] }),
      blockDates: async (id, version, start, end) => {
        if (version !== 3) throw new AvailabilityConflict('version', 'Availability changed since you read it.', { currentVersion: 3 });
        if (start === day(60)) throw new AvailabilityConflict('booked', `${start} to ${end} is booked.`);
        calls.blocks.push({ id, start, end });
        return { availability_id: 'avl_1', property_id: id, start_date: start, end_date: end, status: 'blocked', source: 'host', availability_version: 4 };
      },
      unblock: async (id, availabilityId, version) => {
        if (availabilityId !== 'avl_1') throw new AvailabilityConflict('not_found', 'Block not found.');
        return { availability_id: availabilityId, property_id: id, start_date: day(30), end_date: day(32), status: 'open', source: 'host', availability_version: version + 1 };
      },
    },
    ...over,
  };
  return d;
}

async function withServer(fn, over) {
  const d = deps(over);
  const app = createApp({ name: 'property-test', logger });
  app.use(buildRouter(d));
  app.finalize();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, headers = {}) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  try {
    await fn({ call, calls: d.calls });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------- search
test('search: defaults applied, mysql strategy, response reports strategy/cache/took_ms', () => withServer(async ({ call, calls }) => {
  const r = await call('/properties/search', { location: { city: 'San Jose' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.strategy, 'mysql');
  assert.strictEqual(r.body.data.cache, 'MISS');
  assert.strictEqual(r.headers.get('x-cache'), 'MISS');
  assert.ok(typeof r.body.data.took_ms === 'number');
  assert.deepStrictEqual(calls.search[0].f, { location: { city: 'San Jose' }, sort: 'price_asc', page: 1, page_size: 20 });
}));

test('search: X-Search-Strategy picks the strategy; unknown strategy -> 400', () => withServer(async ({ call, calls }) => {
  assert.strictEqual((await call('/properties/search', {}, { 'X-Search-Strategy': 'mongo' })).body.data.strategy, 'mongo');
  assert.strictEqual(calls.search[0].strategy, 'mongo');
  assert.strictEqual((await call('/properties/search', {}, { 'X-Search-Strategy': 'elastic' })).status, 400);
}));

test('search: X-Cache-Mode bypass skips the cache', () => withServer(async ({ call }) => {
  const r = await call('/properties/search', {}, { 'X-Cache-Mode': 'bypass' });
  assert.strictEqual(r.body.data.cache, 'BYPASS');
}));

test('search: date and price rules', () => withServer(async ({ call }) => {
  assert.strictEqual((await call('/properties/search', { check_in: day(10) })).status, 400); // both dates needed
  assert.strictEqual((await call('/properties/search', { check_in: day(10), check_out: day(10) })).status, 400);
  assert.strictEqual((await call('/properties/search', { check_in: day(-3), check_out: day(-1) })).status, 400); // past
  assert.strictEqual((await call('/properties/search', { check_in: day(10), check_out: day(50) })).status, 400); // > 30 nights
  assert.strictEqual((await call('/properties/search', { price_min: 300, price_max: 100 })).status, 400);
  assert.strictEqual((await call('/properties/search', { amenities: ['wifi', 'wifi'] })).status, 400);
  assert.strictEqual((await call('/properties/search', { check_in: day(10), check_out: day(12), guests: 2 })).status, 200);
}));

test('search: a host listing their own properties gets the owner view, never cached', () => withServer(async ({ call, calls }) => {
  const own = await call('/properties/search', { host_id: 'hst_0001' }, HOST);
  assert.strictEqual(own.body.data.cache, 'BYPASS');
  assert.strictEqual(calls.search[0].opts.ownerView, true);
  await call('/properties/search', { host_id: 'hst_0001' }, OTHER_HOST);
  assert.strictEqual(calls.search[1].opts.ownerView, false); // someone else only sees active listings
}));

test('search: a strategy failure becomes 503 DEPENDENCY_UNAVAILABLE', () => withServer(async ({ call }) => {
  const r = await call('/properties/search', {}, { 'X-Search-Strategy': 'mongo' });
  assert.strictEqual(r.status, 503);
  assert.match(r.body.error.message, /MongoDB/);
}, { strategies: { mongo: async () => { throw new Error('no mongo'); }, mysql: async () => ({}) } }));

// ---------------------------------------------------------------- save
test('save: guest saves -> property.saved published; host token -> 403; deleted -> 410', () => withServer(async ({ call, calls }) => {
  const r = await call('/properties/save', { property_id: 'prp_1', saved: true }, GUEST);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.data, { property_id: 'prp_1', saved: true, changed: true });
  assert.strictEqual(calls.published[0].topic, 'property.saved');
  assert.deepStrictEqual(calls.published[0].env.payload, { property_id: 'prp_1', guest_id: 'gst_0001', saved: true });
  assert.strictEqual((await call('/properties/save', { property_id: 'prp_1', saved: true }, HOST)).status, 403);
  assert.strictEqual((await call('/properties/save', { property_id: 'prp_gone', saved: true }, GUEST)).status, 410);
  assert.strictEqual((await call('/properties/save', { property_id: 'prp_x', saved: true }, GUEST)).status, 404);
}));

test('save: no change (already saved) -> nothing published', () => withServer(async ({ call, calls }) => {
  const r = await call('/properties/save', { property_id: 'prp_1', saved: true }, GUEST);
  assert.strictEqual(r.body.data.changed, false);
  assert.strictEqual(calls.published.length, 0);
}, { saved: { setSaved: async () => false } }));

// ---------------------------------------------------------------- availability
test('availability get: default 90-day window, any signed-in user', () => withServer(async ({ call }) => {
  const r = await call('/properties/availability', { property_id: 'prp_1' }, GUEST);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.availability_version, 3);
  assert.strictEqual(r.body.data.cache, 'MISS');
  assert.strictEqual(r.body.data.to, day(90));
}));

test('availability block: owner succeeds, cache invalidated, availability.changed published', () => withServer(async ({ call, calls }) => {
  const r = await call('/properties/availability',
    { property_id: 'prp_1', action: 'block', start_date: day(30), end_date: day(32), expected_version: 3 }, HOST);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.availability_version, 4);
  assert.deepStrictEqual(calls.invalidated, ['prp_1']);
  const ev = calls.published.find((p) => p.topic === 'availability.changed');
  assert.strictEqual(ev.env.payload.status, 'blocked');
  assert.strictEqual(ev.env.payload.availability_version, 4);
}));

test('availability block: stale version -> 409 VERSION_CONFLICT, booked dates -> 409 DATE_CONFLICT', () => withServer(async ({ call, calls }) => {
  const stale = await call('/properties/availability',
    { property_id: 'prp_1', action: 'block', start_date: day(30), end_date: day(32), expected_version: 2 }, HOST);
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.body.error.code, 'VERSION_CONFLICT');
  assert.match(stale.body.error.details[0].issue, /current version is 3/);
  const booked = await call('/properties/availability',
    { property_id: 'prp_1', action: 'block', start_date: day(60), end_date: day(62), expected_version: 3 }, HOST);
  assert.strictEqual(booked.status, 409);
  assert.strictEqual(booked.body.error.code, 'DATE_CONFLICT');
  assert.strictEqual(calls.invalidated.length, 0); // nothing changed, nothing invalidated
}));

test('availability block: validation and permissions', () => withServer(async ({ call }) => {
  const body = { property_id: 'prp_1', action: 'block', start_date: day(30), end_date: day(32), expected_version: 3 };
  assert.strictEqual((await call('/properties/availability', { ...body, expected_version: undefined }, HOST)).status, 400);
  assert.strictEqual((await call('/properties/availability', { ...body, end_date: day(29) }, HOST)).status, 400);
  assert.strictEqual((await call('/properties/availability', { ...body, start_date: day(-2) }, HOST)).status, 400);
  assert.strictEqual((await call('/properties/availability', body, GUEST)).status, 403);
  assert.strictEqual((await call('/properties/availability', body, OTHER_HOST)).status, 403);
  assert.strictEqual((await call('/properties/availability', body)).status, 401);
}));

test('availability unblock: works, unknown block -> 404', () => withServer(async ({ call }) => {
  const ok = await call('/properties/availability', { property_id: 'prp_1', action: 'unblock', availability_id: 'avl_1', expected_version: 4 }, HOST);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.data.status, 'open');
  const missing = await call('/properties/availability', { property_id: 'prp_1', action: 'unblock', availability_id: 'avl_9', expected_version: 4 }, HOST);
  assert.strictEqual(missing.status, 404);
}));

// ---------------------------------------------------------------- query builders and cache keys
test('toSql: every filter becomes a parameterised condition', () => {
  const q = toSql({
    location: { city: 'San Jose' }, guests: 2, price_min: 50, price_max: 250, property_types: ['condo', 'cabin'],
    amenities: ['parking', 'kitchen'], pet_friendly: true, min_rating: 4.5, check_in: '2027-01-10', check_out: '2027-01-12',
    sort: 'rating_desc',
  });
  assert.match(q.where, /p.status = 'active'/);
  assert.match(q.where, /p.city = \?/);
  assert.match(q.where, /p.property_type IN \(\?, \?\)/);
  assert.match(q.where, /JSON_CONTAINS/);
  assert.match(q.where, /NOT EXISTS \(SELECT 1 FROM reservation_nights/);
  assert.match(q.where, /NOT EXISTS \(SELECT 1 FROM availability_blocks/);
  assert.deepStrictEqual(q.params, ['San Jose', 2, 50, 250, 'condo', 'cabin', '["parking","kitchen"]', 1, 4.5,
    '2027-01-10', '2027-01-12', '2027-01-12', '2027-01-10']);
  assert.match(q.orderBy, /p.rating DESC/);
  assert.ok(!/San Jose/.test(q.where), 'values never go into the SQL text');
});

test('toSql: owner view includes inactive listings, public view does not', () => {
  assert.match(toSql({ host_id: 'h' }, { ownerView: true }).where, /p.status <> 'deleted'/);
  assert.match(toSql({ host_id: 'h' }).where, /p.status = 'active'/);
});

test('toMongo: same filters as a Mongo query', () => {
  const { query, sort } = toMongo({ location: { city: 'Napa' }, guests: 4, price_max: 300, amenities: ['pool'], min_rating: 4, sort: 'price_desc' });
  assert.deepStrictEqual(query, {
    status: 'active', city: 'Napa', capacity: { $gte: 4 }, nightly_price: { $lte: 300 }, amenities: { $all: ['pool'] }, rating: { $gte: 4 },
  });
  assert.deepStrictEqual(sort, { nightly_price: -1, _id: 1 });
});

test('boundingBox: about 10 km each way near San Jose', () => {
  const b = boundingBox(37.33, -121.89, 10);
  assert.ok(Math.abs(b.maxLat - b.minLat - 0.18) < 0.01);
  assert.ok(b.maxLng - b.minLng > b.maxLat - b.minLat); // longitude degrees are shorter
});

test('cache key: same filters in any key order -> same key; version and strategy change it', () => {
  const a = { location: { city: 'San Jose' }, guests: 2, sort: 'price_asc' };
  const b = { sort: 'price_asc', guests: 2, location: { city: 'San Jose' } };
  assert.strictEqual(canonical(a), canonical(b));
  assert.strictEqual(searchKey(5, 'mysql', a), searchKey(5, 'mysql', b));
  assert.notStrictEqual(searchKey(5, 'mysql', a), searchKey(6, 'mysql', a));
  assert.notStrictEqual(searchKey(5, 'mysql', a), searchKey(5, 'mongo', a));
  assert.match(searchKey(5, 'mysql', a), /^search:5:mysql:[0-9a-f]{64}$/);
});
