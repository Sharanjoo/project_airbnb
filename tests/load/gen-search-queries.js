// Writes the property-search workload for search.jmx: one JSON body per line in
// tests/load/results/search-queries.tsv. It is the same 50 query shapes as
// scripts/bench-search.js (Slice 2's 13.8 benchmark), so JMeter results compare
// directly with that work. Dates are relative to today, so regenerate before each run.
//   node tests/load/gen-search-queries.js
const fs = require('fs');
const path = require('path');

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const CITIES = ['San Jose', 'San Francisco', 'Oakland', 'Palo Alto', 'Santa Cruz', 'Monterey', 'South Lake Tahoe', 'Napa', 'Sacramento', 'Fresno'];
const AMENITY_SETS = [['wifi'], ['parking'], ['kitchen', 'parking'], ['wifi', 'workspace'], ['pool'], ['pet_friendly']];
const SORTS = ['price_asc', 'rating_desc', 'price_desc', 'newest'];

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
  shapes.push(JSON.stringify(q));
}

const out = path.join(__dirname, 'results', 'search-queries.tsv');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${shapes.join('\n')}\n`);
console.log(`wrote ${shapes.length} queries to ${path.relative(process.cwd(), out)}`);
