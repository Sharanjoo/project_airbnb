// Demo for feature 13.4: real-time booking state, and its notification latency.
//
// Needs the stack running: docker compose up -d --build
// Run it with: npm run demo:realtime        (ROUNDS=20 for more samples, WAIT_S=20 to open the page first,
//                                           CHECK_IN=2027-01-10 for other dates)
//
// What it shows:
//   1. A viewer is on a listing page: a WebSocket subscribed to property:<id>, exactly as the
//      PropertyDetail page does.
//   2. Another guest requests the same dates and the host approves. The booking worker publishes
//      booking.confirmed; Kafka carries it to the notification gateway, which pushes it to the
//      viewer. The viewer gets dates and status only, never who booked.
//   3. The viewer now tries to book the same dates anyway. The API accepts the request (202) but
//      the booking worker rejects it with DATE_CONFLICT, so a stale booking cannot succeed.
//   4. Latency, from the event to the viewer: each frame carries event_at (the event's own
//      timestamp, set by the producer) and arrives at a measured time here. The containers'
//      clock and this machine's clock are compared through MySQL NOW(3) and corrected for.
//      Each round also cancels the booking, which is pushed too, so every round gives 2 samples.
//      The first push after the gateway (re)starts waits for its Kafka consumer group to form;
//      a warm-up round measures that separately and is not counted.
// The demo guests, bookings, events and threads are removed at the end.
const { randomUUID } = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { getMysql, getMongo } = require('@airbnb/common');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* .env is optional when the variables are already set */ }
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env first (see the README quick start).');
  process.exit(1);
}

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const NOTIFY = process.env.NOTIFY_URL || 'ws://localhost:8009/ws';
const JWT_SECRET = process.env.JWT_SECRET;
const ROUNDS = Number(process.env.ROUNDS || 10);
const PROPERTY = 'prp_0002';
const HOST = 'hst_0001';
const BOOKER = 'gst_demo_rt1';
const VIEWER = 'gst_demo_rt2';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
// inside the listing page's 90-day calendar, so the UI also greys out the dates
const STAY_IN = process.env.CHECK_IN || day(30);
const STAY_OUT = new Date(Date.parse(STAY_IN) + 2 * 86400000).toISOString().slice(0, 10);
const WARM_IN = day(34);
const WAIT_S = Number(process.env.WAIT_S || 0);
const PUBLIC_FIELDS = new Set(['property_id', 'check_in', 'check_out', 'start_date', 'end_date', 'status', 'new_status', 'availability_version']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const step = (text) => console.log(`\n${text}`);
const check = (condition, text) => { console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${text}`); if (!condition) failed++; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };
const token = (sub, role) => jwt.sign({ sub, role }, JWT_SECRET, { expiresIn: '15m' });

async function main() {
  const db = getMysql();
  const q = async (sql, params) => (await db.query(sql, params))[0];
  const mongo = await getMongo();
  const traces = [];
  const call = async (path, user, role, body) => {
    const traceId = randomUUID();
    traces.push(traceId);
    const r = await fetch(`${GATEWAY}/api/v1/booking${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), 'X-Trace-Id': traceId, Authorization: `Bearer ${token(user, role)}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json(), traceId };
  };
  const status = async (id) => (await q('SELECT status FROM reservations WHERE reservation_id = ?', [id]))[0]?.status;
  const waitStatus = async (id, want, seconds = 15) => {
    for (const until = Date.now() + seconds * 1000; Date.now() < until; await sleep(100)) if (want.includes(await status(id))) return status(id);
    return status(id);
  };

  const cleanup = async () => {
    const ids = (await q("SELECT reservation_id FROM reservations WHERE guest_id IN (?, ?)", [BOOKER, VIEWER])).map((r) => r.reservation_id);
    // events the consumers recorded for this demo, then the rows they wrote
    const eventIds = (await mongo.collection('events').find({ trace_id: { $in: traces } }, { projection: { event_id: 1 } }).toArray()).map((e) => e.event_id);
    if (eventIds.length) await q('DELETE FROM processed_events WHERE event_id IN (?)', [eventIds]);
    if (ids.length) {
      await q('DELETE FROM reservation_status_history WHERE reservation_id IN (?)', [ids]);
      await q('DELETE FROM reservations WHERE reservation_id IN (?)', [ids]); // reservation_nights cascade
    }
    await q('DELETE FROM idempotency_keys WHERE actor_id IN (?, ?, ?) AND created_at > NOW() - INTERVAL 1 HOUR', [BOOKER, VIEWER, HOST]);
    await q('DELETE FROM guests WHERE guest_id IN (?, ?)', [BOOKER, VIEWER]);
    const threads = await mongo.collection('threads').find({ guest_id: { $in: [BOOKER, VIEWER] } }, { projection: { _id: 1 } }).toArray();
    await mongo.collection('messages').deleteMany({ thread_id: { $in: threads.map((t) => t._id) } });
    await mongo.collection('threads').deleteMany({ guest_id: { $in: [BOOKER, VIEWER] } });
    if (traces.length) {
      await mongo.collection('events').deleteMany({ trace_id: { $in: traces } });
      await mongo.collection('traces').deleteMany({ trace_id: { $in: traces } });
    }
  };

  let ws;
  try {
    await cleanup();
    const hash = (await q("SELECT password_hash FROM guests WHERE guest_id = 'gst_0001'"))[0].password_hash;
    for (const [i, id] of [BOOKER, VIEWER].entries()) {
      await q('INSERT INTO guests (guest_id, first_name, last_name, email, password_hash) VALUES (?, ?, ?, ?, ?)', [id, 'Demo', `Realtime${i + 1}`, `${id}@demo.invalid`, hash]);
    }
    const t0 = Date.now();
    const [[clock]] = await db.query('SELECT UNIX_TIMESTAMP(NOW(3)) * 1000 AS now');
    const offset = Math.round(Number(clock.now) - (t0 + Date.now()) / 2); // containers' clock minus this machine's

    step(`Step 1: ${VIEWER} opens listing ${PROPERTY} (WebSocket, channel property:${PROPERTY})`);
    ws = new WebSocket(`${NOTIFY}?token=${token(VIEWER, 'guest')}`);
    const frames = [];
    ws.on('message', (m) => frames.push({ arrived: Date.now(), f: JSON.parse(m) }));
    await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
    ws.send(JSON.stringify({ subscribe: [`property:${PROPERTY}`] }));
    await sleep(300);
    check(ws.readyState === WebSocket.OPEN, 'viewer connected and subscribed');
    console.log(`  To watch it in the UI too, sign in as another guest and open\n    http://localhost:5173/properties/${PROPERTY}?check_in=${STAY_IN}&check_out=${STAY_OUT}`);
    if (WAIT_S) { console.log(`  waiting ${WAIT_S} s so you can open it…`); await sleep(WAIT_S * 1000); }

    const book = async (round, guest = BOOKER) => {
      const checkIn = round === 0 ? WARM_IN : STAY_IN; // each round is cancelled before the next, so the dates repeat
      const checkOut = new Date(Date.parse(checkIn) + 2 * 86400000).toISOString().slice(0, 10);
      const req = await call('/bookings/request', guest, 'guest', { property_id: PROPERTY, check_in: checkIn, check_out: checkOut, guest_count: 2 });
      const id = req.body.data && req.body.data.reservation_id;
      const held = req.status === 202 && (await waitStatus(id, ['REQUESTED', 'REJECTED'])) === 'REQUESTED';
      return { id, checkIn, checkOut, held };
    };
    const frameFor = async (traceId, type, seconds) => {
      for (const until = Date.now() + seconds * 1000; Date.now() < until; await sleep(10)) {
        const hit = frames.find((x) => x.f.trace_id === traceId && x.f.type === type);
        if (hit) return hit;
      }
      return null;
    };
    const counted = []; // { traceId, type } of the pushes that are measured

    // A gateway that has just (re)started is still joining its Kafka consumer group, and its
    // first push waits for that. Do one uncounted round first so the numbers below are steady state.
    step('Step 2: warm-up round (not counted): book, approve, cancel');
    const warm = await book(0);
    const warmApprove = await call('/bookings/approve', HOST, 'host', { reservation_id: warm.id });
    const warmFrame = await frameFor(warmApprove.traceId, 'booking.confirmed', 60);
    const warmMs = warmFrame && warmFrame.f.event_at ? warmFrame.arrived - (Date.parse(warmFrame.f.event_at) - offset) : null;
    check(Boolean(warmFrame), `first push arrived ${warmMs} ms after its event${warmMs > 1000 ? ' (the gateway was still joining its consumer group: warm up before a live demo)' : ''}`);
    await call('/bookings/cancel', HOST, 'host', { reservation_id: warm.id, cancellation_reason: 'demo warm-up' });
    await waitStatus(warm.id, ['CANCELLED']);

    let firstFrame = null;
    step(`Step 3: ${BOOKER} books, ${HOST} approves; ${VIEWER} is watching the listing`);
    for (let i = 1; i <= ROUNDS; i++) {
      const stay = await book(i);
      if (!stay.held) { check(false, `round ${i}: request was not held`); continue; }
      const approve = await call('/bookings/approve', HOST, 'host', { reservation_id: stay.id });
      counted.push({ traceId: approve.traceId, type: 'booking.confirmed' });
      const confirmed = await frameFor(approve.traceId, 'booking.confirmed', 10);
      if (i === 1) {
        firstFrame = confirmed;
        check(Boolean(confirmed), `viewer received booking.confirmed for ${stay.checkIn} to ${stay.checkOut} without reloading`);
        if (confirmed) {
          const keys = Object.keys(confirmed.f.payload || {});
          check(keys.every((k) => PUBLIC_FIELDS.has(k)), `the push holds dates and status only: [${keys.join(', ')}]`);
        }
        // the viewer tries the same dates anyway, while they are CONFIRMED for someone else
        const stale = await call('/bookings/request', VIEWER, 'guest', { property_id: PROPERTY, check_in: stay.checkIn, check_out: stay.checkOut, guest_count: 1 });
        const staleId = stale.body.data && stale.body.data.reservation_id;
        const final = staleId ? await waitStatus(staleId, ['REJECTED', 'REQUESTED']) : null;
        const [reason] = staleId ? await q('SELECT reason FROM reservation_status_history WHERE reservation_id = ? ORDER BY id DESC LIMIT 1', [staleId]) : [];
        check(final === 'REJECTED', `${VIEWER} books the same dates anyway: API ${stale.status}, worker ${final}${reason && reason.reason ? ` (${reason.reason})` : ''}`);
        console.log(`  … ${ROUNDS - 1} more rounds, each cancelled afterwards (the cancellation is pushed too)`);
      }
      const cancel = await call('/bookings/cancel', HOST, 'host', { reservation_id: stay.id, cancellation_reason: 'demo: free the nights for the next round' });
      counted.push({ traceId: cancel.traceId, type: 'booking.cancelled' });
      await waitStatus(stay.id, ['CANCELLED']);
      await frameFor(cancel.traceId, 'booking.cancelled', 10);
    }
    await sleep(500);
    const samples = [];
    for (const { traceId, type } of counted) {
      const hit = frames.find((x) => x.f.trace_id === traceId && x.f.type === type);
      if (hit && hit.f.event_at) samples.push({ type, ms: hit.arrived - (Date.parse(hit.f.event_at) - offset), gateway_ms: hit.arrived - (Date.parse(hit.f.sent_at) - offset) });
    }

    step('Step 4: notification latency, event -> viewer (ms), steady state');
    const all = samples.map((s) => s.ms);
    const gw = samples.map((s) => s.gateway_ms);
    check(samples.length === ROUNDS * 2, `${samples.length} pushes measured (${ROUNDS} confirmed + ${ROUNDS} cancelled expected)`);
    for (const type of ['booking.confirmed', 'booking.cancelled']) {
      const xs = samples.filter((s) => s.type === type).map((s) => s.ms);
      if (xs.length) console.log(`  ${type.padEnd(18)} n=${xs.length}  p50 ${pct(xs, 50)}  p95 ${pct(xs, 95)}  max ${Math.max(...xs)}`);
    }
    if (all.length) {
      console.log(`  ${'all'.padEnd(18)} n=${all.length}  p50 ${pct(all, 50)}  p95 ${pct(all, 95)}  max ${Math.max(...all)}`);
      console.log(`  of which gateway -> viewer: p50 ${pct(gw, 50)}  p95 ${pct(gw, 95)}  (the rest is Kafka and the gateway's consumer)`);
      console.log(`  clock offset corrected: ${offset} ms (measured to about ±2 ms, so single-digit values are approximate)`);
      console.log(`  trace of the first confirmation: ${firstFrame ? firstFrame.f.trace_id : '-'}`);
    }
  } finally {
    if (ws) ws.close();
    await sleep(1500); // let the consumers finish writing before removing their rows
    await cleanup();
    await db.end();
    await mongo.client.close();
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exit(failed ? 1 : 0);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
