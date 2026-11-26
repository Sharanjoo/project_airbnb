// Demo activity for the dashboards (Deliverable C, spec §8).
//
// Needs the stack running: docker compose up -d --build
// Run it with: npm run demo:activity             (adds the activity; run again to start over)
//              npm run demo:activity -- --cleanup (removes everything it added)
//
// The dashboards only show what really happened, so a fresh database shows zeros. This script
// makes a small group of demo guests use the app through the gateway, exactly like the client:
// view and save listings, request bookings, the host approves, declines or cancels some, guests
// and the host exchange messages, and some guests ask the AI for a recommendation and decide on
// it. Every number on the dashboards then comes from those real rows and Kafka events.
//
//   guests  gst_demo_act01 … 08 (log in as gst_demo_act01@demo.invalid with the seed guest's password)
//   host    hst_0001, the seed host (host dashboard), on its listings prp_0001 and prp_0002
// Some stays start today, so occupancy and revenue show in the default 30-day window; the rest
// are in the coming weeks (set To later on the host dashboard to include them).
// Remove it before `npm run test:db`: its bookings hold prp_0001/prp_0002 for the coming
// weeks, so the booking service's scheduler tests would hit DATE_CONFLICT.
// Not covered: reviews and the rating trend need a COMPLETED stay, which only the booking
// scheduler produces after checkout; searches are not published as events.
const { randomUUID } = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const { getMysql, getMongo } = require('@airbnb/common');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* .env is optional when the variables are already set */ }
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env first (see the README quick start).');
  process.exit(1);
}

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const JWT_SECRET = process.env.JWT_SECRET;
const GUESTS = Array.from({ length: 8 }, (_, i) => `gst_demo_act${String(i + 1).padStart(2, '0')}`);
const HOST = 'hst_0001';
const LISTINGS = ['prp_0001', 'prp_0002'];
const AI_GUESTS = GUESTS.slice(0, 3);
const AI_REQUESTS = [
  'A quiet place for 2 in San Jose with parking and wifi, under $250 a night',
  'Family trip to San Jose, 4 guests, kitchen and washer',
  'Cheap room in San Jose for 1 with wifi',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const token = (sub, role) => jwt.sign({ sub, role }, JWT_SECRET, { expiresIn: '30m' });
let failed = 0;
const step = (text) => console.log(`\n${text}`);
const check = (condition, text) => { console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${text}`); if (!condition) failed++; };

async function api(service, route, user, role, body, { method = 'POST', idempotent = false } = {}) {
  const headers = { Authorization: `Bearer ${token(user, role)}`, 'X-Trace-Id': randomUUID() };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotent) headers['Idempotency-Key'] = randomUUID();
  const r = await fetch(`${GATEWAY}/api/v1/${service}${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, data: json.data, error: json.error };
}

async function main() {
  const db = getMysql();
  const q = async (sql, params) => (await db.query(sql, params))[0];
  const mongo = await getMongo();
  const status = async (id) => (await q('SELECT status FROM reservations WHERE reservation_id = ?', [id]))[0]?.status;
  const waitStatus = async (id, want, seconds = 15) => {
    for (const until = Date.now() + seconds * 1000; Date.now() < until; await sleep(150)) if (want.includes(await status(id))) break;
    return status(id);
  };

  async function cleanup() {
    const resIds = (await q('SELECT reservation_id FROM reservations WHERE guest_id IN (?)', [GUESTS])).map((r) => r.reservation_id);
    const tasks = await mongo.collection('ai_tasks').find({ user_id: { $in: GUESTS } }, { projection: { trace_id: 1 } }).toArray();
    const aiTraces = tasks.map((t) => t.trace_id);
    const threads = (await mongo.collection('threads').find({ guest_id: { $in: GUESTS } }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
    const evFilter = {
      $or: [
        { actor_id: { $in: GUESTS } }, { 'payload.guest_id': { $in: GUESTS } }, { 'payload.user_id': { $in: GUESTS } },
        { 'payload.reservation_id': { $in: resIds } }, { 'payload.thread_id': { $in: threads } }, { trace_id: { $in: aiTraces } },
      ],
    };
    const found = await mongo.collection('events').find(evFilter, { projection: { event_id: 1, trace_id: 1 } }).toArray();
    const eventIds = found.map((e) => e.event_id);
    const traceIds = [...new Set([...found.map((e) => e.trace_id), ...aiTraces])];
    if (eventIds.length) await q('DELETE FROM processed_events WHERE event_id IN (?)', [eventIds]);
    if (resIds.length) {
      await q('DELETE FROM reservation_status_history WHERE reservation_id IN (?)', [resIds]);
      await q('DELETE FROM reservations WHERE reservation_id IN (?)', [resIds]); // reservation_nights cascade
    }
    await q('DELETE FROM idempotency_keys WHERE actor_id IN (?)', [GUESTS]);
    if (resIds.length) await q('DELETE FROM idempotency_keys WHERE actor_id = ? AND response_body REGEXP ?', [HOST, resIds.join('|')]);
    await q('DELETE FROM saved_properties WHERE guest_id IN (?)', [GUESTS]);
    const [g] = await db.query('DELETE FROM guests WHERE guest_id IN (?)', [GUESTS]);
    await mongo.collection('messages').deleteMany({ thread_id: { $in: threads } });
    await mongo.collection('threads').deleteMany({ _id: { $in: threads } });
    await mongo.collection('debate_messages').deleteMany({ trace_id: { $in: aiTraces } });
    await mongo.collection('feedback').deleteMany({ trace_id: { $in: aiTraces } });
    await mongo.collection('ai_tasks').deleteMany({ user_id: { $in: GUESTS } });
    const ev = await mongo.collection('events').deleteMany(evFilter);
    await mongo.collection('traces').deleteMany({ trace_id: { $in: traceIds } }); // consumers' trace steps
    return { guests: g.affectedRows, reservations: resIds.length, events: ev.deletedCount, threads: threads.length, aiTasks: tasks.length };
  }

  try {
    const removed = await cleanup();
    if (process.argv.includes('--cleanup')) {
      console.log(`removed: ${removed.guests} demo guests, ${removed.reservations} reservations, ${removed.threads} threads, ${removed.aiTasks} AI tasks, ${removed.events} events`);
      return;
    }
    const hash = (await q("SELECT password_hash FROM guests WHERE guest_id = 'gst_0001'"))[0].password_hash;
    const names = ['Ana', 'Ben', 'Chloe', 'Dev', 'Ema', 'Finn', 'Gia', 'Hugo'];
    for (const [i, id] of GUESTS.entries()) {
      await q('INSERT INTO guests (guest_id, first_name, last_name, email, password_hash, location) VALUES (?, ?, ?, ?, ?, ?)',
        [id, names[i], 'Demo', `${id}@demo.invalid`, hash, 'San Jose, CA']);
    }

    step('Step 1: guests browse and save listings');
    const others = (await q("SELECT property_id FROM properties WHERE status = 'active' AND property_id NOT IN (?) ORDER BY property_id LIMIT 6", [LISTINGS])).map((r) => r.property_id);
    let views = 0;
    let saves = 0;
    for (const [i, g] of GUESTS.entries()) {
      for (const pid of [...LISTINGS, others[i % others.length], others[(i + 2) % others.length]]) {
        if ((await api('property', '/properties/get', g, 'guest', { property_id: pid })).status === 200) views++;
      }
      if ((await api('property', '/properties/save', g, 'guest', { property_id: LISTINGS[i % 2], saved: true })).status === 200) saves++;
      if (i % 3 === 0) { // saved, then changed their mind
        await api('property', '/properties/save', g, 'guest', { property_id: others[i % others.length], saved: true });
        await api('property', '/properties/save', g, 'guest', { property_id: others[i % others.length], saved: false });
      }
    }
    check(views === GUESTS.length * 4, `${views} listing views, ${saves} saves`);

    step('Step 2: guests request stays; the host approves most, declines one, cancels one; a guest cancels one');
    // [guest index, listing index, check-in offset (days), nights, what happens]
    const plan = [
      [0, 0, 0, 2, 'approve'], [1, 1, 0, 3, 'approve'], [2, 0, 4, 2, 'approve'], [3, 1, 6, 2, 'approve'],
      [4, 0, 9, 3, 'decline'], [5, 1, 12, 2, 'host-cancel'], [6, 0, 15, 2, 'guest-cancel'], [7, 1, 18, 2, 'approve'],
      [0, 1, 22, 2, 'pending'], [1, 0, 25, 2, 'pending'],
    ];
    const outcome = {};
    for (const [gi, li, offset, nights, action] of plan) {
      const g = GUESTS[gi];
      const req = await api('booking', '/bookings/request', g, 'guest',
        { property_id: LISTINGS[li], check_in: day(offset), check_out: day(offset + nights), guest_count: 2, guest_message: `Hi! ${names[gi]} here, looking forward to it.` },
        { idempotent: true });
      const id = req.data && req.data.reservation_id;
      if (req.status !== 202 || (await waitStatus(id, ['REQUESTED', 'REJECTED'])) !== 'REQUESTED') {
        check(false, `${g} ${LISTINGS[li]} ${day(offset)}: not held (${req.status} ${req.error ? req.error.code : await status(id)})`);
        continue;
      }
      if (action === 'approve' || action === 'host-cancel' || action === 'guest-cancel') {
        await api('booking', '/bookings/approve', HOST, 'host', { reservation_id: id }, { idempotent: true });
        await waitStatus(id, ['CONFIRMED']);
      }
      if (action === 'decline') await api('booking', '/bookings/decline', HOST, 'host', { reservation_id: id, reason: 'Those dates do not work for us, sorry.' }, { idempotent: true });
      if (action === 'host-cancel') await api('booking', '/bookings/cancel', HOST, 'host', { reservation_id: id, cancellation_reason: 'Maintenance on the property.' }, { idempotent: true });
      if (action === 'guest-cancel') await api('booking', '/bookings/cancel', g, 'guest', { reservation_id: id, cancellation_reason: 'Change of plans.' }, { idempotent: true });
      const want = { approve: 'CONFIRMED', decline: 'DECLINED', 'host-cancel': 'CANCELLED', 'guest-cancel': 'CANCELLED', pending: 'REQUESTED' }[action];
      const final = await waitStatus(id, [want]);
      outcome[final] = (outcome[final] || 0) + 1;
      if (final !== want) check(false, `${g} ${LISTINGS[li]} ${day(offset)}: ${final}, expected ${want}`);
    }
    check(Object.values(outcome).reduce((a, b) => a + b, 0) === plan.length, `reservations: ${Object.entries(outcome).map(([k, v]) => `${v} ${k}`).join(', ')}`);

    step('Step 3: guests message the host about their stay; the host replies');
    await sleep(1500); // the messaging worker opens a thread per booking request
    let sent = 0;
    for (const g of GUESTS.slice(0, 5)) {
      const list = await api('messaging', '/threads/byUser', g, 'guest', {});
      const thread = list.data && list.data.items.find((t) => LISTINGS.includes(t.property_id));
      if (!thread) continue;
      const a = await api('messaging', '/messages/send', g, 'guest', { thread_id: thread.thread_id, message_text: 'What time is check-in?', client_message_id: randomUUID() });
      await sleep(400);
      const b = await api('messaging', '/messages/send', HOST, 'host', { thread_id: thread.thread_id, message_text: 'Any time after 3 pm. The code will be in the app.', client_message_id: randomUUID() });
      if (a.status < 300 && b.status < 300) sent += 2;
    }
    check(sent >= 6, `${sent} messages in ${sent / 2} threads`);

    step('Step 4: guests ask the AI for a recommendation and decide on it');
    const decisions = ['approved', 'rejected', 'approved'];
    let decided = 0;
    for (const [i, g] of AI_GUESTS.entries()) {
      const r = await api('ai', '/ai/requests', g, 'guest', { request_text: AI_REQUESTS[i], check_in: day(40 + i * 3), check_out: day(42 + i * 3) });
      const taskId = r.data && r.data.task_id;
      if (!taskId) { check(false, `${g}: AI request ${r.status} ${r.error && r.error.code}`); continue; }
      let task;
      for (const until = Date.now() + 30000; Date.now() < until; await sleep(300)) {
        task = (await api('ai', `/ai/tasks/${taskId}`, g, 'guest', null, { method: 'GET' })).data;
        if (task && ['AWAITING_APPROVAL', 'FAILED', 'TIMED_OUT'].includes(task.status)) break;
      }
      if (!task || task.status !== 'AWAITING_APPROVAL') { check(false, `${g}: AI task ended ${task && task.status}`); continue; }
      const d = await api('ai', `/ai/tasks/${taskId}/approve`, g, 'guest', { decision: decisions[i], reason: decisions[i] === 'rejected' ? 'Too far from where I need to be.' : null }, { idempotent: true });
      if (d.status < 300) decided++;
    }
    check(decided === AI_GUESTS.length, `${decided} AI recommendations decided (${decisions.join(', ')})`);

    await sleep(2000); // let the analytics consumer store the last events
    const stored = await mongo.collection('events').countDocuments({ $or: [{ actor_id: { $in: [...GUESTS, HOST] } }, { 'payload.guest_id': { $in: GUESTS } }] });
    check(stored > 0, `${stored} events stored by the analytics consumer so far`);
    step('Where to look');
    console.log(`  host dashboard:     log in as the seed host (hst_0001), Dashboard`);
    console.log(`  guest dashboard:    log in as ${GUESTS[0]}@demo.invalid (seed guest password), Dashboard`);
    console.log('  platform and AI:    an admin account, /dashboards/platform');
    console.log('  remove it all:      npm run demo:activity -- --cleanup');
  } finally {
    await db.end();
    await mongo.client.close();
    if (!process.argv.includes('--cleanup')) console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exitCode = failed ? 1 : 0;
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
