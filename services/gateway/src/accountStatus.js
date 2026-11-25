// Is the account behind a valid JWT still allowed in? (Slice 1, deleted-account revocation)
//
// A JWT stays cryptographically valid until it expires (8 hours by default), so deleting
// an account must also stop its outstanding tokens. Sources, strongest first:
//
//   1. MySQL `guests.is_deleted` / `hosts.is_deleted`: the source of truth. Durable, survives
//      every restart. A missing row (account never existed or was purged) counts as revoked.
//   2. Redis `auth:revoked:<user_id>`: written by user-service the moment it deletes an
//      account, so every gateway instance sees the deletion at once instead of after its
//      cache expires. Only a fast path: if Redis is down or was flushed, MySQL still decides.
//   3. This process's cache: "revoked" is kept for good (deletion is permanent); "active" is
//      reused for ACTIVE_TTL_MS so MySQL sees at most one lookup per user per few seconds.
//
// Worst case after a deletion: the gateway may let the account in for up to ACTIVE_TTL_MS,
// and only when Redis is unavailable at the same time. Requests already past the gateway are
// not recalled; see docs for the booking-worker cooperation needed for those.
//
// Failures: Redis errors are ignored (MySQL decides). If MySQL fails and there is no recent
// "active" entry, check() answers 'unavailable' and the gateway fails closed on protected
// routes (503) rather than letting an unverified account through.
const { getMysql, getRedis, logger } = require('@airbnb/common');

const REVOKED_KEY_PREFIX = 'auth:revoked:'; // must match services/user-service/src/revocation.js
const ACTIVE_TTL_MS = Number(process.env.ACCOUNT_STATUS_TTL_MS || 5000);
const STALE_GRACE_MS = 60000; // an "active" answer this old may still be used while MySQL is down
const MAX_ENTRIES = 50000;
const REDIS_TIMEOUT_MS = 100;

const TABLES = { gst_: ['guests', 'guest_id'], hst_: ['hosts', 'host_id'] };

/** MySQL: 'active' | 'revoked'. Throws if the database is unavailable. */
async function mysqlLookup(userId) {
  const table = TABLES[userId.slice(0, 4)];
  if (!table) return 'revoked'; // not an id user-service ever issues
  const [rows] = await getMysql().execute(`SELECT is_deleted FROM ${table[0]} WHERE ${table[1]} = ?`, [userId]);
  if (!rows[0] || rows[0].is_deleted) return 'revoked';
  return 'active';
}

/** Redis: true if the revocation marker exists. Throws if Redis is unavailable or slow. */
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

function createAccountStatus({
  lookup = mysqlLookup, revoked = redisRevoked, activeTtlMs = ACTIVE_TTL_MS, now = Date.now, log = logger,
} = {}) {
  const cache = new Map(); // userId -> { state: 'active' | 'revoked', at }
  let redisWarnedAt = 0;

  const remember = (userId, state) => {
    cache.delete(userId); // re-insert so Map order stays oldest-first for eviction
    cache.set(userId, { state, at: now() });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  };

  /** 'active' | 'revoked' | 'unavailable' */
  async function check(userId) {
    const hit = cache.get(userId);
    if (hit && hit.state === 'revoked') return 'revoked';

    try {
      if (await revoked(userId)) {
        remember(userId, 'revoked');
        return 'revoked';
      }
    } catch (err) {
      if (now() - redisWarnedAt > 60000) { // once a minute, not once per request
        redisWarnedAt = now();
        log.warn('revocation cache unavailable, using MySQL', { error: err.message });
      }
    }

    if (hit && now() - hit.at < activeTtlMs) return 'active';

    try {
      const state = await lookup(userId);
      remember(userId, state);
      return state;
    } catch (err) {
      if (hit && now() - hit.at < STALE_GRACE_MS) return 'active'; // known-good a moment ago
      log.error('account status lookup failed', { user_id: userId, error: err.message });
      return 'unavailable';
    }
  }

  return { check, _cache: cache };
}

module.exports = { createAccountStatus, mysqlLookup, redisRevoked, REVOKED_KEY_PREFIX, ACTIVE_TTL_MS, STALE_GRACE_MS };
