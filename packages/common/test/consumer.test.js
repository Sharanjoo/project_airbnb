process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { createEnvelope } = require('../src/envelope');
const { processMessage, PermanentError, traceStepsEnabled } = require('../src/kafka');

const msg = (obj) => ({ key: Buffer.from('k'), value: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), offset: '7' });
const goodEnv = () =>
  createEnvelope({
    eventType: 'booking.requested', traceId: randomUUID(), actorId: 'gst_0001', actorType: 'guest',
    entityType: 'reservation', entityId: 'res_1', payload: {},
  });

function harness(handler, opts = {}) {
  const dlq = [];
  const steps = [];
  const run = (message) =>
    processMessage({
      topic: 'booking.requested', partition: 0, message, handler, groupId: 'test-cg',
      sendToDlq: async (r) => dlq.push(r), baseDelayMs: 1, traceStep: (st) => steps.push(st), ...opts,
    });
  return { dlq, steps, run };
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

// ---------------------------------------------------------------- trace steps (API doc §8)
test('trace step: a handled event is one ok step with its latency and Kafka position', async () => {
  const env = goodEnv();
  const { steps, run } = harness(async () => { await new Promise((r) => setTimeout(r, 15)); });
  assert.strictEqual(await run(msg(env)), 'ok');
  assert.strictEqual(steps.length, 1);
  const [st] = steps;
  assert.strictEqual(st.trace_id, env.trace_id);
  assert.strictEqual(st.event_type, 'booking.requested');
  assert.deepStrictEqual([st.step, st.status, st.error, st.attempt], ['handled', 'ok', null, 0]);
  assert.ok(st.latency_ms >= 10, `latency_ms ${st.latency_ms}`);
  assert.deepStrictEqual(st.kafka, { topic: 'booking.requested', partition: 0, offset: '7' });
});

test('trace step: each failed attempt is a retry step, then the success', async () => {
  let calls = 0;
  const { steps, run } = harness(async () => { if (++calls < 3) throw new Error('db down'); });
  assert.strictEqual(await run(msg(goodEnv())), 'ok');
  assert.deepStrictEqual(steps.map((st) => [st.status, st.attempt, st.error]), [['retry', 0, 'db down'], ['retry', 1, 'db down'], ['ok', 2, null]]);
});

test('trace step: retries used up gives an error step for the DLQ', async () => {
  const { steps, run } = harness(async () => { throw new Error('db down'); }, { maxRetries: 1 });
  assert.strictEqual(await run(msg(goodEnv())), 'dlq');
  assert.deepStrictEqual(steps.map((st) => [st.step, st.status]), [['handled', 'retry'], ['dead_lettered', 'error']]);
  assert.strictEqual(steps[1].error, 'db down');
});

test('trace step: malformed and invalid envelopes are rejected steps', async () => {
  const { steps, run } = harness(async () => {});
  await run(msg('{not json'));
  const bad = goodEnv();
  delete bad.event_id;
  await run(msg(bad));
  assert.deepStrictEqual(steps.map((st) => [st.step, st.status, st.trace_id === null]), [['rejected', 'error', true], ['rejected', 'error', false]]);
  assert.match(steps[1].error, /invalid envelope/);
});

test('trace step: a failing trace writer never affects processing', async () => {
  let handled = false;
  const { dlq, run } = harness(async () => { handled = true; }, { traceStep: () => { throw new Error('mongo down'); } });
  assert.strictEqual(await run(msg(goodEnv())), 'ok');
  assert.strictEqual(handled, true);
  assert.strictEqual(dlq.length, 0);
});

test('trace steps: off in unit tests, with TRACE_STEPS=off, or per consumer', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, TRACE_STEPS: process.env.TRACE_STEPS };
  try {
    delete process.env.TRACE_STEPS;
    process.env.NODE_ENV = 'test';
    assert.strictEqual(traceStepsEnabled(), false);
    process.env.NODE_ENV = 'production';
    assert.strictEqual(traceStepsEnabled(), true);
    assert.strictEqual(traceStepsEnabled(false), false);
    process.env.TRACE_STEPS = 'off';
    assert.strictEqual(traceStepsEnabled(), false);
  } finally {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.TRACE_STEPS === undefined) delete process.env.TRACE_STEPS; else process.env.TRACE_STEPS = saved.TRACE_STEPS;
  }
});
