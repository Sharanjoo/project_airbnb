// Integration test against the real MySQL and Redis from docker compose.
//   npm run infra:up   then   npm run test:db -w services/property-service
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { getMysql, getRedis, newId } = require('@airbnb/common');
const repo = require('../../src/models/property');
const cache = require('../../src/cache');

const created = [];
const listing = () => {
  const id = newId('prp');
  created.push(id);
  return {
    property_id: id, host_id: 'hst_0001', title: 'Integration test loft', description: 'Created by properties.int.js',
    property_type: 'apartment',
    address: { line1: '1 Test St', city: 'San Jose', state: 'CA', zip: '95113', lat: 37.33, lng: -121.89 },
    capacity: 2, bedrooms: 1, bathrooms: 1.5, amenities: ['wifi', 'parking'],
    nightly_price: 120.5, cleaning_fee: 25, pet_friendly: true,
  };
};

test('insert + read back: types come out as the API expects', async () => {
  const row = await repo.insert(listing());
  const p = repo.toApi(row);
  assert.strictEqual(p.status, 'active');
  assert.strictEqual(p.version, 1);
  assert.strictEqual(p.nightly_price, 120.5);   // DECIMAL -> number
  assert.strictEqual(p.bathrooms, 1.5);
  assert.strictEqual(p.pet_friendly, true);     // TINYINT -> boolean
  assert.deepStrictEqual(p.amenities, ['wifi', 'parking']); // JSON column -> array
  assert.strictEqual(p.address.lat, 37.33);
  assert.match(p.created_datetime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
});

test('update with the right version wins; the stale version loses', async () => {
  const { property_id: id } = await repo.insert(listing());
  const a = await repo.updateWithVersion(id, 1, { nightly_price: 130, address: { city: 'Santa Clara' }, amenities: ['wifi'] });
  assert.strictEqual(a.updated, true);
  assert.strictEqual(a.row.version, 2);
  assert.strictEqual(Number(a.row.nightly_price), 130);
  assert.strictEqual(a.row.city, 'Santa Clara');
  const b = await repo.updateWithVersion(id, 1, { nightly_price: 140 });
  assert.strictEqual(b.updated, false);
  assert.strictEqual(b.row.version, 2);
  assert.strictEqual(Number(b.row.nightly_price), 130); // loser changed nothing
});

test('two hosts saving at the same moment: exactly one update applies', async () => {
  const { property_id: id } = await repo.insert(listing());
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => repo.updateWithVersion(id, 1, { nightly_price: 100 + i })),
  );
  assert.strictEqual(results.filter((r) => r.updated).length, 1);
  const final = await repo.findById(id);
  assert.strictEqual(final.version, 2);
});

test('soft delete hides the listing but keeps the row; updates are then refused', async () => {
  const { property_id: id } = await repo.insert(listing());
  await repo.softDelete(id);
  assert.strictEqual(await repo.findById(id), null);
  assert.strictEqual((await repo.findByIdAnyStatus(id)).status, 'deleted');
  const u = await repo.updateWithVersion(id, 2, { nightly_price: 150 });
  assert.strictEqual(u.updated, false);
});

test('countUpcomingBookings counts only REQUESTED/CONFIRMED stays that have not ended', async () => {
  const { property_id: id } = await repo.insert(listing());
  const db = getMysql();
  const add = (status, checkIn, checkOut) => db.execute(
    `INSERT INTO reservations (reservation_id, property_id, guest_id, host_id, check_in, check_out, guest_count,
       price_breakdown, total_price, status, trace_id)
     VALUES (?, ?, 'gst_0001', 'hst_0001', ?, ?, 1, '{}', 0, ?, '00000000-0000-0000-0000-000000000000')`,
    [newId('res'), id, checkIn, checkOut, status],
  );
  await add('CONFIRMED', '2031-01-10', '2031-01-12');
  await add('REQUESTED', '2031-02-10', '2031-02-12');
  await add('CANCELLED', '2031-03-10', '2031-03-12');
  await add('COMPLETED', '2020-01-10', '2020-01-12');
  assert.strictEqual(await repo.countUpcomingBookings(id), 2);
});

test('cache invalidation bumps search:version and clears avail:<id>', async () => {
  const r = getRedis();
  if (r.status === 'wait') await r.connect();
  await r.set('avail:prp_cache_test', '{"cached":true}');
  const before = Number((await r.get('search:version')) || 0);
  assert.strictEqual(await cache.invalidateProperty('prp_cache_test'), true);
  assert.strictEqual(Number(await r.get('search:version')), before + 1);
  assert.strictEqual(await r.get('avail:prp_cache_test'), null);
});

test.after(async () => {
  const db = getMysql();
  for (const id of created) {
    await db.execute('DELETE FROM reservations WHERE property_id = ?', [id]);
    await db.execute('DELETE FROM properties WHERE property_id = ?', [id]);
  }
  await db.end();
  getRedis().disconnect();
});
