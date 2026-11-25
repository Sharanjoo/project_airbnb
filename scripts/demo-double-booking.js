// Demo for feature 13.1: no double booking when guests race for the same nights.
//
// Needs the stack running: docker compose up -d --build
// Run it with: npm run demo:booking
//
// What it shows:
//   1. Ten different guests ask for the same property and the same two nights at the same moment.
//   2. The API accepts all of them (202), because it only checks the request and publishes an event.
//   3. The booking worker claims the nights in MySQL. The unique key on (property_id, night)
//      lets exactly one transaction win. Every other request is rejected with DATE_CONFLICT.
//   4. The winner cancels. The nights are freed and a new guest can book them.
// It prints the real rows from the database, with the trace id of every request, so the
// output can be used as evidence in the report. The demo guests and bookings are removed at the end.
const { randomUUID } = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const { getMysql } = require('@airbnb/common');

// Settings (JWT secret, database and Kafka addresses) come from .env, as in the README quick start.
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* .env is optional when the variables are already set */ }
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env first (see the README quick start).');
  process.exit(1);
}

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const JWT_SECRET = process.env.JWT_SECRET;
const RACERS = Number(process.env.RACERS || 10);
const PROPERTY = 'prp_0001';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const step = (text) => console.log(`\n${text}`);
const check = (condition, text) => { console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${text}`); if (!condition) failed++; };

async function waitFor(fn, seconds, what) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(250);
  }
  check(false, `timed out waiting for ${what}`);
  return false;
}

async function main() {
  const db = getMysql(); // connection settings come from the shared helper and .env
  // query (not execute) so a list passed to IN (?) is expanded into the statement
  const q = async (sql, params) => (await db.query(sql, params))[0];
  const call = (path, guestId, body, key = randomUUID(), traceId = randomUUID()) =>
    fetch(`${GATEWAY}/api/v1/booking${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Idempotency-Key': key, 'X-Trace-Id': traceId,
        Authorization: `Bearer ${jwt.sign({ sub: guestId, role: 'guest' }, JWT_SECRET, { expiresIn: '15m' })}`,
      },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json(), traceId }));

  // ten demo guests, so every request comes from a different person
  const guests = Array.from({ length: RACERS }, (_, i) => `gst_demo${String(i + 1).padStart(2, '0')}`);
  const hash = (await q("SELECT password_hash FROM guests WHERE guest_id = 'gst_0001'"))[0].password_hash;
  const cleanup = async () => {
    for (const r of await q('SELECT reservation_id FROM reservations WHERE guest_id LIKE ?', ['gst_demo%'])) {
      await q('DELETE FROM reservation_status_history WHERE reservation_id = ?', [r.reservation_id]);
      await q('DELETE FROM reservations WHERE reservation_id = ?', [r.reservation_id]);
    }
    await q("DELETE FROM guests WHERE guest_id LIKE 'gst_demo%'");
  };

  try {
    await cleanup();
    for (const [i, id] of guests.entries()) {
      await q('INSERT INTO guests (guest_id, first_name, last_name, email, password_hash) VALUES (?, ?, ?, ?, ?)', [id, 'Demo', `Guest${i + 1}`, `${id}@demo.invalid`, hash]);
    }

    const checkIn = new Date(Date.now() + (800 + Math.floor(Math.random() * 300)) * 86400000);
    const stay = {
      property_id: PROPERTY,
      check_in: checkIn.toISOString().slice(0, 10),
      check_out: new Date(checkIn.getTime() + 2 * 86400000).toISOString().slice(0, 10),
      guest_count: 2,
    };

    step(`Step 1: ${RACERS} guests request ${PROPERTY} for ${stay.check_in} to ${stay.check_out} at the same moment`);
    const responses = await Promise.all(guests.map((g) => call('/bookings/request', g, stay)));
    const accepted = responses.filter((r) => r.status === 202);
    check(accepted.length === RACERS, `the API accepted all ${RACERS} requests with 202 PENDING`);
    const ids = new Map(accepted.map((r, i) => [r.body.data.reservation_id, { guest: guests[responses.indexOf(r)], trace: r.traceId }]));

    step('Step 2: the booking worker decides, one transaction per request');
    const decided = await waitFor(async () => Number((await q(`SELECT COUNT(*) n FROM reservations WHERE reservation_id IN (${[...ids.keys()].map(() => '?').join(',')})`, [...ids.keys()]))[0].n) === RACERS, 60, 'the worker to process every request');
    if (!decided) return;
    const rows = await q(`SELECT reservation_id, guest_id, status, cancellation_reason, trace_id FROM reservations WHERE reservation_id IN (${[...ids.keys()].map(() => '?').join(',')}) ORDER BY booking_datetime, guest_id`, [...ids.keys()]);
    console.log('  guest         status     reason         trace_id');
    for (const r of rows) console.log(`  ${r.guest_id.padEnd(13)} ${r.status.padEnd(10)} ${(r.cancellation_reason || '').padEnd(14)} ${r.trace_id}`);
    const winners = rows.filter((r) => r.status === 'REQUESTED');
    const rejected = rows.filter((r) => r.status === 'REJECTED');
    check(winners.length === 1, `exactly one reservation won: ${winners[0]?.guest_id}`);
    check(rejected.length === RACERS - 1 && rejected.every((r) => r.cancellation_reason === 'DATE_CONFLICT'), `the other ${RACERS - 1} were rejected with DATE_CONFLICT`);
    check(rows.every((r) => r.trace_id === ids.get(r.reservation_id).trace), 'every trace_id from the request is on its reservation');

    step('Step 3: the database state');
    const nights = await q('SELECT property_id, night, reservation_id FROM reservation_nights WHERE reservation_id IN (?)', [[...ids.keys()]]);
    console.log('  property_id  night       reservation_id');
    for (const n of nights) console.log(`  ${n.property_id}     ${n.night}  ${n.reservation_id}`);
    check(nights.length === 2 && nights.every((n) => n.reservation_id === winners[0].reservation_id), 'two night rows exist, and both belong to the winner');
    const history = await q('SELECT reservation_id, from_status, to_status, reason FROM reservation_status_history WHERE reservation_id IN (?) ORDER BY id', [[...ids.keys()]]);
    check(history.length === RACERS, 'every request has exactly one history row');
    const doubles = (await q('SELECT COUNT(*) n FROM (SELECT property_id, night FROM reservation_nights GROUP BY property_id, night HAVING COUNT(*) > 1) d'))[0].n;
    check(Number(doubles) === 0, 'no night in the whole table is held twice');

    step('Step 4: the winner cancels, the nights are freed and someone else can book them');
    const winner = ids.get(winners[0].reservation_id);
    const cancel = await call('/bookings/cancel', winner.guest, { reservation_id: winners[0].reservation_id, cancellation_reason: 'Demo: freeing the dates' });
    check(cancel.status === 202, 'the cancel request was accepted');
    await waitFor(async () => (await q('SELECT status FROM reservations WHERE reservation_id = ?', [winners[0].reservation_id]))[0].status === 'CANCELLED', 30, 'the worker to cancel it');
    const left = Number((await q('SELECT COUNT(*) n FROM reservation_nights WHERE reservation_id = ?', [winners[0].reservation_id]))[0].n);
    check(left === 0, 'the nights were released');
    const rejectedGuest = rejected[0].guest_id;
    const retry = await call('/bookings/request', rejectedGuest, stay);
    await waitFor(async () => (await q('SELECT status FROM reservations WHERE reservation_id = ?', [retry.body.data.reservation_id])).length === 1, 30, 'the new request');
    const retryStatus = (await q('SELECT status FROM reservations WHERE reservation_id = ?', [retry.body.data.reservation_id]))[0]?.status;
    check(retryStatus === 'REQUESTED', `${rejectedGuest} asked again and got the nights: ${retryStatus}`);
  } finally {
    await cleanup();
    await db.end();
  }
}

main()
  .then(() => {
    console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
    process.exit(failed ? 1 : 0);
  })
  .catch((err) => {
    console.error(`\nThe demo stopped: ${err.message}`);
    process.exit(1);
  });
