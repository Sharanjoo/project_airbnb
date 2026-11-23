// Fast end-to-end check of Slice 1 messaging through the gateway and Kafka.
//   npm run infra:up, then run gateway, user, property, booking, booking-worker,
//   messaging, messaging-worker and (optional, for the live push) notify:
//   npm run smoke:messaging
//
// 1. A new guest requests a booking with a note: exactly one thread and one message appear.
// 2. The very same booking.requested record is delivered again: counts do not change.
// 3. A third user cannot open, read, post to or mark the conversation.
// 4. The host replies; the guest reads it; the live push carries ids only.
const { randomUUID } = require('crypto');
const { MongoClient } = require('mongodb');
const WebSocket = require('ws');
const { createKafka } = require('@airbnb/common');

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const NOTIFY = process.env.NOTIFY_URL || 'ws://localhost:8009';
const HEALTH = {
  gateway: `${GATEWAY}/health`,
  user: `http://localhost:${process.env.USER_SERVICE_PORT || 8001}/health`,
  property: `http://localhost:${process.env.PROPERTY_SERVICE_PORT || 8002}/health`,
  booking: `http://localhost:${process.env.BOOKING_SERVICE_PORT || 8003}/health`,
  messaging: `http://localhost:${process.env.MESSAGING_SERVICE_PORT || 8004}/health`,
};
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS || 60000);

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); process.exitCode = 1; };
const skip = (m) => console.log(`  skip  ${m}`);
const check = (cond, msg, detail) => (cond ? ok(msg) : bad(detail ? `${msg}: ${detail}` : msg));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 15000, every = 300) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return last;
    await sleep(every);
  }
  return null;
}

async function health(url, deadline) {
  let last = 'not checked';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return null;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.cause?.code || e.message;
    }
    await sleep(1000);
  }
  return last;
}

async function call(service, path, body, { token, headers = {} } = {}) {
  const res = await fetch(`${GATEWAY}/api/v1/${service}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const describe = (r) => `${r.status} ${JSON.stringify(r.body?.error || r.body?.data || r.body)}`;

async function signUp(kind, run, password) {
  const email = `smoke-msg-${kind}-${run}@example.com`;
  const body = kind === 'host'
    ? { name: 'Msg Host', email, password }
    : { first_name: kind === 'guest' ? 'Mia' : 'Otto', last_name: 'Smoke', email, password };
  const created = await call('user', kind === 'host' ? '/hosts/create' : '/guests/create', body);
  if (created.status !== 201) throw new Error(`${kind} sign-up failed: ${describe(created)}`);
  const login = await call('user', '/auth/login', { email, password, role: kind === 'host' ? 'host' : 'guest' });
  if (login.status !== 200) throw new Error(`${kind} login failed: ${describe(login)}`);
  return login.body.data; // { token, user_id, role }
}

/** Committed offsets of messaging-cg have caught up with the end of booking.requested. */
async function messagingLag(admin) {
  const [end, committed] = await Promise.all([
    admin.fetchTopicOffsets('booking.requested'),
    admin.fetchOffsets({ groupId: 'messaging-cg', topics: ['booking.requested'] }),
  ]);
  const done = Object.fromEntries(committed[0].partitions.map((p) => [p.partition, Number(p.offset)]));
  return end.reduce((sum, p) => sum + Math.max(0, Number(p.high) - Math.max(done[p.partition] ?? 0, 0)), 0);
}

/** The booking.requested record for this reservation, exactly as booking-service published it. */
async function findRequestRecord(kafka, reservationId) {
  const consumer = kafka.consumer({ groupId: `smoke-msg-reader-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic: 'booking.requested', fromBeginning: true });
  let found = null;
  const done = new Promise((resolve) => {
    consumer.run({
      eachMessage: async ({ message }) => {
        if (found) return;
        try {
          if (JSON.parse(message.value.toString()).payload?.reservation_id === reservationId) {
            found = { key: message.key, value: message.value, headers: message.headers };
            resolve();
          }
        } catch { /* not ours */ }
      },
    });
  });
  await Promise.race([done, sleep(20000)]);
  await consumer.disconnect();
  return found;
}

/** Open a notification-gateway socket and collect frames. Resolves null if the gateway is not running. */
function listen(token, subscribe = []) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${NOTIFY}/ws?token=${encodeURIComponent(token)}`);
    const frames = [];
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw)); } catch { /* ignore */ } });
    ws.on('open', () => { ws.send(JSON.stringify({ subscribe })); setTimeout(() => resolve({ ws, frames }), 200); });
    ws.on('error', () => resolve(null));
  });
}

async function main() {
  console.log('Health checks');
  const deadline = Date.now() + WAIT_MS;
  for (const [name, url] of Object.entries(HEALTH)) {
    const problem = await health(url, deadline);
    check(!problem, `${name} ${url}`, problem);
  }
  if (process.exitCode) return;

  const run = Date.now();
  const password = `Smoke-${randomUUID().slice(0, 8)}`;
  const [host, guest, outsider] = [await signUp('host', run, password), await signUp('guest', run, password), await signUp('outsider', run, password)];
  ok(`signed up host ${host.user_id}, guest ${guest.user_id}, third user ${outsider.user_id}`);

  const listing = await call('property', '/properties/create', {
    title: 'Messaging smoke studio', description: 'Created by scripts/smoke-messaging.js', property_type: 'apartment',
    address: { line1: '2 Smoke St', city: 'San Jose', state: 'CA', zip: '95113' },
    capacity: 2, bedrooms: 1, bathrooms: 1, amenities: ['wifi'], nightly_price: 90, cleaning_fee: 10,
  }, { token: host.token });
  const propertyId = listing.body?.data?.property_id;
  if (!propertyId) return bad(`listing: ${describe(listing)}`);

  const mongo = new MongoClient(process.env.MONGO_URL || 'mongodb://localhost:27018');
  await mongo.connect();
  const db = mongo.db(process.env.MONGO_DB || 'airbnb');
  const kafka = createKafka('smoke-messaging');
  const admin = kafka.admin();
  await admin.connect();
  const producer = kafka.producer();
  await producer.connect();
  const sockets = [];

  try {
    // ---- 1. booking -> exactly one thread and one first message
    console.log('\nBooking request opens the conversation');
    const note = `Hi! Arriving around 9pm (${run})`;
    const start = new Date(Date.now() + (30 + Math.floor(Math.random() * 300)) * 86400000);
    const booking = await call('booking', '/bookings/request', {
      property_id: propertyId, check_in: start.toISOString().slice(0, 10),
      check_out: new Date(start.getTime() + 2 * 86400000).toISOString().slice(0, 10), guest_count: 2, guest_message: note,
    }, { token: guest.token, headers: { 'Idempotency-Key': randomUUID() } });
    const reservationId = booking.body?.data?.reservation_id;
    check(booking.status === 202 && reservationId, `guest requested booking ${reservationId} with a note`, describe(booking));
    if (!reservationId) return;

    const thread = await waitFor(async () => {
      const r = await call('messaging', '/threads/byUser', {}, { token: guest.token });
      const t = r.body?.data?.items?.find((x) => x.property_id === propertyId);
      return t?.last_message ? t : null;
    });
    check(thread, 'messaging-worker opened the thread', 'no thread within 15 s (is messaging-worker running?)');
    if (!thread) return;
    const counts = async () => ({
      threads: await db.collection('threads').countDocuments({ guest_id: guest.user_id, host_id: host.user_id, property_id: propertyId }),
      messages: await db.collection('messages').countDocuments({ thread_id: thread.thread_id }),
    });
    const first = await counts();
    check(first.threads === 1 && first.messages === 1, 'exactly one thread and one message in MongoDB', JSON.stringify(first));
    check(thread.reservation_ids.includes(reservationId), 'thread is linked to the reservation');
    const hostView = (await call('messaging', '/threads/byUser', {}, { token: host.token })).body?.data?.items?.find((x) => x.thread_id === thread.thread_id);
    check(hostView?.unread_count === 1 && hostView.counterpart.name === 'Mia S.', 'host sees the same thread, 1 unread, from "Mia S."', JSON.stringify(hostView));
    const history = (await call('messaging', '/messages/list', { thread_id: thread.thread_id }, { token: host.token })).body?.data?.items || [];
    check(history.length === 1 && history[0].message_text === note && history[0].sender_id === guest.user_id, "the first message is the guest's booking note", JSON.stringify(history));

    // ---- 2. redeliver the identical Kafka record
    console.log('\nThe same booking.requested delivered again');
    const record = await findRequestRecord(kafka, reservationId);
    check(record, 'found the original booking.requested record in Kafka');
    if (record) {
      await producer.send({ topic: 'booking.requested', messages: [record] });
      const caughtUp = await waitFor(async () => (await messagingLag(admin)) === 0 && Date.now(), 20000, 500);
      check(caughtUp, 'messaging-worker consumed the redelivered record (lag 0)');
      await sleep(500);
      const second = await counts();
      check(second.threads === 1 && second.messages === 1, 'still one thread and one message after the redelivery', JSON.stringify(second));
      // booking-worker reads the copy too; its own claim makes it a no-op (slice 3 guarantee)
    }

    // ---- 3. a third user is locked out
    console.log('\nA third user cannot get in');
    const tid = { thread_id: thread.thread_id };
    for (const [path, body] of [['/threads/get', tid], ['/messages/list', tid], ['/messages/markRead', tid],
      ['/messages/send', { ...tid, message_text: 'let me in' }], ['/threads/open', { reservation_id: reservationId }]]) {
      const r = await call('messaging', path, body, { token: outsider.token });
      check(r.status === 404 && !JSON.stringify(r.body).includes(String(run)), `${path} -> 404, nothing leaked`, describe(r));
    }
    const theirs = await call('messaging', '/threads/byUser', {}, { token: outsider.token });
    check(theirs.body?.data?.total === 0, "the third user's inbox is empty", describe(theirs));
    check((await counts()).messages === 1, 'nothing was posted by the third user');

    // ---- 4. reply, read status, live push
    console.log('\nReply, read status and live push');
    const guestSocket = await listen(guest.token);
    // The gateway does not yet stop anyone joining another user's channel (see the PR notes); prove the frame has no text anyway
    const snooper = await listen(outsider.token, [`user:${guest.user_id}`, `property:${propertyId}`]);
    sockets.push(guestSocket, snooper);
    const reply = `Late arrival is fine, the lockbox code comes the day before (${run})`;
    const sent = await call('messaging', '/messages/send', { ...tid, message_text: reply, client_message_id: randomUUID() }, { token: host.token });
    check(sent.status === 201, 'host replied', describe(sent));
    if (guestSocket) {
      const frame = await waitFor(async () => guestSocket.frames.find((f) => f.type === 'message.sent' && f.payload?.message_id === sent.body?.data?.message_id), 10000, 100);
      check(frame, 'guest got a live message.sent push');
      check(frame && !JSON.stringify(frame).includes('lockbox'), 'the push carries ids only, no message text', JSON.stringify(frame));
      await sleep(500); // the same push reaches the other socket a moment later
      const leaked = snooper.frames.filter((f) => f.type === 'message.sent');
      check(leaked.every((f) => !JSON.stringify(f).includes('lockbox')), `a third user who joined the guest's channel sees no message text (got ${leaked.length} frame(s), ids only)`);
    } else {
      skip(`live push: notification gateway not reachable at ${NOTIFY}`);
    }
    const read = await call('messaging', '/messages/markRead', tid, { token: guest.token });
    check(read.status === 200 && read.body.data.marked_read === 1 && read.body.data.unread_count === 0, 'guest marked the reply read', describe(read));
    const seen = (await call('messaging', '/messages/list', tid, { token: host.token })).body?.data?.items || [];
    check(seen.length === 2 && seen[1].read_at, 'host sees 2 messages, the reply marked read');
  } finally {
    for (const s of sockets) s?.ws.close();
    await producer.disconnect();
    await admin.disconnect();
    await mongo.close();
    // keep the smoke listing out of demo searches
    const current = await call('property', '/properties/get', { property_id: propertyId }, { token: host.token });
    await call('property', '/properties/update', { property_id: propertyId, version: current.body?.data?.version, status: 'inactive' }, { token: host.token });
  }
}

main().catch((e) => bad(e.stack || e.message));
