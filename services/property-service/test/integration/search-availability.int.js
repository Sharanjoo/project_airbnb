// Integration tests against the real MySQL and Redis (13.3, 13.8 mysql strategy, 13.9).
//   npm run infra:up   then   npm run test:db -w services/property-service
// Uses its own city "Testville" so it never depends on (or disturbs) other data.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { getMysql, getRedis, newId } = require('@airbnb/common');
const repo = require('../../src/models/property');
const availability = require('../../src/models/availability');
const saved = require('../../src/models/saved');
const cache = require('../../src/cache');
const { mysqlSearch } = require('../../src/search/strategies');

const CITY = 'Testville';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const ids = {};

async function addListing(key, over) {
  const property_id = newId('prp');
  ids[key] = property_id;
  await repo.insert({
    property_id, host_id: 'hst_0001', title: `Testville ${key}`, description: 'search-availability.int.js',
    property_type: 'apartment', address: { line1: '1 Test St', city: CITY, state: 'CA', zip: '95000', lat: 37.3, lng: -121.9 },
    capacity: 2, bedrooms: 1, bathrooms: 1, amenities: ['wifi'], nightly_price: 100, cleaning_fee: 10, pet_friendly: false,
    ...over,
  });
  if (over.rating !== undefined) {
    await getMysql().query('UPDATE properties SET rating = ? WHERE property_id = ?', [over.rating, property_id]);
  }
  return property_id;
}

const search = (f) => mysqlSearch({ location: { city: CITY }, sort: 'price_asc', page: 1, page_size: 20, ...f }, {});
const found = (r) => r.items.map((i) => i.property_id);

test.before(async () => {
  await addListing('cheap', { nightly_price: 60, amenities: ['wifi', 'parking'], rating: 4.2 });
  await addListing('mid', { nightly_price: 150, capacity: 4, amenities: ['wifi', 'parking', 'kitchen'], pet_friendly: true, rating: 4.8 });
  await addListing('pricey', { nightly_price: 400, capacity: 6, property_type: 'entire_home', amenities: ['wifi', 'pool'], rating: 4.9 });
  await addListing('hidden', { nightly_price: 90 });
  await repo.updateWithVersion(ids.hidden, 1, { status: 'inactive' });
});

test('search filters: price, guests, amenities (all required), type, pet, rating, sort', async () => {
  assert.deepStrictEqual(found(await search({})), [ids.cheap, ids.mid, ids.pricey]); // inactive hidden
  assert.deepStrictEqual(found(await search({ price_max: 200 })), [ids.cheap, ids.mid]);
  assert.deepStrictEqual(found(await search({ guests: 4 })), [ids.mid, ids.pricey]);
  assert.deepStrictEqual(found(await search({ amenities: ['parking', 'kitchen'] })), [ids.mid]);
  assert.deepStrictEqual(found(await search({ property_types: ['entire_home'] })), [ids.pricey]);
  assert.deepStrictEqual(found(await search({ pet_friendly: true })), [ids.mid]);
  assert.deepStrictEqual(found(await search({ min_rating: 4.5 })), [ids.mid, ids.pricey]);
  assert.deepStrictEqual(found(await search({ sort: 'rating_desc' })), [ids.pricey, ids.mid, ids.cheap]);
  const page2 = await search({ page: 2, page_size: 2 });
  assert.deepStrictEqual(found(page2), [ids.pricey]);
  assert.strictEqual(page2.total, 3);
});

test('owner view shows the host their inactive listing too', async () => {
  const r = await mysqlSearch({ host_id: 'hst_0001', location: { city: CITY }, sort: 'price_asc', page: 1, page_size: 20 }, { ownerView: true });
  assert.ok(found(r).includes(ids.hidden));
});

test('dates: a host block removes the listing for overlapping stays only', async () => {
  const v = (await availability.getCalendar(ids.cheap, day(0), day(90))).availability_version;
  await availability.blockDates(ids.cheap, v, day(40), day(43));
  const overlap = await search({ check_in: day(42), check_out: day(45) });
  assert.ok(!found(overlap).includes(ids.cheap));
  assert.strictEqual(overlap.items[0].available, true);
  const after = await search({ check_in: day(43), check_out: day(45) }); // check-in on the block's (exclusive) end date
  assert.ok(found(after).includes(ids.cheap));
});

test('dates: a claimed reservation night removes the listing', async () => {
  const db = getMysql();
  const res = newId('res');
  await db.query(
    `INSERT INTO reservations (reservation_id, property_id, guest_id, host_id, check_in, check_out, guest_count,
       price_breakdown, total_price, status, trace_id)
     VALUES (?, ?, 'gst_0001', 'hst_0001', ?, ?, 1, '{}', 0, 'CONFIRMED', '00000000-0000-0000-0000-000000000000')`,
    [res, ids.mid, day(50), day(52)],
  );
  await db.query('INSERT INTO reservation_nights (property_id, night, reservation_id) VALUES (?, ?, ?), (?, ?, ?)',
    [ids.mid, day(50), res, ids.mid, day(51), res]);
  assert.ok(!found(await search({ check_in: day(51), check_out: day(53) })).includes(ids.mid));

  // ...and the host cannot block those nights either
  const v = (await availability.getCalendar(ids.mid, day(0), day(90))).availability_version;
  await assert.rejects(availability.blockDates(ids.mid, v, day(49), day(51)), (e) => e.kind === 'booked');
  const cal = await availability.getCalendar(ids.mid, day(0), day(90));
  assert.strictEqual(cal.availability_version, v, 'a refused block must not bump the version');
  assert.deepStrictEqual(cal.unavailable.map((u) => u.status), ['booked']);
});

test('13.3: concurrent blocks on the same version -> exactly one wins, the rest get VERSION_CONFLICT', async () => {
  const v = (await availability.getCalendar(ids.pricey, day(0), day(200))).availability_version;
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, i) => availability.blockDates(ids.pricey, v, day(100 + i * 5), day(102 + i * 5))),
  );
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.strictEqual(won.length, 1);
  assert.ok(lost.every((r) => r.reason.kind === 'version' && r.reason.currentVersion === v + 1));
  const cal = await availability.getCalendar(ids.pricey, day(0), day(200));
  assert.strictEqual(cal.unavailable.length, 1);
  assert.strictEqual(cal.availability_version, v + 1);
});

test('overlapping block is refused; unblock frees the dates', async () => {
  let v = (await availability.getCalendar(ids.pricey, day(0), day(200))).availability_version;
  const b = await availability.blockDates(ids.pricey, v, day(150), day(155));
  await assert.rejects(availability.blockDates(ids.pricey, v + 1, day(154), day(157)), (e) => e.kind === 'blocked');
  v = (await availability.getCalendar(ids.pricey, day(0), day(200))).availability_version;
  const u = await availability.unblock(ids.pricey, b.availability_id, v);
  assert.strictEqual(u.status, 'open');
  await assert.rejects(availability.unblock(ids.pricey, b.availability_id, v + 1), (e) => e.kind === 'not_found');
});

test('saved properties: save/unsave report whether anything changed', async () => {
  assert.strictEqual(await saved.setSaved('gst_0001', ids.cheap, true), true);
  assert.strictEqual(await saved.setSaved('gst_0001', ids.cheap, true), false);
  assert.strictEqual(await saved.isSaved('gst_0001', ids.cheap), true);
  assert.strictEqual(await saved.setSaved('gst_0001', ids.cheap, false), true);
  assert.strictEqual(await saved.setSaved('gst_0001', ids.cheap, false), false);
});

test('13.9: MISS, then HIT, then invalidation -> MISS with fresh data', async () => {
  const f = { location: { city: CITY }, sort: 'price_asc', page: 1, page_size: 20 };
  const compute = () => mysqlSearch(f, {});
  const a = await cache.cachedSearch('mysql', f, compute);
  const b = await cache.cachedSearch('mysql', f, compute);
  assert.strictEqual(a.cache, 'MISS');
  assert.strictEqual(b.cache, 'HIT');

  const row = await repo.findById(ids.cheap);
  await repo.updateWithVersion(ids.cheap, row.version, { nightly_price: 65 });
  await cache.invalidateProperty(ids.cheap);

  const c = await cache.cachedSearch('mysql', f, compute);
  assert.strictEqual(c.cache, 'MISS');
  assert.strictEqual(c.result.items.find((i) => i.property_id === ids.cheap).nightly_price, 65);
});

test('13.9: an invalidation during a slow query never leaves stale data in the cache', async () => {
  const f = { location: { city: CITY }, sort: 'price_desc', page: 1, page_size: 20 };
  const slow = async () => {
    const result = await mysqlSearch(f, {});
    await cache.invalidateProperty(ids.cheap); // a host edit lands while we were computing
    return result;
  };
  await cache.cachedSearch('mysql', f, slow);
  const next = await cache.cachedSearch('mysql', f, () => mysqlSearch(f, {}));
  assert.strictEqual(next.cache, 'MISS', 'the result computed before the edit must not be served');
});

test.after(async () => {
  const db = getMysql();
  for (const id of Object.values(ids)) {
    await db.query('DELETE FROM reservations WHERE property_id = ?', [id]);
    await db.query('DELETE FROM availability_blocks WHERE property_id = ?', [id]);
    await db.query('DELETE FROM saved_properties WHERE property_id = ?', [id]);
    await db.query('DELETE FROM properties WHERE property_id = ?', [id]);
  }
  await db.end();
  getRedis().disconnect();
});
