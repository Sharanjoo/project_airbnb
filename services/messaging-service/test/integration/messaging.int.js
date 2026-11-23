// Messaging against the real MongoDB (and MySQL for the directory) from docker compose.
//   npm run infra:up   then   npm run test:db -w services/messaging-service
// Uses the real `airbnb` database so the indexes from infra/mongo/init are the ones
// under test; every document it creates is removed afterwards.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { MongoClient } = require('mongodb');
const {
  createApp, logger, getMysql, newId, createEnvelope, validateEnvelope,
} = require('@airbnb/common');
const { createStore } = require('../../src/models');
const { bookingDedupeKey } = require('../../src/models/messages');
const { buildRouter } = require('../../src/routes');
const { buildHandlers } = require('../../src/worker');

const client = new MongoClient(process.env.MONGO_URL || 'mongodb://localhost:27018');
const getDb = async () => client.db(process.env.MONGO_DB || 'airbnb');
const store = createStore(getDb);
const RUN = Date.now();
const guestIds = [];
const hostIds = [];
const propertyIds = [];
const reservationIds = [];

const sent = [];
const bus = {
  async publish(topic, env, key) {
    const check = validateEnvelope(env, topic);
    if (!check.valid) throw new Error(check.errors.join('; '));
    sent.push({ topic, env, key });
  },
};
const handler = buildHandlers({ bus, store })['booking.requested'];
const onRequested = (env) => handler(env, { topic: 'booking.requested' });

const ids = () => {
  const g = newId('gst'); const h = newId('hst'); const p = newId('prp');
  guestIds.push(g); hostIds.push(h); propertyIds.push(p);
  return { g, h, p };
};
const countDocs = async (name, filter) => (await getDb()).collection(name).countDocuments(filter);

const bookingRequested = ({ g, h, p }, reservationId, guestMessage = 'Hello, can we check in at 3pm?') => {
  reservationIds.push(reservationId);
  return createEnvelope({
    eventType: 'booking.requested',
    traceId: '66666666-6666-4666-8666-666666666666',
    actorId: g,
    actorType: 'guest',
    entityType: 'reservation',
    entityId: reservationId,
    idempotencyKey: newId('k'),
    payload: {
      reservation_id: reservationId, property_id: p, guest_id: g, host_id: h,
      check_in: '2030-03-01', check_out: '2030-03-04', guest_count: 2, guest_message: guestMessage, price_breakdown: {},
    },
  });
};

test.before(() => client.connect());

test.after(async () => {
  const db = await getDb();
  const threads = await db.collection('threads').find({ guest_id: { $in: guestIds } }, { projection: { _id: 1 } }).toArray();
  await db.collection('messages').deleteMany({ thread_id: { $in: threads.map((t) => t._id) } });
  await db.collection('threads').deleteMany({ guest_id: { $in: guestIds } });
  const mysql = getMysql();
  if (reservationIds.length) await mysql.query('DELETE FROM reservations WHERE reservation_id IN (?)', [reservationIds]);
  if (propertyIds.length) await mysql.query('DELETE FROM properties WHERE property_id IN (?)', [propertyIds]);
  if (guestIds.length) await mysql.query('DELETE FROM guests WHERE guest_id IN (?)', [guestIds]);
  if (hostIds.length) await mysql.query('DELETE FROM hosts WHERE host_id IN (?)', [hostIds]);
  await mysql.end();
  await client.close();
});

test('the indexes this service relies on exist (infra/mongo/init/001_init.js)', async () => {
  const db = await getDb();
  const t = await db.collection('threads').indexes();
  assert.ok(t.some((i) => i.unique && JSON.stringify(i.key) === JSON.stringify({ guest_id: 1, host_id: 1, property_id: 1 })), 'unique thread per guest/host/property');
  const m = await db.collection('messages').indexes();
  assert.ok(m.some((i) => i.unique && i.sparse && i.key.client_message_id === 1), 'unique sparse client_message_id');
});

test('openThread: 10 concurrent opens (different reservations) -> one thread with all 10 reservation ids', async () => {
  const { g, h, p } = ids();
  const resIds = Array.from({ length: 10 }, () => newId('res'));
  const results = await Promise.all(resIds.map((r) => store.threads.openThread({ guestId: g, hostId: h, propertyId: p, reservationId: r })));
  assert.strictEqual(results.filter((x) => x.created).length, 1, 'exactly one call created it');
  assert.strictEqual(new Set(results.map((x) => x.thread._id)).size, 1);
  assert.strictEqual(await countDocs('threads', { guest_id: g }), 1);
  const doc = await store.threads.findById(results[0].thread._id);
  assert.deepStrictEqual(doc.reservation_ids.sort(), resIds.sort());
  assert.deepStrictEqual(doc.participants, [g, h]);
});

test('messages.insert: 10 concurrent inserts with one dedupe key -> one document, one created', async () => {
  const { g, h, p } = ids();
  const { thread } = await store.threads.openThread({ guestId: g, hostId: h, propertyId: p });
  const key = bookingDedupeKey(newId('res'));
  const results = await Promise.all(Array.from({ length: 10 }, () => store.messages.insert({ threadId: thread._id, senderId: g, receiverId: h, text: 'once', dedupeKey: key })));
  assert.strictEqual(results.filter((x) => x.created).length, 1);
  assert.strictEqual(new Set(results.map((x) => x.message._id)).size, 1);
  assert.strictEqual(await countDocs('messages', { thread_id: thread._id }), 1);
});

test('listPage: messages with identical timestamps are neither skipped nor repeated across pages', async () => {
  const { g, h, p } = ids();
  const { thread } = await store.threads.openThread({ guestId: g, hostId: h, propertyId: p });
  const same = new Date('2030-05-05T12:00:00Z');
  for (let i = 0; i < 7; i++) await store.messages.insert({ threadId: thread._id, senderId: i % 2 ? h : g, receiverId: i % 2 ? g : h, text: `t${i}`, timestamp: same });
  const seen = [];
  let before = null;
  for (;;) {
    const page = await store.messages.listPage(thread._id, { before, limit: 3 });
    seen.unshift(...page.rows.map((m) => m._id));
    if (!page.hasMore) break;
    before = await store.messages.findById(page.nextBefore);
  }
  assert.strictEqual(seen.length, 7);
  assert.strictEqual(new Set(seen).size, 7);
});

test('booking.requested: 5 concurrent deliveries, then a replay -> exactly one thread, one message, one message.sent', async () => {
  const k = ids();
  const env = bookingRequested(k, newId('res'));
  const before = sent.length;
  const outcomes = await Promise.all(Array.from({ length: 5 }, () => onRequested(env)));
  assert.strictEqual(outcomes.filter((o) => o.endsWith('+message')).length, 1, outcomes.join(','));
  assert.strictEqual(await countDocs('threads', { guest_id: k.g }), 1);
  const [thread] = await (await getDb()).collection('threads').find({ guest_id: k.g }).toArray();
  assert.strictEqual(await countDocs('messages', { thread_id: thread._id }), 1);
  const [msg] = await (await getDb()).collection('messages').find({ thread_id: thread._id }).toArray();
  assert.deepStrictEqual([msg.sender_id, msg.receiver_id, msg.message_text, msg.notified], [k.g, k.h, 'Hello, can we check in at 3pm?', true]);
  assert.strictEqual(thread.last_message.message_id, msg._id);

  // replay (consumer offsets reset to the start of the topic)
  assert.strictEqual(await onRequested(env), 'thread_reused+message_duplicate');
  assert.strictEqual(await countDocs('threads', { guest_id: k.g }), 1);
  assert.strictEqual(await countDocs('messages', { thread_id: thread._id }), 1);
  const published = sent.slice(before).filter((s) => s.env.payload.thread_id === thread._id);
  assert.strictEqual(published.length, 1, 'message.sent once, even though 5 deliveries raced');
});

test('API on real MongoDB + MySQL: host opens by reservation, names from MySQL, outsider locked out, send/list/markRead', async () => {
  const mysql = getMysql();
  const k = ids();
  const outsider = newId('gst');
  guestIds.push(outsider);
  await mysql.execute('INSERT INTO hosts (host_id, name, email, password_hash) VALUES (?, ?, ?, ?)', [k.h, 'Int Host', `${k.h}@msg-${RUN}.example.com`, 'x']);
  for (const [gid, first] of [[k.g, 'Grace'], [outsider, 'Mallory']]) {
    await mysql.execute('INSERT INTO guests (guest_id, first_name, last_name, email, password_hash) VALUES (?, ?, ?, ?, ?)', [gid, first, 'Hopper', `${gid}@msg-${RUN}.example.com`, 'x']);
  }
  await mysql.execute(
    `INSERT INTO properties (property_id, host_id, title, description, property_type, address_line1, city, state, zip, capacity, bedrooms, bathrooms, amenities, nightly_price)
     VALUES (?, ?, 'Messaging test flat', 'x', 'apartment', '1 Test St', 'San Jose', 'CA', '95113', 2, 1, 1, '[]', 100)`,
    [k.p, k.h],
  );
  const resId = newId('res');
  reservationIds.push(resId);
  await mysql.execute(
    `INSERT INTO reservations (reservation_id, property_id, guest_id, host_id, check_in, check_out, guest_count, price_breakdown, total_price, status, trace_id)
     VALUES (?, ?, ?, ?, '2030-04-01', '2030-04-03', 1, '{}', 200, 'REQUESTED', '00000000-0000-4000-8000-000000000000')`,
    [resId, k.p, k.g, k.h],
  );

  const app = createApp({ name: 'msg-int', logger });
  app.use(buildRouter({ bus, store }));
  app.finalize();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, id, role) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Id': id, 'X-User-Role': role }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const opened = await call('/threads/open', { reservation_id: resId }, k.h, 'host');
    assert.strictEqual(opened.status, 201);
    const t = opened.body.data;
    assert.deepStrictEqual(t.counterpart, { user_id: k.g, name: 'Grace H.' });
    assert.strictEqual(t.property_title, 'Messaging test flat');
    assert.strictEqual((await call('/threads/open', { property_id: k.p }, k.g, 'guest')).body.data.thread_id, t.thread_id);
    assert.strictEqual((await call('/threads/open', { reservation_id: resId }, outsider, 'guest')).status, 404);

    const s = await call('/messages/send', { thread_id: t.thread_id, message_text: 'Door code is 4821 zebra', client_message_id: 'int-1' }, k.h, 'host');
    assert.strictEqual(s.status, 201);
    assert.strictEqual((await call('/messages/send', { thread_id: t.thread_id, message_text: 'Door code is 4821 zebra', client_message_id: 'int-1' }, k.h, 'host')).status, 200);
    assert.strictEqual(await countDocs('messages', { thread_id: t.thread_id }), 1);

    // A client retrying 6 times at once (flaky network): one message, one message.sent
    const sentBefore = sent.length;
    const burst = await Promise.all(Array.from({ length: 6 }, () => call('/messages/send', { thread_id: t.thread_id, message_text: 'On my way', client_message_id: 'int-2' }, k.g, 'guest')));
    assert.deepStrictEqual(burst.map((b) => b.status).sort(), [200, 200, 200, 200, 200, 201]);
    assert.strictEqual(await countDocs('messages', { thread_id: t.thread_id }), 2);
    assert.strictEqual(sent.length - sentBefore, 1, 'announced once');

    for (const path of ['/threads/get', '/messages/list', '/messages/markRead']) {
      const r = await call(path, { thread_id: t.thread_id }, outsider, 'guest');
      assert.strictEqual(r.status, 404, path);
      assert.ok(!JSON.stringify(r.body).includes('zebra'), `${path} leaks nothing`);
    }
    assert.strictEqual((await call('/messages/send', { thread_id: t.thread_id, message_text: 'hi' }, outsider, 'guest')).status, 404);
    assert.strictEqual((await call('/threads/byUser', {}, outsider, 'guest')).body.data.total, 0);

    const inbox = (await call('/threads/byUser', {}, k.g, 'guest')).body.data;
    assert.deepStrictEqual([inbox.total, inbox.items[0].unread_count, inbox.items[0].last_message.preview], [1, 1, 'On my way']);
    const list = (await call('/messages/list', { thread_id: t.thread_id }, k.g, 'guest')).body.data;
    assert.deepStrictEqual(list.items.map((m) => m.message_text), ['Door code is 4821 zebra', 'On my way']);
    const read = (await call('/messages/markRead', { thread_id: t.thread_id }, k.g, 'guest')).body.data;
    assert.deepStrictEqual([read.marked_read, read.unread_count], [1, 0]);
    const after = (await call('/messages/list', { thread_id: t.thread_id }, k.h, 'host')).body.data.items;
    assert.ok(after[0].read_at, 'the host sees the guest read it');
    assert.strictEqual(after[1].read_at, null, "the guest's own message is not marked by the guest reading");
  } finally {
    server.close();
  }
});
