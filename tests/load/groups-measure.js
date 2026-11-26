// Per-group drain for the consumer-groups part of experiment 4 (spec §9).
//
//   node tests/load/groups-measure.js --expected 7500 --label groups-3 --groups booking,messaging,analytics --since-ms <epoch> [--csv file]
//
// Waits until every listed consumer group has handled --expected booking.requested events
// from the load-test guests, then reports, per group, how many it handled and how fast:
//   booking    MySQL reservations written by booking-worker-cg (booking_datetime)
//   messaging  trace steps that messaging-cg recorded for booking.requested (thread opened)
//   analytics  events stored by analytics-cg (received_at)
// Rates use each group's own first and last timestamp, so startup and rejoin time do not count.
const fs = require('fs');
const path = require('path');
const { getMysql, getMongo } = require('@airbnb/common');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const EXPECTED = Number(arg('expected', 0));
const LABEL = arg('label', 'groups');
const GROUPS = arg('groups', 'booking').split(',');
const SINCE = Number(arg('since-ms', 0));
const CSV = arg('csv', path.join(__dirname, 'results', 'consumer-groups-summary.csv'));
const TIMEOUT_S = Number(arg('timeout', 900));
const LT = /^gst_lt_/;

(async () => {
  const sql = getMysql();
  const mongo = await getMongo();
  const since = new Date(SINCE).toISOString();
  // each probe returns { n, first, last } in epoch ms
  const probes = {
    async booking() {
      const [[r]] = await sql.query(`SELECT COUNT(*) AS n, UNIX_TIMESTAMP(MIN(booking_datetime)) * 1000 AS first,
        UNIX_TIMESTAMP(MAX(booking_datetime)) * 1000 AS last FROM reservations WHERE guest_id LIKE 'gst\\_lt\\_%'`);
      return { n: Number(r.n), first: Number(r.first), last: Number(r.last) };
    },
    async messaging() {
      const match = { consumer_group: 'messaging-cg', event_type: 'booking.requested', status: 'ok', timestamp: { $gte: since } };
      const [r] = await mongo.collection('traces').aggregate([{ $match: match },
        { $group: { _id: null, n: { $sum: 1 }, first: { $min: '$timestamp' }, last: { $max: '$timestamp' } } }]).toArray();
      return r ? { n: r.n, first: Date.parse(r.first), last: Date.parse(r.last) } : { n: 0 };
    },
    async analytics() {
      const [r] = await mongo.collection('events').aggregate([{ $match: { event_type: 'booking.requested', actor_id: LT } },
        { $group: { _id: null, n: { $sum: 1 }, first: { $min: '$received_at' }, last: { $max: '$received_at' } } }]).toArray();
      return r ? { n: r.n, first: new Date(r.first).getTime(), last: new Date(r.last).getTime() } : { n: 0 };
    },
  };

  const started = Date.now();
  let results = {};
  while (Date.now() - started < TIMEOUT_S * 1000) {
    results = Object.fromEntries(await Promise.all(GROUPS.map(async (g) => [g, await probes[g]()])));
    if (GROUPS.every((g) => results[g].n >= EXPECTED)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await sql.end();
  await mongo.client.close();

  const header = 'label,groups_running,group,expected,handled,drain_s,per_s';
  if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, `${header}\n`);
  for (const g of GROUPS) {
    const r = results[g];
    const drainS = r.n > 1 ? Math.round((r.last - r.first) / 100) / 10 : null;
    const perS = drainS ? Math.round(r.n / drainS) : null;
    console.log(`${LABEL}: ${g.padEnd(9)} handled ${r.n}/${EXPECTED} in ${drainS} s = ${perS}/s`);
    fs.appendFileSync(CSV, `${LABEL},${GROUPS.length},${g},${EXPECTED},${r.n},${drainS},${perS}\n`);
  }
  process.exit(GROUPS.every((g) => results[g].n >= EXPECTED) ? 0 : 1);
})().catch((err) => { console.error(err.message); process.exit(1); });
