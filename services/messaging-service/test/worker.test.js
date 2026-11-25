process.env.NODE_ENV = 'test';
// booking.requested -> thread + first message, with fakes. Real MongoDB, concurrency and
// replays are covered in test/integration/messaging.int.js.
const test = require('node:test');
const assert = require('node:assert');
const { createEnvelope, processMessage } = require('@airbnb/common');
const { buildHandlers, GROUP } = require('../src/worker');
const { fakeStore, fakeBus } = require('./fakes');

// Same payload booking-service publishes (main and slice3/booking-reads)
const requested = (over = {}, { idempotencyKey = 'idem-1', timestamp } = {}) => {
  const env = createEnvelope({
    eventType: 'booking.requested',
    traceId: '55555555-5555-4555-8555-555555555555',
    actorId: 'gst_1',
    actorType: 'guest',
    entityType: 'reservation',
    entityId: over.reservation_id || 'res_a',
    idempotencyKey,
    payload: {
      reservation_id: 'res_a', property_id: 'prp_1', guest_id: 'gst_1', host_id: 'hst_1',
      check_in: '2030-02-01', check_out: '2030-02-03', guest_count: 2, guest_message: 'Hi! Arriving late, around 10pm.',
      price_breakdown: { nights: 2, nightly_price: 100, cleaning_fee: 20, service_fee: 28, total: 248 },
      ...over,
    },
  });
  if (timestamp) env.timestamp = timestamp;
  return env;
};

const setup = () => {
  const store = fakeStore();
  const bus = fakeBus();
  const h = buildHandlers({ bus, store })['booking.requested'];
  return { store, bus, h: (env) => h(env, { topic: 'booking.requested', partition: 0, offset: '0', attempt: 0 }) };
};

test('booking.requested: creates the thread and the guest message to the host, publishes message.sent once', async () => {
  const { store, bus, h } = setup();
  const env = requested({}, { timestamp: '2030-01-15T10:00:00.000Z' });
  assert.strictEqual(await h(env), 'thread_created+message');
  const [t] = store.threads._all.values();
  assert.deepStrictEqual([t.guest_id, t.host_id, t.property_id, t.reservation_ids], ['gst_1', 'hst_1', 'prp_1', ['res_a']]);
  const [m] = store.messages._all.values();
  assert.deepStrictEqual(
    [m.thread_id, m.sender_id, m.receiver_id, m.message_text, m.reservation_id, m.client_message_id, m.timestamp.toISOString()],
    [t._id, 'gst_1', 'hst_1', 'Hi! Arriving late, around 10pm.', 'res_a', 'booking:res_a', '2030-01-15T10:00:00.000Z'],
  );
  assert.strictEqual(t.last_message.message_id, m._id);
  assert.strictEqual(bus.sent.length, 1);
  assert.strictEqual(bus.sent[0].env.trace_id, env.trace_id, 'trace continues from the booking request');
  assert.ok(!JSON.stringify(bus.sent[0].env).includes('Arriving late'));
});

test('booking.requested: redelivered 3 times -> still one thread, one message, one message.sent', async () => {
  const { store, bus, h } = setup();
  const env = requested();
  await h(env);
  for (let i = 0; i < 3; i++) assert.strictEqual(await h(env), 'thread_reused+message_duplicate');
  assert.strictEqual(store.threads._all.size, 1);
  assert.strictEqual(store.messages._all.size, 1);
  assert.strictEqual(bus.sent.length, 1);
});

test('booking.requested: a second booking for the same listing reuses the thread and adds its message', async () => {
  const { store, h } = setup();
  await h(requested());
  assert.strictEqual(await h(requested({ reservation_id: 'res_b', guest_message: 'Also next month?' }, { idempotencyKey: 'idem-2' })), 'thread_reused+message');
  const [t] = store.threads._all.values();
  assert.deepStrictEqual(t.reservation_ids, ['res_a', 'res_b']);
  assert.strictEqual(store.messages._all.size, 2);
  // a different listing of the same host is a different conversation
  await h(requested({ reservation_id: 'res_c', property_id: 'prp_2' }, { idempotencyKey: 'idem-3' }));
  assert.strictEqual(store.threads._all.size, 2);
});

test('booking.requested: no guest_message (null, empty or spaces) -> thread only, nothing published', async () => {
  for (const guestMessage of [null, '', '   ']) {
    const { store, bus, h } = setup();
    assert.strictEqual(await h(requested({ guest_message: guestMessage })), 'thread_created');
    assert.strictEqual(store.threads._all.size, 1);
    assert.strictEqual(store.messages._all.size, 0);
    assert.strictEqual(bus.sent.length, 0);
  }
});

test('booking.requested: Kafka down while announcing -> handler throws; the retry publishes, no duplicate message', async () => {
  const { store, bus, h } = setup();
  const env = requested();
  bus.down = true;
  await assert.rejects(h(env), /Kafka unavailable/);
  assert.strictEqual(store.messages._all.size, 1);
  bus.down = false;
  assert.strictEqual(await h(env), 'thread_reused+message_duplicate');
  assert.strictEqual(bus.sent.length, 1);
  assert.strictEqual(store.messages._all.size, 1);
});

test('booking.requested: missing ids -> permanent error -> DLQ on the first attempt, nothing written', async () => {
  for (const field of ['reservation_id', 'guest_id', 'host_id', 'property_id']) {
    const { store, bus } = setup();
    const env = requested();
    delete env.payload[field];
    const handlers = buildHandlers({ bus, store });
    const dlq = [];
    const attempts = [];
    const result = await processMessage({
      topic: 'booking.requested', partition: 0, groupId: GROUP, maxRetries: 3, baseDelayMs: 1,
      message: { key: Buffer.from('prp_1'), value: Buffer.from(JSON.stringify(env)), offset: '1' },
      handler: (e, m) => { attempts.push(m.attempt); return handlers['booking.requested'](e, m); },
      sendToDlq: async (rec) => { dlq.push(rec); },
    });
    assert.strictEqual(result, 'dlq', field);
    assert.deepStrictEqual(attempts, [0]);
    assert.match(dlq[0].headers.failure_reason, new RegExp(`missing ${field}`));
    assert.strictEqual(store.threads._all.size, 0);
  }
});

test('worker subscribes to booking.requested only, in group messaging-cg', () => {
  assert.deepStrictEqual(Object.keys(buildHandlers({ bus: fakeBus(), store: fakeStore() })), ['booking.requested']);
  assert.strictEqual(GROUP, 'messaging-cg');
});
