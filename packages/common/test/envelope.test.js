process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { createEnvelope, validateEnvelope } = require('../src/envelope');

const base = () =>
  createEnvelope({
    eventType: 'booking.requested',
    traceId: randomUUID(),
    actorId: 'gst_0001',
    actorType: 'guest',
    entityType: 'reservation',
    entityId: 'res_1',
    payload: { property_id: 'prp_0001' },
  });

test('createEnvelope produces a valid envelope', () => {
  const env = base();
  assert.deepStrictEqual(validateEnvelope(env, 'booking.requested'), { valid: true });
});

test('missing trace_id is rejected', () => {
  const env = base();
  delete env.trace_id;
  const r = validateEnvelope(env);
  assert.strictEqual(r.valid, false);
  assert.match(r.errors.join(), /trace_id/);
});

test('unknown top-level field is rejected', () => {
  const env = { ...base(), extra: 1 };
  assert.strictEqual(validateEnvelope(env).valid, false);
});

test('non-UTC timestamp is rejected', () => {
  const env = { ...base(), timestamp: '2026-11-01T10:00:00-07:00' };
  assert.strictEqual(validateEnvelope(env).valid, false);
});

test('timestamp far in the future is rejected', () => {
  const env = { ...base(), timestamp: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
  assert.strictEqual(validateEnvelope(env).valid, false);
});

test('event_type must match topic', () => {
  const r = validateEnvelope(base(), 'booking.approved');
  assert.strictEqual(r.valid, false);
  assert.match(r.errors.join(), /does not match topic/);
});

test('entity requires entity_type and entity_id', () => {
  const env = { ...base(), entity: { entity_type: 'reservation' } };
  assert.strictEqual(validateEnvelope(env).valid, false);
});
