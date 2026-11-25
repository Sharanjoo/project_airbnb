// AI debate timings for experiment 3 (spec §9) and feature 13.11 (concurrent debates).
//
//   node tests/load/ai-timings.js --tasks 30 --concurrency 3 --label det-c3 [--csv file]
//
// Each task: a load-test guest (tokens from booking-setup.js) posts an AI request through
// the gateway and listens on the task's WebSocket stream until the verdict. Reported per run:
//   first agent update   first agent.published frame   } server clock, measured from the
//   first challenge      first challenge.issued frame  } task's QUEUED frame, so exact
//   verdict              verdict frame                 }
//   WS delivery latency  frame arrival here minus the frame's own timestamp, corrected for
//                        the measured offset between this machine and the containers' clock
// Needs .env loaded (MySQL for the clock offset).
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { getMysql } = require('@airbnb/common');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const TASKS = Number(arg('tasks', 10));
const CONCURRENCY = Number(arg('concurrency', 1));
const LABEL = arg('label', 'ai');
const BASE = arg('base', 'localhost:8080');
const CSV = arg('csv', path.join(__dirname, 'results', 'ai-summary.csv'));
const TOKENS = fs.readFileSync(path.join(__dirname, 'results', 'booking-tokens.tsv'), 'utf8').trim().split('\n');
const REQUESTS = [
  'A quiet place for 2 in San Jose with parking and wifi, under $200 a night',
  'Family trip to Monterey, 4 guests, kitchen and washer, pet friendly',
  'Cheap room near Santa Cruz beach for 1, wifi',
  'Napa cabin for 3 with a pool, rating above 4.5',
  'Business stay in Palo Alto, workspace and fast wifi, 2 nights',
];
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const sorted = (xs) => [...xs].sort((a, b) => a - b);
const pct = (s, p) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]) : null);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

async function clockOffset() { // containers' clock minus this machine's clock
  const sql = getMysql();
  const t0 = Date.now();
  const [[r]] = await sql.query('SELECT UNIX_TIMESTAMP(NOW(3)) * 1000 AS now');
  const t1 = Date.now();
  await sql.end();
  return Number(r.now) - (t0 + t1) / 2;
}

function runTask(i, offset) {
  return new Promise((resolve) => {
    const token = TOKENS[i % TOKENS.length];
    const out = { ok: false, deliveries: [] };
    const finish = () => resolve(out);
    const k = i % REQUESTS.length;
    fetch(`http://${BASE}/api/v1/ai/ai/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ request_text: REQUESTS[k], check_in: day(40 + k), check_out: day(43 + k) }),
    }).then(async (res) => {
      const body = await res.json();
      if (res.status !== 202) { out.error = `${res.status} ${body.error && body.error.code}`; return finish(); }
      const ws = new WebSocket(`ws://${BASE}/api/v1/ai/ai/tasks/${body.data.task_id}/stream?token=${token}`);
      const timer = setTimeout(() => { out.error = 'timeout'; ws.terminate(); finish(); }, 120000);
      let queued = null;
      ws.on('message', (m) => {
        const arrived = Date.now();
        const f = JSON.parse(m);
        const ts = Date.parse(f.timestamp);
        if (f.type === 'status' && f.status === 'QUEUED') queued = ts;
        if (!out.connected) out.connected = arrived;
        // frames created after we connected show real push latency; earlier ones are a replay
        if (ts + (-offset) >= out.connected - 5) out.deliveries.push(arrived - (ts - offset));
        if (queued !== null) {
          if (f.type === 'agent.published' && out.firstAgent === undefined) out.firstAgent = ts - queued;
          if (f.type === 'challenge.issued' && out.firstChallenge === undefined) out.firstChallenge = ts - queued;
          if (f.type === 'verdict') out.verdict = ts - queued;
        }
        if (f.type === 'status' && /AWAITING_APPROVAL|FAILED|TIMED_OUT/.test(f.status)) {
          out.ok = f.status === 'AWAITING_APPROVAL';
          out.final = f.status;
          clearTimeout(timer);
          ws.close();
          finish();
        }
      });
      ws.on('error', (e) => { out.error = e.message; clearTimeout(timer); finish(); });
    }).catch((e) => { out.error = e.message; finish(); });
  });
}

(async () => {
  const offset = await clockOffset();
  const results = [];
  let next = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < TASKS) results.push(await runTask(next++, offset));
  }));
  const okRuns = results.filter((r) => r.ok);
  const col = (k) => sorted(okRuns.map((r) => r[k]).filter((v) => typeof v === 'number'));
  const deliveries = sorted(okRuns.flatMap((r) => r.deliveries));
  const s = {
    label: LABEL,
    tasks: TASKS,
    concurrency: CONCURRENCY,
    completed: okRuns.length,
    failed: results.length - okRuns.length,
    first_agent_p50_ms: pct(col('firstAgent'), 50),
    first_agent_p95_ms: pct(col('firstAgent'), 95),
    first_challenge_p50_ms: pct(col('firstChallenge'), 50),
    first_challenge_p95_ms: pct(col('firstChallenge'), 95),
    verdict_p50_ms: pct(col('verdict'), 50),
    verdict_p95_ms: pct(col('verdict'), 95),
    ws_delivery_avg_ms: avg(deliveries),
    ws_delivery_p50_ms: pct(deliveries, 50),
    ws_delivery_p95_ms: pct(deliveries, 95),
    wall_s: Math.round((Date.now() - started) / 100) / 10,
    clock_offset_ms: Math.round(offset),
  };
  const errors = [...new Set(results.filter((r) => !r.ok).map((r) => r.error || r.final))];
  console.log(`${s.label}: ${s.completed}/${s.tasks} debates finished (concurrency ${s.concurrency}) | first agent p50 ${s.first_agent_p50_ms} p95 ${s.first_agent_p95_ms} ms | first challenge p50 ${s.first_challenge_p50_ms} p95 ${s.first_challenge_p95_ms} ms | verdict p50 ${s.verdict_p50_ms} p95 ${s.verdict_p95_ms} ms | WS delivery avg ${s.ws_delivery_avg_ms}, p50 ${s.ws_delivery_p50_ms}, p95 ${s.ws_delivery_p95_ms} ms${errors.length ? ` | errors: ${errors.join(', ')}` : ''}`);
  const keys = Object.keys(s);
  if (!fs.existsSync(CSV)) fs.writeFileSync(CSV, `${keys.join(',')}\n`);
  fs.appendFileSync(CSV, `${keys.map((k) => s[k]).join(',')}\n`);
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
