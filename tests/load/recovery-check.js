// Final-consistency check for experiment 6 (failure recovery, spec §9).
//
//   node tests/load/recovery-check.js --expected 10000 --label crash [--since-ms <epoch>] [--csv file]
//
// Waits for the booking worker to write --expected reservations for the load-test
// guests, then checks that the end state is exactly right:
//   - every accepted booking has exactly one reservation (nothing lost, nothing doubled)
//   - every reservation has exactly one status-history row and one processed_events row
//   - booked nights match the reservations (REQUESTED rows own their nights, REJECTED own none)
// and reports how long after --since-ms (for example the restart) the last row was written.
const fs = require('fs');
const path = require('path');
const { getMysql } = require('@airbnb/common');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const EXPECTED = Number(arg('expected', 0));
const LABEL = arg('label', 'recovery');
const SINCE = Number(arg('since-ms', 0));
const CSV = arg('csv', path.join(__dirname, 'results', 'recovery-summary.csv'));
const TIMEOUT_S = Number(arg('timeout', 600));
const LIKE = 'gst\\_lt\\_%';

(async () => {
  const sql = getMysql();
  const one = async (q, p = []) => Number(Object.values((await sql.query(q, p))[0][0])[0]);
  const started = Date.now();
  let n = 0;
  while (Date.now() - started < TIMEOUT_S * 1000) {
    n = await one('SELECT COUNT(*) FROM reservations WHERE guest_id LIKE ?', [LIKE]);
    if (n >= EXPECTED) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const offsetMs = (await one('SELECT UNIX_TIMESTAMP(NOW(3)) * 1000')) - Date.now(); // DB clock - this clock
  const lastWritten = await one('SELECT UNIX_TIMESTAMP(MAX(booking_datetime)) * 1000 FROM reservations WHERE guest_id LIKE ?', [LIKE]);
  const histPerRes = (await sql.query(
    `SELECT SUM(c = 1) AS one_row, SUM(c > 1) AS more, SUM(c = 0) AS none FROM (
       SELECT r.reservation_id, COUNT(h.id) AS c FROM reservations r
       LEFT JOIN reservation_status_history h ON h.reservation_id = r.reservation_id
       WHERE r.guest_id LIKE ? GROUP BY r.reservation_id) x`, [LIKE]))[0][0];
  // processed_events stores the request's idempotency key (a UUID); the reservation id is res_<key without dashes>
  const processedRows = await one(
    `SELECT COUNT(*) FROM processed_events p
     WHERE p.consumer_group = 'booking-worker-cg' AND p.topic = 'booking.requested'
       AND CONCAT('res_', REPLACE(p.idempotency_key, '-', '')) IN (SELECT reservation_id FROM reservations WHERE guest_id LIKE ?)`, [LIKE]);
  const nightsMismatch = await one(
    `SELECT COUNT(*) FROM (
       SELECT r.reservation_id, r.status, DATEDIFF(r.check_out, r.check_in) AS want, COUNT(n.night) AS have
       FROM reservations r LEFT JOIN reservation_nights n ON n.reservation_id = r.reservation_id
       WHERE r.guest_id LIKE ? GROUP BY r.reservation_id, r.status, r.check_in, r.check_out) x
     WHERE (status = 'REQUESTED' AND have <> want) OR (status = 'REJECTED' AND have <> 0)`, [LIKE]);
  await sql.end();

  const s = {
    label: LABEL,
    expected: EXPECTED,
    reservations: n,
    lost: Math.max(0, EXPECTED - n),
    extra: Math.max(0, n - EXPECTED),
    history_exactly_one: Number(histPerRes.one_row || 0),
    history_duplicated: Number(histPerRes.more || 0),
    processed_events: processedRows,
    nights_mismatched: nightsMismatch,
    recovered_after_ms: SINCE ? Math.max(0, Math.round(lastWritten - offsetMs - SINCE)) : null,
  };
  s.consistent = s.lost === 0 && s.extra === 0 && s.history_duplicated === 0 && s.history_exactly_one === n && s.processed_events === n && s.nights_mismatched === 0;
  console.log(`${s.label}: ${s.reservations}/${s.expected} reservations (lost ${s.lost}, extra ${s.extra}) | history: ${s.history_exactly_one} exactly one, ${s.history_duplicated} duplicated | processed_events ${s.processed_events} | nights mismatched ${s.nights_mismatched}${s.recovered_after_ms !== null ? ` | last row ${s.recovered_after_ms} ms after the restart` : ''} | ${s.consistent ? 'CONSISTENT' : 'NOT CONSISTENT'}`);
  const keys = Object.keys(s);
  if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, `${keys.join(',')}\n`);
  fs.appendFileSync(CSV, `${keys.map((k) => s[k]).join(',')}\n`);
})().catch((err) => { console.error(err.message); process.exit(1); });
