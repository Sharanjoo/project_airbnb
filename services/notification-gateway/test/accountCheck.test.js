process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { createAccountCheck } = require('../src/accountCheck');

const quiet = { error() {}, warn() {} };

test('the Redis revocation marker answers revoked without asking MySQL, and is remembered', async () => {
  let lookups = 0;
  let redisCalls = 0;
  const check = createAccountCheck({ revoked: async () => { redisCalls++; return true; }, lookup: async () => { lookups++; return 'active'; }, log: quiet });
  assert.strictEqual(await check('gst_1'), 'revoked');
  assert.strictEqual(await check('gst_1'), 'revoked');
  assert.strictEqual(lookups, 0);
  assert.strictEqual(redisCalls, 1); // "revoked" is kept for good
});

test('MySQL decides when Redis has no marker or is down; active is cached briefly', async () => {
  let t = 0;
  let lookups = 0;
  const check = createAccountCheck({
    revoked: async () => { throw new Error('redis down'); },
    lookup: async () => { lookups++; return 'active'; },
    activeTtlMs: 5000, now: () => t, log: quiet,
  });
  assert.strictEqual(await check('gst_1'), 'active');
  t = 4000;
  assert.strictEqual(await check('gst_1'), 'active');
  assert.strictEqual(lookups, 1);
  t = 6000;
  assert.strictEqual(await check('gst_1'), 'active');
  assert.strictEqual(lookups, 2);
});

test('a deleted or missing account is revoked; a MySQL failure is unavailable', async () => {
  const revokedCheck = createAccountCheck({ revoked: async () => false, lookup: async () => 'revoked', log: quiet });
  assert.strictEqual(await revokedCheck('gst_1'), 'revoked');
  const downCheck = createAccountCheck({ revoked: async () => false, lookup: async () => { throw new Error('mysql down'); }, log: quiet });
  assert.strictEqual(await downCheck('gst_1'), 'unavailable');
});
