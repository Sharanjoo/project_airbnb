// Live demo of feature 13.9 (Redis cache invalidation). Run it during the demo:
//   node scripts/demo-cache.js
//
// 1. search -> MISS        2. same search -> HIT (and faster)
// 3. host changes the price of a listing in the results (measures the update + invalidation)
// 4. same search -> MISS with the NEW price: stale data is not returned
// 5. with Redis stopped (`docker compose stop redis`), run it again: every search says BYPASS and still works
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const BASE = process.env.PROPERTY_URL || 'http://localhost:8002';
const SECRET = process.env.JWT_SECRET || 'change-me-dev-secret';
const CITY = process.argv[2] || 'San Jose';

const post = async (pathName, body, headers = {}) => {
  const t0 = process.hrtime.bigint();
  const res = await fetch(BASE + pathName, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
};

async function main() {
  const query = { location: { city: CITY }, sort: 'price_asc', page: 1, page_size: 5 };
  const show = (label, r) => {
    const d = r.json.data;
    const first = d.items[0];
    console.log(`${label.padEnd(34)} cache=${d.cache.padEnd(6)} ${r.ms.toFixed(1).padStart(7)} ms   `
      + `first: ${first ? `${first.property_id} $${first.nightly_price}` : '(none)'}`);
    return d;
  };

  const a = show('1. search', await post('/properties/search', query));
  show('2. same search again', await post('/properties/search', query));
  if (!a.items.length) {
    console.log(`No listings in ${CITY}. Run: npm run gen:properties`);
    return;
  }

  const target = a.items[0];
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3307),
    user: 'airbnb', password: 'airbnb', database: 'airbnb',
  });
  const [[row]] = await db.query('SELECT host_id, version FROM properties WHERE property_id = ?', [target.property_id]);
  await db.end();

  const token = jwt.sign({ sub: row.host_id, role: 'host' }, SECRET);
  const newPrice = Math.max(10, Math.round(target.nightly_price) - 7);
  const u = await post('/properties/update', { property_id: target.property_id, version: row.version, nightly_price: newPrice },
    { 'X-User-Id': row.host_id, 'X-User-Role': 'host', Authorization: `Bearer ${token}` });
  console.log(`3. host sets ${target.property_id} to $${newPrice}`.padEnd(34)
    + `  HTTP ${u.status}  ${u.ms.toFixed(1).padStart(7)} ms   (update + cache invalidation)`);

  const c = show('4. same search after the update', await post('/properties/search', query));
  const after = c.items.find((i) => i.property_id === target.property_id);
  console.log(after && after.nightly_price === newPrice
    ? `   OK: new price $${newPrice} served, stale $${target.nightly_price} not returned.`
    : '   UNEXPECTED: price did not change. Check the property worker and Redis.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
