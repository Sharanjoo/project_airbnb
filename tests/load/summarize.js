// Summarise a JMeter results file (.jtl, CSV) into the numbers spec §9 asks for:
// throughput, average latency, p50, p95, p99 and error rate.
//   node tests/load/summarize.js <file.jtl> [--label name] [--csv tests/load/results/summary.csv]
// Prints one line, and appends a row to the summary CSV for the report's graphs.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const file = args[0];
if (!file || !fs.existsSync(file)) {
  console.error('usage: node tests/load/summarize.js <file.jtl> [--label name] [--csv file]');
  process.exit(1);
}
const label = arg('label', path.basename(file, '.jtl'));
const csvOut = arg('csv', path.join(__dirname, 'results', 'summary.csv'));

const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
const cols = header.split(',');
const col = (name) => cols.indexOf(name);
const iTs = col('timeStamp');
const iEl = col('elapsed');
const iOk = col('success');
const iThreads = col('allThreads');

const rows = lines.map((l) => l.split(',')).filter((r) => r.length >= cols.length - 1);
if (!rows.length) {
  console.error(`${file}: no samples`);
  process.exit(1);
}
const elapsed = rows.map((r) => Number(r[iEl])).sort((a, b) => a - b);
const start = Math.min(...rows.map((r) => Number(r[iTs])));
const end = Math.max(...rows.map((r) => Number(r[iTs]) + Number(r[iEl])));
const errors = rows.filter((r) => r[iOk] !== 'true').length;
const threads = Math.max(...rows.map((r) => Number(r[iThreads]) || 0));
const pct = (p) => elapsed[Math.min(elapsed.length - 1, Math.ceil((p / 100) * elapsed.length) - 1)];

const s = {
  label,
  threads,
  samples: rows.length,
  duration_s: Math.round((end - start) / 100) / 10,
  throughput_per_s: Math.round((rows.length / ((end - start) / 1000)) * 10) / 10,
  avg_ms: Math.round(elapsed.reduce((a, b) => a + b, 0) / elapsed.length),
  p50_ms: pct(50),
  p95_ms: pct(95),
  p99_ms: pct(99),
  error_rate: Math.round((errors / rows.length) * 10000) / 100, // percent
};

console.log(`${s.label}: ${s.threads} threads, ${s.samples} samples in ${s.duration_s} s | ${s.throughput_per_s} req/s | avg ${s.avg_ms} ms, p50 ${s.p50_ms}, p95 ${s.p95_ms}, p99 ${s.p99_ms} | errors ${s.error_rate}%`);

const keys = Object.keys(s);
if (!fs.existsSync(csvOut)) fs.writeFileSync(csvOut, `${keys.join(',')}\n`);
fs.appendFileSync(csvOut, `${keys.map((k) => s[k]).join(',')}\n`);
