process.env.NODE_ENV = 'test';
// The Redis marker user-service writes when an account is deleted (fast path for the gateway).
const test = require('node:test');
const assert = require('node:assert');
const { markRevoked, REVOKED_KEY_PREFIX } = require('../src/revocation');

const fakeRedis = (status, { setFails = false, hang = false } = {}) => {
  const calls = [];
  const r = {
    status,
    calls,
    async connect() { if (hang) await new Promise(() => {}); r.status = 'ready'; },
    async set(...args) { calls.push(args); if (setFails) throw new Error('READONLY'); return 'OK'; },
  };
  return r;
};

test('writes auth:revoked:<id> for the token lifetime plus clock skew', async () => {
  const r = fakeRedis('ready');
  assert.strictEqual(await markRevoked('gst_0001', { redis: () => r }), true);
  const [key, value, ex, seconds] = r.calls[0];
  assert.deepStrictEqual([key, value, ex], [`${REVOKED_KEY_PREFIX}gst_0001`, '1', 'EX']);
  assert.ok(seconds >= 8 * 3600, `expires after the longest token (${seconds}s)`);
});

test('connects lazily on first use', async () => {
  const r = fakeRedis('wait');
  assert.strictEqual(await markRevoked('gst_0001', { redis: () => r }), true);
});

test('Redis down, failing or hanging -> false, never throws, never stalls the delete', async () => {
  assert.strictEqual(await markRevoked('gst_0001', { redis: () => fakeRedis('reconnecting') }), false);
  assert.strictEqual(await markRevoked('gst_0001', { redis: () => fakeRedis('ready', { setFails: true }) }), false);
  const t0 = Date.now();
  assert.strictEqual(await markRevoked('gst_0001', { redis: () => fakeRedis('wait', { hang: true }), timeoutMs: 50 }), false);
  assert.ok(Date.now() - t0 < 1000);
});
