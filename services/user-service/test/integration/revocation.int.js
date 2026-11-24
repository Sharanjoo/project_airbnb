// Deleted-account revocation against the real MySQL and Redis from docker compose.
//   npm run infra:up   then   npm run test:db -w services/user-service
// Uses the gateway's real account-status check, so both halves are tested together.
process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert');
const {
  createApp, logger, getMysql, getRedis, newId, withTransaction,
} = require('@airbnb/common');
const { buildRouter } = require('../../src/routes');
const guests = require('../../src/models/guest');
const { createAccountStatus, REVOKED_KEY_PREFIX } = require('../../../gateway/src/accountStatus');

const DOMAIN = `revoke-${Date.now()}.example.com`;
const db = () => getMysql();
let server;
let base;

test.before(() => {
  const app = createApp({ name: 'user-int-revoke', logger });
  app.use(buildRouter({ bus: { publish: async () => {} } }));
  app.finalize();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  const like = `%@${DOMAIN}`;
  const [rows] = await db().query('SELECT guest_id FROM guests WHERE email LIKE ?', [like]);
  const ids = rows.map((r) => r.guest_id);
  if (ids.length) {
    await db().query('DELETE FROM reservations WHERE guest_id IN (?)', [ids]);
    await getRedis().del(...ids.map((id) => `${REVOKED_KEY_PREFIX}${id}`)).catch(() => {});
  }
  await db().execute('DELETE FROM guests WHERE email LIKE ?', [like]);
  await db().end();
  await getRedis().quit().catch(() => {});
});

const call = async (path, body, user) => {
  const headers = { 'Content-Type': 'application/json' };
  if (user) Object.assign(headers, { 'X-User-Id': user.id, 'X-User-Role': user.role });
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

async function newGuest(local) {
  const r = await call('/guests/create', { first_name: 'Rev', last_name: 'Oked', email: `${local}@${DOMAIN}`, password: 'correct-horse-1' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  return r.body.data.guest_id;
}

const insertReservation = (conn, guestId) => conn.execute(
  `INSERT INTO reservations (reservation_id, property_id, guest_id, host_id, check_in, check_out, guest_count, price_breakdown, total_price, status, trace_id)
   VALUES (?, 'prp_0001', ?, 'hst_0001', DATE_ADD(CURRENT_DATE(), INTERVAL 60 DAY), DATE_ADD(CURRENT_DATE(), INTERVAL 62 DAY), 1, '{}', 100, 'REQUESTED', '00000000-0000-4000-8000-000000000000')`,
  [newId('res'), guestId],
);

test('delete -> Redis marker for the token lifetime, and the gateway check flips to revoked at once', async () => {
  const id = await newGuest('marker');
  const accounts = createAccountStatus();
  assert.strictEqual(await accounts.check(id), 'active');

  assert.strictEqual((await call('/guests/delete', { guest_id: id }, { id, role: 'guest' })).status, 200);
  const ttl = await getRedis().ttl(`${REVOKED_KEY_PREFIX}${id}`);
  assert.ok(ttl > 8 * 3600, `marker lives at least as long as a token (${ttl}s)`);
  assert.strictEqual(await accounts.check(id), 'revoked', 'the same gateway, with "active" still cached');
});

test('Redis loses the marker (restart/flush): MySQL still revokes', async () => {
  const id = await newGuest('flush');
  await call('/guests/delete', { guest_id: id }, { id, role: 'guest' });
  await getRedis().del(`${REVOKED_KEY_PREFIX}${id}`);
  assert.strictEqual(await createAccountStatus().check(id), 'revoked');
});

test('active users are unaffected; unknown ids are revoked', async () => {
  const id = await newGuest('active');
  const accounts = createAccountStatus();
  assert.strictEqual(await accounts.check(id), 'active');
  assert.strictEqual(await accounts.check('gst_0001'), 'active', 'seed guest');
  assert.strictEqual(await accounts.check('hst_0001'), 'active', 'seed host');
  assert.strictEqual(await accounts.check(newId('gst')), 'revoked', 'no such account');
});

test('delete waits for a booking transaction already writing a reservation, then refuses (409)', async () => {
  const id = await newGuest('inflight');
  const conn = await db().getConnection();
  try {
    await conn.beginTransaction();
    await insertReservation(conn, id); // booking-worker mid-transaction: holds a FK lock on the guest
    const pending = call('/guests/delete', { guest_id: id }, { id, role: 'guest' });
    await new Promise((r) => setTimeout(r, 300));
    await conn.commit();
    const r = await pending;
    assert.strictEqual(r.status, 409, 'the reservation that committed first is counted');
    assert.strictEqual(r.body.error.code, 'INVALID_STATE_TRANSITION');
  } finally {
    conn.release();
  }
  const [[g]] = await db().execute('SELECT is_deleted FROM guests WHERE guest_id = ?', [id]);
  assert.strictEqual(g.is_deleted, 0);
});

test('with the booking-worker check proposed for slice 3, 20 delete/booking races never leave a deleted guest holding an active stay', async () => {
  // Proposed booking-worker step (Sri): inside its transaction, before inserting,
  //   SELECT is_deleted FROM guests WHERE guest_id = ? FOR SHARE  -> reject if deleted.
  const bookAsWorker = (guestId) => withTransaction(async (conn) => {
    const [[g]] = await conn.execute('SELECT is_deleted FROM guests WHERE guest_id = ? FOR SHARE', [guestId]);
    if (!g || g.is_deleted) return 'rejected_deleted';
    await insertReservation(conn, guestId);
    return 'booked';
  });
  for (let i = 0; i < 20; i++) {
    const id = await newGuest(`race${i}`);
    const [booking, del] = await Promise.all([bookAsWorker(id), guests.softDeleteIfNoActiveReservations(id)]);
    const [[g]] = await db().execute('SELECT is_deleted FROM guests WHERE guest_id = ?', [id]);
    const active = await guests.countActiveReservations(id);
    assert.ok(!(g.is_deleted && active > 0), `race ${i}: booking=${booking}, delete=${del.outcome}`);
    assert.ok((booking === 'booked' && del.outcome === 'active') || (booking === 'rejected_deleted' && del.outcome === 'deleted'), `race ${i}: ${booking}/${del.outcome}`);
  }
});

test('two concurrent deletes: one deletes, the other sees it already deleted; version bumped once', async () => {
  const id = await newGuest('double');
  const outcomes = (await Promise.all([guests.softDeleteIfNoActiveReservations(id), guests.softDeleteIfNoActiveReservations(id)])).map((x) => x.outcome).sort();
  assert.deepStrictEqual(outcomes, ['already', 'deleted']);
  const [[g]] = await db().execute('SELECT is_deleted, version FROM guests WHERE guest_id = ?', [id]);
  assert.deepStrictEqual({ ...g }, { is_deleted: 1, version: 2 });
});
