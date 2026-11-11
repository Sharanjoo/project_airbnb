// Search strategy benchmark for features 13.8 and 13.9 and the §9 "Property search" experiment.
//
//   node scripts/bench-search.js --strategy mysql --cache off --concurrency 10 --requests 500
//   node scripts/bench-search.js --strategy mongo --cache off --concurrency 10 --requests 500
//   node scripts/bench-search.js --strategy mysql --cache on  --concurrency 10 --requests 500
//
// Every run sends the same fixed workload (same 50 query shapes, same order), so
// strategies are compared on identical requests. Calls the property service
// directly (default http://localhost:8002) because the gateway rate-limits at
// 100 requests/minute. Prints throughput, latency percentiles and error rate,
// and appends one line per run to tests/load/results/search-bench.csv.
// For memory/CPU, run `docker stats` alongside and note the peak for mysql / mongo / redis.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const BASE = arg('base', 'http://localhost:8002');
const STRATEGY = arg('strategy', 'mysql');
const CACHE = arg('cache', 'off'); // on | off
const CONCURRENCY = Number(arg('concurrency', 10));
const REQUESTS = Number(arg('requests', 500));
const LABEL = arg('label', '');

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const CITIES = ['San Jose', 'San Francisco', 'Oakland', 'Palo Alto', 'Santa Cruz', 'Monterey', 'South Lake Tahoe', 'Napa', 'Sacramento', 'Fresno'];
const AMENITY_SETS = [['wifi'], ['parking'], ['kitchen', 'parking'], ['wifi', 'workspace'], ['pool'], ['pet_friendly']];
const SORTS = ['price_asc', 'rating_desc', 'price_desc', 'newest'];

/** 50 fixed query shapes covering the patterns 13.8 asks us to compare. */
function workload() {
  const shapes = [];
  for (let i = 0; i < 50; i++) {
    const city = CITIES[i % CITIES.length];
    const kind = i % 5;
    const q = { location: { city }, sort: SORTS[i % SORTS.length], page: 1, page_size: 20 };
    if (kind === 1) Object.assign(q, { check_in: day(40 + (i % 20)), check_out: day(42 + (i % 20)), guests: 2 });
    if (kind === 2) Object.assign(q, { price_max: 150 + (i % 4) * 50, amenities: AMENITY_SETS[i % AMENITY_SETS.length] });
    if (kind === 3) Object.assign(q, { guests: 1 + (i % 6), min_rating: 4 + (i % 3) * 0.3 });
    if (kind === 4) {
      Object.assign(q, {
        check_in: day(55 + (i % 10)), check_out: day(58 + (i % 10)), guests: 2,
        price_max: 250, amenities: ['parking', 'kitchen'], min_rating: 4.5,
      });
    }
    shapes.push(q);
  }
  return shapes;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function main() {
  const shapes = workload();
  const latencies = [];
  let errors = 0;
  let hits = 0;
  let next = 0;
  const headers = { 'Content-Type': 'application/json', 'X-Search-Strategy': STRATEGY };
  if (CACHE !== 'on') headers['X-Cache-Mode'] = 'bypass';

  async function worker() {
    while (next < REQUESTS) {
      const body = shapes[next++ % shapes.length];
      const t0 = process.hrtime.bigint();
      try {
        const res = await fetch(`${BASE}/properties/search`, { method: 'POST', headers, body: JSON.stringify(body) });
        await res.arrayBuffer();
        if (!res.ok) errors++;
        if (res.headers.get('x-cache') === 'HIT') hits++;
      } catch {
        errors++;
      }
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  }

  const start = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (Date.now() - start) / 1000;
  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((s, x) => s + x, 0) / latencies.length;
  const row = {
    timestamp: new Date().toISOString(), label: LABEL, strategy: STRATEGY, cache: CACHE, concurrency: CONCURRENCY,
    requests: REQUESTS, seconds: seconds.toFixed(2), throughput_rps: (REQUESTS / seconds).toFixed(1),
    avg_ms: avg.toFixed(1), p50_ms: pct(latencies, 50).toFixed(1), p95_ms: pct(latencies, 95).toFixed(1),
    p99_ms: pct(latencies, 99).toFixed(1), error_rate: (errors / REQUESTS).toFixed(4),
    cache_hit_rate: (hits / REQUESTS).toFixed(3),
  };
  console.table(row);

  const dir = path.join(__dirname, '..', 'tests', 'load', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'search-bench.csv');
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${Object.keys(row).join(',')}\n`);
  fs.appendFileSync(file, `${Object.values(row).join(',')}\n`);
  console.log(`Appended to ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
