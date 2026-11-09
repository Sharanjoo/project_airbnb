// Generates a fixed, reproducible property pool.
//
//   node scripts/generate-properties.js                  200 properties (the AI benchmark pool "active-pool-v1")
//   node scripts/generate-properties.js --count 10000    larger dataset for the search experiments (13.8, §9)
//   node scripts/generate-properties.js --mongo          also rebuild the MongoDB read model for the "mongo" strategy
//
// Same --count and --seed always produce the same rows, so every teammate and
// every experiment run uses an identical dataset. Re-running is safe (upsert).
// Writes data/property-pool-<count>.json with the ids and key fields.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const COUNT = Number(arg('count', 200));
const SEED = Number(arg('seed', 42));
const WITH_MONGO = args.includes('--mongo');
const HOSTS = Math.max(10, Math.round(COUNT / 10));

// Deterministic PRNG (mulberry32), so the dataset never depends on Math.random.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + rand() * (hi - lo);
const intBetween = (lo, hi) => Math.floor(between(lo, hi + 1));

// City, centre, zip prefix, price multiplier (travel purposes: city, beach, mountain, campus, wine country).
const CITIES = [
  ['San Jose', 'CA', 37.3382, -121.8863, '951', 1.0],
  ['San Francisco', 'CA', 37.7749, -122.4194, '941', 1.6],
  ['Oakland', 'CA', 37.8044, -122.2712, '946', 1.1],
  ['Palo Alto', 'CA', 37.4419, -122.143, '943', 1.5],
  ['Santa Cruz', 'CA', 36.9741, -122.0308, '950', 1.3],
  ['Monterey', 'CA', 36.6002, -121.8947, '939', 1.4],
  ['South Lake Tahoe', 'CA', 38.9399, -119.9772, '961', 1.2],
  ['Napa', 'CA', 38.2975, -122.2869, '945', 1.5],
  ['Sacramento', 'CA', 38.5816, -121.4944, '958', 0.85],
  ['Fresno', 'CA', 36.7378, -119.7871, '937', 0.7],
];
const TYPES = [
  ['apartment', 0.30, 1, 4, 1.0], ['entire_home', 0.25, 2, 10, 1.6], ['private_room', 0.20, 1, 2, 0.5],
  ['condo', 0.12, 1, 6, 1.2], ['cabin', 0.08, 2, 8, 1.3], ['shared_room', 0.05, 1, 1, 0.3],
];
const AMENITY_ODDS = {
  wifi: 0.95, kitchen: 0.7, parking: 0.55, washer: 0.45, ac: 0.5, heating: 0.8,
  pool: 0.12, pet_friendly: 0.25, workspace: 0.4, self_checkin: 0.5,
};
const ADJ = ['Sunny', 'Quiet', 'Modern', 'Cozy', 'Bright', 'Spacious', 'Charming', 'Restored', 'Minimal', 'Garden'];
const FEATURE = ['near downtown', 'with parking', 'by the park', 'with a view', 'near transit', 'with patio', 'near campus', 'by the water'];
const STREETS = ['Main St', 'Oak Ave', 'Park Blvd', 'Market St', 'Lincoln Ave', 'Elm St', 'Bay St', 'Lake Rd'];

function weightedType() {
  let x = rand();
  for (const t of TYPES) {
    if ((x -= t[1]) <= 0) return t;
  }
  return TYPES[0];
}

const pad = (n, w) => String(n).padStart(w, '0');
// Same bcrypt hash as the seed users: password "password123".
const PASSWORD_HASH = '$2a$10$Xxq3oADEySHsjwD9bUKb.OYUm.CA9KWTPeltUnSEuZp7WtZjbuTxK';

function makeHosts() {
  return Array.from({ length: HOSTS }, (_, i) => ({
    host_id: `hst_gen_${pad(i + 1, 4)}`,
    name: `Generated Host ${i + 1}`,
    email: `host${i + 1}@gen.example.com`,
    response_rate: Math.round(between(0.55, 1) * 1000) / 1000,
    response_time: intBetween(10, 600),
    verification_status: rand() < 0.85 ? 'verified' : 'pending',
  }));
}

function makeProperty(i, hosts) {
  const [city, state, lat, lng, zip, cityMult] = pick(CITIES);
  const [type, , capMin, capMax, typeMult] = weightedType();
  const capacity = intBetween(capMin, capMax);
  const bedrooms = type === 'shared_room' || type === 'private_room' ? 1 : Math.max(1, Math.ceil(capacity / 2));
  const amenities = Object.entries(AMENITY_ODDS).filter(([, p]) => rand() < p).map(([a]) => a);
  const base = between(70, 180) * cityMult * typeMult * (1 + capacity * 0.04) * (amenities.includes('pool') ? 1.2 : 1);
  const price = Math.min(5000, Math.max(25, Math.round(base)));
  const newListing = rand() < 0.12;
  const rating = newListing ? null : Math.round(Math.min(5, between(3.4, 5.15)) * 100) / 100;
  return {
    property_id: `prp_gen_${pad(i + 1, 5)}`,
    host_id: hosts[i % hosts.length].host_id,
    title: `${pick(ADJ)} ${type.replace('_', ' ')} ${pick(FEATURE)}`.slice(0, 100),
    description: `${capacity}-guest ${type.replace('_', ' ')} in ${city}. Generated listing for testing and benchmarks.`,
    property_type: type,
    address_line1: `${intBetween(10, 9999)} ${pick(STREETS)}`,
    city,
    state,
    zip: `${zip}${pad(intBetween(1, 99), 2)}`,
    lat: Math.round((lat + between(-0.08, 0.08)) * 1e6) / 1e6,
    lng: Math.round((lng + between(-0.08, 0.08)) * 1e6) / 1e6,
    capacity,
    bedrooms,
    bathrooms: Math.max(1, Math.round(bedrooms * between(0.6, 1.2) * 2) / 2),
    amenities,
    pet_friendly: amenities.includes('pet_friendly'),
    nightly_price: price,
    cleaning_fee: Math.round(price * between(0.1, 0.3)),
    rating,
    review_count: newListing ? 0 : intBetween(1, 250),
  };
}

async function main() {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost',
    port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER || 'airbnb',
    password: process.env.MYSQL_PASSWORD || 'airbnb',
    database: process.env.MYSQL_DATABASE || 'airbnb',
  });

  const hosts = makeHosts();
  const props = Array.from({ length: COUNT }, (_, i) => makeProperty(i, hosts));

  await db.query(
    `INSERT INTO hosts (host_id, name, email, password_hash, verification_status, response_rate, response_time)
     VALUES ? ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [hosts.map((h) => [h.host_id, h.name, h.email, PASSWORD_HASH, h.verification_status, h.response_rate, h.response_time])],
  );

  const cols = `property_id, host_id, title, description, property_type, address_line1, city, state, zip, lat, lng,
    capacity, bedrooms, bathrooms, amenities, pet_friendly, nightly_price, cleaning_fee, rating, review_count, status`;
  for (let i = 0; i < props.length; i += 1000) {
    const chunk = props.slice(i, i + 1000).map((p) => [
      p.property_id, p.host_id, p.title, p.description, p.property_type, p.address_line1, p.city, p.state, p.zip,
      p.lat, p.lng, p.capacity, p.bedrooms, p.bathrooms, JSON.stringify(p.amenities), p.pet_friendly,
      p.nightly_price, p.cleaning_fee, p.rating, p.review_count, 'active',
    ]);
    await db.query(
      `INSERT INTO properties (${cols}) VALUES ?
       ON DUPLICATE KEY UPDATE title = VALUES(title), nightly_price = VALUES(nightly_price), amenities = VALUES(amenities),
         rating = VALUES(rating), review_count = VALUES(review_count), status = 'active'`,
      [chunk],
    );
  }

  // A few host blocks so the date filter has something to exclude (about 10% of listings).
  const blockRows = props.filter(() => rand() < 0.1).map((p, k) => {
    const start = new Date(Date.UTC(2026, 11, 1) + intBetween(0, 60) * 86400000);
    const end = new Date(start.getTime() + intBetween(2, 7) * 86400000);
    return [`avl_gen_${pad(k + 1, 5)}`, p.property_id, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), 'blocked', 'host'];
  });
  if (blockRows.length) {
    await db.query(
      `INSERT INTO availability_blocks (availability_id, property_id, start_date, end_date, status, source)
       VALUES ? ON DUPLICATE KEY UPDATE start_date = VALUES(start_date), end_date = VALUES(end_date)`,
      [blockRows],
    );
  }
  await db.end();

  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `property-pool-${COUNT}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify({
    pool_ref: COUNT === 200 ? 'active-pool-v1' : `generated-${COUNT}`,
    seed: SEED,
    count: COUNT,
    generated_by: 'scripts/generate-properties.js',
    properties: props.map((p) => ({
      property_id: p.property_id, title: p.title, city: p.city, property_type: p.property_type, capacity: p.capacity,
      nightly_price: p.nightly_price, amenities: p.amenities, rating: p.rating, review_count: p.review_count,
    })),
  }, null, 2)}\n`);

  const byCity = props.reduce((m, p) => ({ ...m, [p.city]: (m[p.city] || 0) + 1 }), {});
  console.log(`Upserted ${hosts.length} hosts, ${props.length} properties, ${blockRows.length} blocks (seed ${SEED}).`);
  console.log('By city:', byCity);
  console.log(`Pool file: ${path.relative(process.cwd(), outFile)}`);

  if (WITH_MONGO) {
    const readModel = require('../services/property-service/src/readModel');
    const n = await readModel.syncAll();
    console.log(`MongoDB read model rebuilt: ${n} documents in property_search.`);
    await (await require('@airbnb/common').getMongo()).client?.close?.();
    await require('@airbnb/common').getMysql().end();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
