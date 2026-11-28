// Is the account behind a WebSocket token still allowed in? (review on #6)
//
// A JWT stays valid until it expires, so a deleted account's token would otherwise keep
// opening sockets and hearing its own channel. Same rule as the API gateway
// (services/gateway/src/accountStatus.js, slice 1), checked once per connection:
//
//   1. Redis `auth:revoked:<user_id>`: written by the user service the moment it deletes an
//      account. Only a fast path; if Redis is down or slow, MySQL decides.
//   2. MySQL `guests.is_deleted` / `hosts.is_deleted`: the source of truth. A missing row
//      counts as revoked.
//   3. A short cache: "revoked" is kept for good (deletion is permanent), "active" for a few
//      seconds, so a page that reconnects does not cost a query every time.
//
// Answers 'active' | 'revoked' | 'unavailable' (MySQL failed and nothing recent is known).
// The gateway refuses the socket for anything but 'active', like the API gateway fails closed.
const { getMysql, getRedis, logger } = require('@airbnb/common');

const REVOKED_KEY_PREFIX = 'auth:revoked:'; // must match services/user-service/src/revocation.js
const ACTIVE_TTL_MS = Number(process.env.ACCOUNT_STATUS_TTL_MS || 5000);
const REDIS_TIMEOUT_MS = 100;
const MAX_ENTRIES = 50000;
const TABLES = { gst_: ['guests', 'guest_id'], hst_: ['hosts', 'host_id'] };

async function mysqlLookup(userId) {
  const table = TABLES[String(userId).slice(0, 4)];
  if (!table) return 'revoked'; // not an id the user service issues
  const [rows] = await getMysql().execute(`SELECT is_deleted FROM ${table[0]} WHERE ${table[1]} = ?`, [userId]);
  return !rows[0] || rows[0].is_deleted ? 'revoked' : 'active';
}

async function redisRevoked(userId) {
  const r = getRedis();
  if (r.status === 'wait') await r.connect();
  if (r.status !== 'ready') throw new Error(`redis ${r.status}`);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('redis timeout')), REDIS_TIMEOUT_MS); });
  try {
    return (await Promise.race([r.exists(`${REVOKED_KEY_PREFIX}${userId}`), timeout])) === 1;
  } finally {
    clearTimeout(timer);
  }
}

function createAccountCheck({ lookup = mysqlLookup, revoked = redisRevoked, activeTtlMs = ACTIVE_TTL_MS, now = Date.now, log = logger } = {}) {
  const cache = new Map(); // userId -> { state, at }
  const remember = (userId, state) => {
    cache.delete(userId);
    cache.set(userId, { state, at: now() });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  };

  return async function check(userId) {
    const hit = cache.get(userId);
    if (hit && hit.state === 'revoked') return 'revoked';
    try {
      if (await revoked(userId)) {
        remember(userId, 'revoked');
        return 'revoked';
      }
    } catch { /* Redis is only a fast path; MySQL decides */ }
    if (hit && now() - hit.at < activeTtlMs) return 'active';
    try {
      const state = await lookup(userId);
      remember(userId, state);
      return state;
    } catch (err) {
      log.error('account check failed', { user_id: userId, error: err.message });
      return 'unavailable';
    }
  };
}

module.exports = { createAccountCheck, mysqlLookup, redisRevoked, REVOKED_KEY_PREFIX };
