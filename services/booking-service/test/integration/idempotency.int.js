// Idempotency-Key storage against real MySQL: the stored hash, the 24 hour expiry and reuse after expiry.
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { getMysql } = require('@airbnb/common');
const repo = require('../../src/models/booking');

const keys = [];
const newKey = () => { const k = `idem-int-${randomUUID()}`; keys.push(k); return k; };

test('a saved response comes back with the hash of the request that made it', async () => {
  const key = newKey();
  const fp = { path: '/bookings/approve', body: { reservation_id: 'res_1' } };
  await repo.saveIdempotentResponse(key, fp, 202, { data: { status: 'APPROVING' } });
  const found = await repo.findIdempotentResponse(key);
  assert.strictEqual(found.response_status, 202);
  assert.deepStrictEqual(found.response_body, { data: { status: 'APPROVING' } });
  assert.strictEqual(found.request_hash, repo.hashBody(fp));
  assert.notStrictEqual(found.request_hash, repo.hashBody({ ...fp, body: { reservation_id: 'res_2' } }));
});

test('the first answer for a key wins; a second save does not overwrite it', async () => {
  const key = newKey();
  await repo.saveIdempotentResponse(key, { a: 1 }, 202, { n: 1 });
  await repo.saveIdempotentResponse(key, { a: 1 }, 202, { n: 2 });
  assert.deepStrictEqual((await repo.findIdempotentResponse(key)).response_body, { n: 1 });
});

test('a key older than 24 hours is forgotten and can be used again', async () => {
  const key = newKey();
  await repo.saveIdempotentResponse(key, { a: 1 }, 202, { n: 1 });
  await getMysql().execute('UPDATE idempotency_keys SET created_at = NOW(3) - INTERVAL 25 HOUR WHERE idempotency_key = ?', [key]);
  assert.strictEqual(await repo.findIdempotentResponse(key), null);

  await repo.saveIdempotentResponse(key, { a: 2 }, 202, { n: 2 });
  const found = await repo.findIdempotentResponse(key);
  assert.deepStrictEqual(found.response_body, { n: 2 });
  assert.strictEqual(found.request_hash, repo.hashBody({ a: 2 }));
});

test.after(async () => {
  for (const k of keys) await getMysql().execute('DELETE FROM idempotency_keys WHERE idempotency_key = ?', [k]);
  await getMysql().end();
});
