// Backlog drain for experiment 4 (Kafka scaling, spec §9).
//
//   node tests/load/drain-measure.js --expected 15000 --label workers-1 [--csv file] [--timeout 900]
//
// Waits until the booking worker(s) have written --expected reservations for the
// load-test guests, then reports how fast the backlog was processed, using only
// MySQL's own timestamps (booking_datetime is set when the worker inserts the row):
//   processing rate = rows / (last write - first write)
const fs = require('fs');
const path = require('path');
const { getMysql } = require('@airbnb/common');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const EXPECTED = Number(arg('expected', 0));
const LABEL = arg('label', 'drain');
const CSV = arg('csv', path.join(__dirname, 'results', 'kafka-scaling-summary.csv'));
const TIMEOUT_S = Number(arg('timeout', 900));
const WORKERS = Number(arg('workers', 0));

(async () => {
  const sql = getMysql();
  const started = Date.now();
  let n = 0;
  while (Date.now() - started < TIMEOUT_S * 1000) {
    const [[row]] = await sql.query("SELECT COUNT(*) AS n FROM reservations WHERE guest_id LIKE 'gst\\_lt\\_%'");
    n = Number(row.n);
    if (n >= EXPECTED) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const [[t]] = await sql.query(
    "SELECT UNIX_TIMESTAMP(MIN(booking_datetime)) * 1000 AS first, UNIX_TIMESTAMP(MAX(booking_datetime)) * 1000 AS last FROM reservations WHERE guest_id LIKE 'gst\\_lt\\_%'",
  );
  // rows written per second over the busiest stretch, second by second (MySQL clock)
  const [perSec] = await sql.query(
    "SELECT COUNT(*) AS c FROM reservations WHERE guest_id LIKE 'gst\\_lt\\_%' GROUP BY FLOOR(UNIX_TIMESTAMP(booking_datetime)) ORDER BY c DESC LIMIT 1",
  );
  await sql.end();
  const spanS = (Number(t.last) - Number(t.first)) / 1000;
  const s = {
    label: LABEL,
    workers: WORKERS,
    expected: EXPECTED,
    written: n,
    complete: n >= EXPECTED,
    drain_s: Math.round(spanS * 10) / 10,
    rows_per_s: spanS > 0 ? Math.round(n / spanS) : null,
    peak_rows_in_one_s: perSec[0] ? Number(perSec[0].c) : null,
  };
  console.log(`${s.label}: ${s.workers} worker(s) wrote ${s.written}/${s.expected} rows in ${s.drain_s} s = ${s.rows_per_s} rows/s (peak ${s.peak_rows_in_one_s} in one second)${s.complete ? '' : ' INCOMPLETE'}`);
  const keys = Object.keys(s);
  if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, `${keys.join(',')}\n`);
  fs.appendFileSync(CSV, `${keys.map((k) => s[k]).join(',')}\n`);
})().catch((err) => { console.error(err.message); process.exit(1); });
