// Draws the performance report's charts (SVG) from the result files in tests/load/results/.
//   node tests/load/make-charts.js        -> docs/performance/*.svg
// Every bar prints its value, so no number depends on colour alone. Palette: blue,
// orange, aqua (validated for colour-blind separation; aqua is below 3:1 contrast,
// hence the printed values and the tables in docs/performance-report.md).
const fs = require('fs');
const path = require('path');

const RES = path.join(__dirname, 'results');
const OUT = path.join(__dirname, '..', '..', 'docs', 'performance');
const COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];
const INK = '#1f2328';
const MUTED = '#5d6670';
const GRID = '#e6e8eb';

function readCsv(name) {
  const [head, ...rows] = fs.readFileSync(path.join(RES, name), 'utf8').trim().split('\n').map((l) => l.split(','));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const fmt = (v) => (v >= 10000 ? `${Math.round(v / 100) / 10}k` : v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10));

function niceMax(max) {
  const p = 10 ** Math.floor(Math.log10(max || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

/**
 * Grouped columns. groups: x labels; series: [{ name, values[] }]; one y axis.
 */
function columns({ title, subtitle, groups, series, yLabel, unit = '' }) {
  const W = 760;
  const H = 400;
  const P = { top: 78, right: 20, bottom: 56, left: 64 };
  const plotW = W - P.left - P.right;
  const plotH = H - P.top - P.bottom;
  const top = niceMax(Math.max(...series.flatMap((s) => s.values.filter((v) => v !== null))));
  const y = (v) => P.top + plotH - (v / top) * plotH;
  const band = plotW / groups.length;
  const gap = 2;
  const barW = Math.min(24, (band * 0.7 - gap * (series.length - 1)) / series.length);
  const groupW = series.length * barW + (series.length - 1) * gap;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" role="img" aria-label="${esc(title)}">`);
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  out.push(`<text x="${P.left}" y="26" font-size="16" font-weight="600" fill="${INK}">${esc(title)}</text>`);
  if (subtitle) out.push(`<text x="${P.left}" y="45" font-size="12" fill="${MUTED}">${esc(subtitle)}</text>`);
  // legend (always present for two or more series)
  if (series.length > 1) {
    let lx = P.left;
    for (const [i, s] of series.entries()) {
      out.push(`<rect x="${lx}" y="56" width="10" height="10" rx="2" fill="${COLORS[i]}"/>`);
      out.push(`<text x="${lx + 15}" y="65" font-size="12" fill="${INK}">${esc(s.name)}</text>`);
      lx += 26 + s.name.length * 6.6;
    }
  }
  for (const t of [0, top / 2, top]) {
    out.push(`<line x1="${P.left}" x2="${W - P.right}" y1="${y(t)}" y2="${y(t)}" stroke="${GRID}" stroke-width="1"/>`);
    out.push(`<text x="${P.left - 8}" y="${y(t) + 4}" font-size="11" fill="${MUTED}" text-anchor="end">${fmt(t)}</text>`);
  }
  out.push(`<text x="16" y="${P.top + plotH / 2}" font-size="11" fill="${MUTED}" text-anchor="middle" transform="rotate(-90 16 ${P.top + plotH / 2})">${esc(yLabel)}</text>`);
  groups.forEach((g, gi) => {
    const x0 = P.left + gi * band + (band - groupW) / 2;
    series.forEach((s, si) => {
      const v = s.values[gi];
      if (v === null || v === undefined) return;
      const x = x0 + si * (barW + gap);
      const h = Math.max(1, P.top + plotH - y(v));
      const r = Math.min(4, h, barW / 2);
      const yt = P.top + plotH - h;
      out.push(`<path d="M${x},${P.top + plotH} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + barW - r} Q${x + barW},${yt} ${x + barW},${yt + r} V${P.top + plotH} Z" fill="${COLORS[si]}"><title>${esc(`${s.name}, ${g}: ${v}${unit}`)}</title></path>`);
      out.push(`<text x="${x + barW / 2}" y="${yt - 4}" font-size="10" fill="${INK}" text-anchor="middle">${fmt(v)}</text>`);
    });
    out.push(`<text x="${P.left + gi * band + band / 2}" y="${P.top + plotH + 18}" font-size="12" fill="${INK}" text-anchor="middle">${esc(g)}</text>`);
  });
  out.push(`<line x1="${P.left}" x2="${W - P.right}" y1="${P.top + plotH}" y2="${P.top + plotH}" stroke="#c9ced3"/>`);
  out.push('</svg>');
  return out.join('\n');
}

const write = (name, svg) => {
  fs.writeFileSync(path.join(OUT, name), `${svg}\n`);
  console.log(`docs/performance/${name}`);
};
fs.mkdirSync(OUT, { recursive: true });
const n = (v) => (v === '' || v === undefined ? null : Number(v));

// 1 + 5: search with and without indexes, and with the Redis cache
const idx = readCsv('search-summary.csv');
const noidx = readCsv('search-noindex-summary.csv');
const cache = readCsv('search-cache-summary.csv');
const users = idx.map((r) => `${r.threads} user${r.threads === '1' ? '' : 's'}`);
write('search-throughput.svg', columns({
  title: 'Property search throughput by concurrency',
  subtitle: '10,003 listings, through the gateway, 60 s per level, 0% errors in every run',
  groups: users,
  series: [
    { name: 'MySQL, with indexes', values: idx.map((r) => n(r.throughput_per_s)) },
    { name: 'MySQL, without the search indexes', values: noidx.map((r) => n(r.throughput_per_s)) },
    { name: 'With Redis cache', values: cache.map((r) => n(r.throughput_per_s)) },
  ],
  yLabel: 'requests per second',
  unit: ' req/s',
}));
write('search-latency.svg', columns({
  title: 'Property search latency (MySQL, with indexes)',
  subtitle: 'Latency grows with users once throughput is saturated (~1,150 req/s)',
  groups: users,
  series: [
    { name: 'p50', values: idx.map((r) => n(r.p50_ms)) },
    { name: 'p95', values: idx.map((r) => n(r.p95_ms)) },
    { name: 'p99', values: idx.map((r) => n(r.p99_ms)) },
  ],
  yLabel: 'milliseconds',
  unit: ' ms',
}));
write('search-index-p95.svg', columns({
  title: 'Search p95 latency with and without the indexes',
  subtitle: 'ix_properties_search and ix_properties_rating dropped, then restored',
  groups: users,
  series: [
    { name: 'With indexes', values: idx.map((r) => n(r.p95_ms)) },
    { name: 'Without indexes', values: noidx.map((r) => n(r.p95_ms)) },
  ],
  yLabel: 'p95 milliseconds',
  unit: ' ms',
}));

// cache measured at the property service (20 s, 50 users) vs through the gateway
write('search-cache.svg', columns({
  title: 'Redis cache: property service vs through the gateway (50 users)',
  subtitle: 'Cache gives 3.3x at the service; through the gateway the single Node.js gateway is the ceiling',
  groups: ['Service, no cache', 'Service, cache', 'Gateway, cache'],
  series: [{ name: 'Throughput', values: [1352.8, 4519.5, 851.6] }],
  yLabel: 'requests per second',
  unit: ' req/s',
}));

// 2: booking end to end
const book = readCsv('booking-summary.csv');
write('booking-latency.svg', columns({
  title: 'Booking request: API response and asynchronous pipeline (p95)',
  subtitle: 'Pipeline = publish to Kafka -> booking worker -> row in MySQL, one clock. nothing lost at any rate',
  groups: book.map((r) => `${r.label.match(/(\d+)per_s/)[1]} bookings/s`),
  series: [
    { name: 'API response p95', values: book.map((r) => n(r.api_p95_ms)) },
    { name: 'Pipeline p95', values: book.map((r) => n(r.pipeline_p95_ms)) },
  ],
  yLabel: 'milliseconds',
  unit: ' ms',
}));

// 4: Kafka scaling
const kafka = readCsv('kafka-scaling-summary.csv');
write('kafka-scaling.svg', columns({
  title: 'Booking worker throughput: 1 vs 3 consumers (backlog drain)',
  subtitle: 'booking.requested has 6 partitions; ~15,000 queued bookings per run, all written once',
  groups: kafka.map((r) => `${r.workers} worker${r.workers === '1' ? '' : 's'}`),
  series: [{ name: 'Bookings written per second', values: kafka.map((r) => n(r.rows_per_s)) }],
  yLabel: 'bookings per second',
  unit: '/s',
}));

// 4b: consumer groups, each reading the same backlog
const groups = readCsv('consumer-groups-summary.csv');
const rate = (label, group) => n((groups.find((r) => r.label === label && r.group === group) || {}).per_s);
write('consumer-groups.svg', columns({
  title: 'booking.requested backlog: one consumer group vs three',
  subtitle: 'Each group keeps its own offsets and handled every event; the booking worker is as fast either way',
  groups: ['Booking worker alone', 'Three groups at once'],
  series: [
    { name: 'booking-worker-cg', values: [rate('groups-1', 'booking'), rate('groups-3', 'booking')] },
    { name: 'messaging-cg', values: [null, rate('groups-3', 'messaging')] },
    { name: 'analytics-cg', values: [null, rate('groups-3', 'analytics')] },
  ],
  yLabel: 'events per second',
  unit: '/s',
}));

// 3: AI debate (rule-based parser)
const ai = readCsv('ai-summary.csv').filter((r) => r.parser === 'deterministic');
write('ai-debate.svg', columns({
  title: 'AI debate timings, rule-based parser (p50)',
  subtitle: 'From the task being queued; 3 concurrent debates is feature 13.11. 60/60 debates finished',
  groups: ai.map((r) => `${r.concurrency} at a time`),
  series: [
    { name: 'First agent update', values: ai.map((r) => n(r.first_agent_p50_ms)) },
    { name: 'First challenge', values: ai.map((r) => n(r.first_challenge_p50_ms)) },
    { name: 'Verdict', values: ai.map((r) => n(r.verdict_p50_ms)) },
  ],
  yLabel: 'milliseconds',
  unit: ' ms',
}));
