// End-to-end booking time for experiment 2 (spec §9) and Kafka scaling (4).
//
//   node tests/load/booking-e2e.js <file.jtl> [--label name] [--csv file] [--wait 180]
//
// The JMeter results must include the Idempotency-Key (run with -Jsample_variables=idem).
// For every accepted request (202) the booking service names the reservation
// res_<key without dashes>; this script waits until the booking worker has written
// each of those rows, then reports:
//   API latency   JMeter's own response time for POST /bookings/request
//   pipeline      row written by the worker minus the moment the booking service published
//                 booking.requested (envelope timestamp, stored by analytics-worker). Both clocks
//                 are inside the same Docker VM, so this is exact: Kafka + worker + MySQL.
//   client e2e    row written minus request sent by JMeter (two clocks, corrected for their
//                 measured offset; a few ms of drift remain, so use it for trends only)
//   drain         how long after the last publish the worker wrote its last row (backlog)
const fs = require('fs');
const path = require('path');
const { getMysql, getMongo } = require('@airbnb/common');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const file = args[0];
const label = arg('label', path.basename(file || '', '.jtl'));
const csvOut = arg('csv', path.join(__dirname, 'results', 'booking-summary.csv'));
const WAIT_S = Number(arg('wait', 180));

/** CSV parser for JMeter results: quoted fields may contain commas, quotes and line breaks. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cur); cur = ''; } else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const sorted = (xs) => [...xs].sort((a, b) => a - b);
const pct = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

(async () => {
  if (!file || !fs.existsSync(file)) throw new Error('usage: node tests/load/booking-e2e.js <file.jtl> [--label name]');
  const [cols, ...rows] = parseCsv(fs.readFileSync(file, 'utf8').trim());
  const c = (n) => cols.indexOf(n);
  if (c('idem') === -1) throw new Error('no idem column: run JMeter with -Jsample_variables=idem');
  const sent = rows.map((r) => ({ ts: Number(r[c('timeStamp')]), elapsed: Number(r[c('elapsed')]), code: r[c('responseCode')], idem: r[c('idem')] }));
  const codes = {};
  for (const s of sent) codes[s.code] = (codes[s.code] || 0) + 1;
  const accepted = sent.filter((s) => s.code === '202' && s.idem);
  const byId = new Map(accepted.map((s) => [`res_${s.idem.replace(/-/g, '')}`, s]));
  const firstSent = Math.min(...sent.map((s) => s.ts));
  const lastSent = Math.max(...sent.map((s) => s.ts));

  const sql = getMysql();
  // offset between the database clock and this machine's clock, measured around one query
  const t0 = Date.now();
  const [[{ dbNow }]] = await sql.query('SELECT UNIX_TIMESTAMP(NOW(3)) * 1000 AS dbNow');
  const t1 = Date.now();
  const offset = Number(dbNow) - (t0 + t1) / 2;

  const ids = [...byId.keys()];
  const found = new Map();
  const deadline = Date.now() + WAIT_S * 1000;
  while (found.size < ids.length && Date.now() < deadline) {
    const missing = ids.filter((id) => !found.has(id));
    for (let i = 0; i < missing.length; i += 1000) {
      const chunk = missing.slice(i, i + 1000);
      const [got] = await sql.query(
        'SELECT reservation_id, status, cancellation_reason, UNIX_TIMESTAMP(booking_datetime) * 1000 AS written FROM reservations WHERE reservation_id IN (?)',
        [chunk],
      );
      for (const g of got) found.set(g.reservation_id, g);
    }
    if (found.size < ids.length) await new Promise((r) => setTimeout(r, 1000));
  }
  await sql.end();

  // publish time of each booking.requested, from the analytics events store (same clock as MySQL)
  const db = await getMongo();
  const published = new Map();
  const pubDeadline = Date.now() + 60000;
  while (published.size < found.size && Date.now() < pubDeadline) {
    const need = [...found.keys()].filter((id) => !published.has(id));
    for (let i = 0; i < need.length; i += 5000) {
      const docs = await db.collection('events').find(
        { event_type: 'booking.requested', 'entity.entity_id': { $in: need.slice(i, i + 5000) } },
        { projection: { _id: 0, 'entity.entity_id': 1, timestamp: 1 } },
      ).toArray();
      for (const d of docs) {
        const t = Date.parse(d.timestamp);
        const id = d.entity.entity_id;
        if (!published.has(id) || t < published.get(id)) published.set(id, t);
      }
    }
    if (published.size < found.size) await new Promise((r) => setTimeout(r, 1000));
  }
  await db.client.close();

  const pipeline = [];
  let lastPublished = 0;
  let lastWrittenDb = 0;
  for (const [id, g] of found) {
    if (!published.has(id)) continue;
    pipeline.push(Number(g.written) - published.get(id));
    lastPublished = Math.max(lastPublished, published.get(id));
    lastWrittenDb = Math.max(lastWrittenDb, Number(g.written));
  }

  const e2e = [];
  const outcomes = {};
  let lastWritten = 0;
  for (const [id, g] of found) {
    const written = Number(g.written) - offset;
    e2e.push(written - byId.get(id).ts);
    lastWritten = Math.max(lastWritten, written);
    const k = g.status === 'REJECTED' ? `REJECTED_${g.cancellation_reason || ''}` : g.status;
    outcomes[k] = (outcomes[k] || 0) + 1;
  }
  const api = sorted(sent.map((s) => s.elapsed));
  const e = sorted(e2e);
  const pl = sorted(pipeline);
  const r0 = (v) => (v === null ? null : Math.round(v));
  const s = {
    label,
    requests: sent.length,
    send_rate_per_s: Math.round((sent.length / Math.max(1, (lastSent - firstSent) / 1000)) * 10) / 10,
    accepted: accepted.length,
    non_202: sent.length - accepted.length,
    written: found.size,
    missing: ids.length - found.size,
    api_p50_ms: pct(api, 50),
    api_p95_ms: pct(api, 95),
    api_p99_ms: pct(api, 99),
    pipeline_measured: pl.length,
    pipeline_avg_ms: avg(pl),
    pipeline_p50_ms: r0(pct(pl, 50)),
    pipeline_p95_ms: r0(pct(pl, 95)),
    pipeline_p99_ms: r0(pct(pl, 99)),
    pipeline_max_ms: pl.length ? r0(pl[pl.length - 1]) : null,
    drain_ms: lastWrittenDb ? Math.max(0, Math.round(lastWrittenDb - lastPublished)) : null,
    client_e2e_p50_ms: r0(pct(e, 50)),
    client_e2e_p95_ms: r0(pct(e, 95)),
    clock_offset_ms: Math.round(offset),
  };
  console.log(`${s.label}: ${s.requests} requests at ${s.send_rate_per_s}/s | ${s.accepted} accepted, ${s.written} written, ${s.missing} missing | API p50 ${s.api_p50_ms} p95 ${s.api_p95_ms} p99 ${s.api_p99_ms} ms | pipeline (publish -> Kafka -> worker -> MySQL) avg ${s.pipeline_avg_ms}, p50 ${s.pipeline_p50_ms}, p95 ${s.pipeline_p95_ms}, p99 ${s.pipeline_p99_ms}, max ${s.pipeline_max_ms} ms over ${s.pipeline_measured} | drain ${s.drain_ms} ms`);
  console.log(`  status codes: ${JSON.stringify(codes)} | outcomes: ${JSON.stringify(outcomes)} | clock offset ${s.clock_offset_ms} ms`);
  const keys = Object.keys(s);
  if (!fs.existsSync(csvOut)) fs.writeFileSync(csvOut, `${keys.join(',')}\n`);
  fs.appendFileSync(csvOut, `${keys.map((k) => s[k]).join(',')}\n`);
})().catch((err) => { console.error(err.message); process.exit(1); });
