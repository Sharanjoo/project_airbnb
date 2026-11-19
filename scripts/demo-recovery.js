// Demo for feature 13.2: Kafka failure and recovery in the booking worker.
//
// Needs the stack running: docker compose up -d --build
// Run it with: npm run demo:recovery
//
// What it shows, step by step:
//   1. The booking worker is stopped after the system is up.
//   2. A guest requests a booking. The API accepts it (202) and Kafka keeps the event,
//      but nothing is written to MySQL because no consumer is running.
//   3. The worker is started again. It picks the event up and writes exactly one reservation.
//   4. The consumer offsets are moved back and the worker restarted, so the same event is
//      delivered again. This is what happens when a worker dies after its database write
//      but before it commits the offset. The event is skipped and nothing is duplicated.
//   5. A second event with the same idempotency key is sent. It is skipped too.
//   6. A malformed message and an invalid envelope are sent. Both go to the dead-letter
//      topic and the worker keeps working.
// Everything it prints (offsets, lag, database counts, worker log lines) is real output
// from the running system, so it can be pasted into the report as evidence.
const { execSync } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const { Kafka, logLevel } = require('kafkajs');

const ROOT = path.join(__dirname, '..');
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-dev-secret';
const BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9094').split(',');
const GROUP = 'booking-worker-cg';
const TOPIC = 'booking.requested';
const DLQ = 'booking.requested.dlq';

// kafkajs triggers a harmless timer warning on newer Node versions. It would only clutter the demo output.
process.removeAllListeners('warning');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Runs a shell command. If it fails, the error carries the command's own output so the cause is visible.
function sh(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    throw new Error(`${cmd}\n${String(err.stdout || '').trim()}\n${String(err.stderr || '').trim()}`.trim().slice(0, 1500));
  }
}
const compose = (args) => sh(`docker compose ${args}`);
const kafkaBin = (tool, args) => compose(`exec -T kafka /opt/kafka/bin/${tool} --bootstrap-server localhost:9092 ${args}`);

let failed = 0;
const say = (text) => console.log(text);
const step = (text) => console.log(`\n${text}`);
const ok = (text) => console.log(`  ok    ${text}`);
const bad = (text) => { console.log(`  FAIL  ${text}`); failed++; };
const check = (condition, text) => (condition ? ok(text) : bad(text));

/** Kafka only lets you move a group's offsets once the group has no members. */
const groupIsInactive = () => /\b(Empty|Dead)\b/.test(kafkaBin('kafka-consumer-groups.sh', `--describe --group ${GROUP} --state`));

/**
 * The consumer group's position on our topic, read from Kafka. Each partition has the committed
 * offset (what the group has finished), the log end offset (what Kafka holds) and the lag between them.
 */
function groupOffsets() {
  const out = kafkaBin('kafka-consumer-groups.sh', `--describe --group ${GROUP}`);
  const partitions = out.split('\n')
    .filter((l) => l.startsWith(GROUP) && l.split(/\s+/)[1] === TOPIC)
    .map((l) => {
      const c = l.split(/\s+/);
      return { partition: Number(c[2]), current: c[3] === '-' ? null : Number(c[3]), end: Number(c[4]), lag: c[5] === '-' ? 0 : Number(c[5]), text: c.slice(1, 6).join('  ') };
    });
  const lag = partitions.reduce((sum, p) => sum + p.lag, 0);
  // only partitions that hold messages are interesting, the empty ones are just noise
  const shown = partitions.filter((p) => p.end > 0).map((p) => p.text);
  return { lag, shown, partitions };
}

function printOffsets(title) {
  const { lag, shown } = groupOffsets();
  say(`  ${title}: lag ${lag}`);
  say('    topic  partition  current-offset  log-end-offset  lag');
  for (const l of shown) say(`    ${l}`);
  return lag;
}

const dlqSize = () => kafkaBin('kafka-get-offsets.sh', `--topic ${DLQ}`).trim().split('\n')
  .reduce((sum, l) => sum + Number(l.split(':')[2] || 0), 0);

function workerLines(since, reservationId) {
  const logs = compose(`logs --no-log-prefix --since ${since} booking-worker`);
  return logs.split('\n').filter((l) => l.includes(reservationId));
}

async function waitFor(fn, seconds, what) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(500);
  }
  bad(`timed out waiting for ${what}`);
  return false;
}

async function main() {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3307),
    user: 'airbnb', password: 'airbnb', database: 'airbnb',
  });
  const one = async (sql, params) => Number((await db.execute(sql, params))[0][0].n);
  const counts = async (id) => ({
    reservations: await one('SELECT COUNT(*) n FROM reservations WHERE reservation_id = ?', [id]),
    nights: await one('SELECT COUNT(*) n FROM reservation_nights WHERE reservation_id = ?', [id]),
    history: await one('SELECT COUNT(*) n FROM reservation_status_history WHERE reservation_id = ?', [id]),
    processed: await one("SELECT COUNT(*) n FROM processed_events WHERE consumer_group = ? AND idempotency_key = ?", [GROUP, idemKey]),
  });
  const printCounts = (c) => say(`  database: ${c.reservations} reservation, ${c.nights} nights, ${c.history} history row, ${c.processed} processed_events row`);

  const token = jwt.sign({ sub: 'gst_0001', role: 'guest' }, JWT_SECRET, { expiresIn: '15m' });
  const traceId = randomUUID();
  const idemKey = randomUUID();
  const checkIn = new Date(Date.now() + (700 + Math.floor(Math.random() * 300)) * 86400000);
  const stay = {
    property_id: 'prp_0001',
    check_in: checkIn.toISOString().slice(0, 10),
    check_out: new Date(checkIn.getTime() + 2 * 86400000).toISOString().slice(0, 10),
    guest_count: 2,
  };
  let reservationId = null;

  const kafka = new Kafka({ clientId: 'demo-recovery', brokers: BROKERS, logLevel: logLevel.NOTHING });
  const producer = kafka.producer();
  await producer.connect();

  try {
    step('Step 0: check the system is running');
    const health = await fetch(`${GATEWAY}/health`).then((r) => r.ok).catch(() => false);
    check(health, 'gateway answers on 8080');
    const running = compose('ps --status running --services').split('\n');
    check(running.includes('booking-worker'), 'booking-worker is running');
    check(running.includes('kafka') && running.includes('mysql'), 'kafka and mysql are running');
    if (failed) return;

    step('Step 1: stop the booking worker');
    compose('stop booking-worker');
    check(!compose('ps --status running --services').split('\n').includes('booking-worker'), 'booking-worker is stopped');
    printOffsets('consumer group before the request');

    step('Step 2: a guest requests a booking while the worker is down');
    const res = await fetch(`${GATEWAY}/api/v1/booking/bookings/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': idemKey, 'X-Trace-Id': traceId },
      body: JSON.stringify(stay),
    });
    const body = await res.json();
    check(res.status === 202 && body.data.status === 'PENDING', `the API accepted it: 202 PENDING, ${body.data?.reservation_id}`);
    reservationId = body.data.reservation_id;
    say(`  trace_id ${traceId}`);
    await sleep(4000);
    let c = await counts(reservationId);
    printCounts(c);
    check(c.reservations === 0, 'nothing is in MySQL yet because no consumer is running');
    const lagWhileDown = printOffsets('consumer group while the worker is down');
    check(lagWhileDown >= 1, 'Kafka is holding the event: the consumer group has lag');
    const pending = await fetch(`${GATEWAY}/api/v1/booking/bookings/get`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ reservation_id: reservationId }),
    }).then((r) => r.json());
    check(pending.data?.status === 'PENDING', 'the guest can still see the booking as PENDING');

    step('Step 3: start the worker again');
    const restartedAt = Date.now();
    compose('start booking-worker');
    const written = await waitFor(async () => (await counts(reservationId)).reservations === 1, 90, 'the worker to write the reservation');
    if (written) ok(`the worker caught up and wrote the reservation ${Math.round((Date.now() - restartedAt) / 1000)} s after starting`);
    c = await counts(reservationId);
    printCounts(c);
    check(c.reservations === 1 && c.nights === 2 && c.history === 1 && c.processed === 1, 'exactly one reservation, two nights, one history row, one processed_events row');
    const status = (await db.execute('SELECT status FROM reservations WHERE reservation_id = ?', [reservationId]))[0][0]?.status;
    check(status === 'REQUESTED', `status is ${status}`);
    await waitFor(() => groupOffsets().lag === 0, 30, 'the offset to be committed');
    check(printOffsets('consumer group after recovery') === 0, 'lag is 0, so the offset was committed after the database write');

    step('Step 4: the same event is delivered again (a crash after the database write, before the offset commit)');
    compose('stop booking-worker');
    await waitFor(groupIsInactive, 90, 'Kafka to notice the worker has left the group');
    say('  the consumer group is now empty, moving its offset back by one message');
    // Only partitions the group has committed on can be moved back. Each goes back to just before its last message.
    const committed = groupOffsets().partitions.filter((p) => p.current !== null && p.current > 0);
    check(committed.length > 0, 'the group has committed offsets to move back');
    for (const p of committed) {
      const reset = kafkaBin('kafka-consumer-groups.sh', `--group ${GROUP} --topic ${TOPIC}:${p.partition} --reset-offsets --to-offset ${p.current - 1} --execute`);
      for (const l of reset.split('\n').filter((x) => x.startsWith(GROUP))) say(`    ${l.trim().replace(/\s+/g, '  ')}`);
    }
    printOffsets('consumer group after moving the offset back');
    const replayStart = new Date().toISOString();
    compose('start booking-worker');
    await waitFor(() => groupOffsets().lag === 0, 90, 'the worker to consume the replayed event');
    await sleep(1500);
    const dupLines = workerLines(replayStart, reservationId).filter((l) => l.includes('"outcome":"duplicate"'));
    check(dupLines.length >= 1, 'the worker log shows the event was seen again and skipped as a duplicate');
    if (dupLines[0]) say(`    ${dupLines[0].slice(0, 200)}`);
    c = await counts(reservationId);
    printCounts(c);
    check(c.reservations === 1 && c.nights === 2 && c.history === 1 && c.processed === 1, 'nothing was duplicated');

    step('Step 5: a second event with the same idempotency key (a retry from the client side)');
    const row = (await db.execute('SELECT * FROM reservations WHERE reservation_id = ?', [reservationId]))[0][0];
    const payload = {
      reservation_id: reservationId, property_id: row.property_id, guest_id: row.guest_id, host_id: row.host_id,
      check_in: row.check_in, check_out: row.check_out, guest_count: row.guest_count, guest_message: null,
      price_breakdown: typeof row.price_breakdown === 'string' ? JSON.parse(row.price_breakdown) : row.price_breakdown,
    };
    const second = {
      event_id: randomUUID(), event_type: TOPIC, schema_version: 1, trace_id: traceId, timestamp: new Date().toISOString(),
      actor_id: 'gst_0001', actor_type: 'guest', entity: { entity_type: 'reservation', entity_id: reservationId },
      payload, idempotency_key: idemKey,
    };
    const secondAt = new Date().toISOString();
    await producer.send({ topic: TOPIC, messages: [{ key: row.property_id, value: JSON.stringify(second) }] });
    await waitFor(() => workerLines(secondAt, reservationId).some((l) => l.includes('"outcome":"duplicate"')), 30, 'the worker to skip it');
    c = await counts(reservationId);
    printCounts(c);
    check(c.reservations === 1 && c.history === 1 && c.processed === 1, 'the new event_id changed nothing, the idempotency key stopped it');

    step('Step 6: bad messages go to the dead-letter topic');
    const dlqBefore = dlqSize();
    await producer.send({ topic: TOPIC, messages: [{ key: 'prp_0001', value: 'this is not json {' }] });
    const noKey = { ...second, event_id: randomUUID() };
    delete noKey.idempotency_key;
    await producer.send({ topic: TOPIC, messages: [{ key: 'prp_0001', value: JSON.stringify(noKey) }] });
    await waitFor(() => dlqSize() >= dlqBefore + 2, 30, 'both bad messages to reach the dead-letter topic');
    check(dlqSize() === dlqBefore + 2, `${DLQ} grew by 2 (malformed JSON, and an envelope missing idempotency_key): ${dlqBefore} to ${dlqSize()}`);
    const afterBad = (await fetch(`${GATEWAY}/api/v1/booking/bookings/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ ...stay, check_in: new Date(checkIn.getTime() + 10 * 86400000).toISOString().slice(0, 10), check_out: new Date(checkIn.getTime() + 12 * 86400000).toISOString().slice(0, 10) }),
    }).then((r) => r.json())).data?.reservation_id;
    check(await waitFor(async () => (await one('SELECT COUNT(*) n FROM reservations WHERE reservation_id = ?', [afterBad])) === 1, 30, 'the next booking'), 'the worker kept working: a booking after the bad messages was processed');
    if (afterBad) {
      await db.execute('DELETE FROM reservation_status_history WHERE reservation_id = ?', [afterBad]);
      await db.execute('DELETE FROM reservations WHERE reservation_id = ?', [afterBad]);
    }
  } finally {
    // leave the system the way we found it: worker running, demo data removed
    try { compose('start booking-worker'); } catch { /* already running */ }
    if (reservationId && !process.env.KEEP_DEMO_DATA) {
      await db.execute('DELETE FROM reservation_status_history WHERE reservation_id = ?', [reservationId]);
      await db.execute('DELETE FROM reservations WHERE reservation_id = ?', [reservationId]);
    }
    await producer.disconnect();
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
    try { compose('start booking-worker'); } catch { /* ignore */ }
    process.exit(1);
  });
