process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { createEnvelope } = require('../src/envelope');
const { processMessage, PermanentError } = require('../src/kafka');

const msg = (obj) => ({ key: Buffer.from('k'), value: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), offset: '7' });
const goodEnv = () =>
  createEnvelope({
    eventType: 'booking.requested', traceId: randomUUID(), actorId: 'gst_0001', actorType: 'guest',
    entityType: 'reservation', entityId: 'res_1', payload: {},
  });

function harness(handler, opts = {}) {
  const dlq = [];
  const run = (message) =>
    processMessage({
      topic: 'booking.requested', partition: 0, message, handler, groupId: 'test-cg',
      sendToDlq: async (r) => dlq.push(r), baseDelayMs: 1, ...opts,
    });
  return { dlq, run };
}

test('malformed JSON goes to DLQ without calling the handler', async () => {
  let called = false;
  const { dlq, run } = harness(async () => { called = true; });
  assert.strictEqual(await run(msg('{not json')), 'dlq');
  assert.strictEqual(called, false);
  assert.strictEqual(dlq[0].headers.failure_reason, 'malformed JSON');
});

test('invalid envelope goes to DLQ with reason and source offset', async () => {
  const env = goodEnv();
  delete env.idempotency_key;
  const { dlq, run } = harness(async () => {});
  assert.strictEqual(await run(msg(env)), 'dlq');
  assert.match(dlq[0].headers.failure_reason, /invalid envelope/);
  assert.strictEqual(dlq[0].headers.source_offset, '7');
});

test('transient failure is retried then succeeds', async () => {
  let calls = 0;
  const { dlq, run } = harness(async () => { if (++calls < 3) throw new Error('deadlock'); });
  assert.strictEqual(await run(msg(goodEnv())), 'ok');
  assert.strictEqual(calls, 3);
  assert.strictEqual(dlq.length, 0);
});

test('retries are bounded, then DLQ', async () => {
  let calls = 0;
  const { dlq, run } = harness(async () => { calls++; throw new Error('db down'); }, { maxRetries: 2 });
  assert.strictEqual(await run(msg(goodEnv())), 'dlq');
  assert.strictEqual(calls, 3); // first try + 2 retries
  assert.strictEqual(dlq.length, 1);
});

test('permanent error skips retries', async () => {
  let calls = 0;
  const { dlq, run } = harness(async () => { calls++; throw new PermanentError('bad payload'); });
  assert.strictEqual(await run(msg(goodEnv())), 'dlq');
  assert.strictEqual(calls, 1);
  assert.strictEqual(dlq.length, 1);
});
