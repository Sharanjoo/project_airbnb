// Tell every gateway instance at once that an account was deleted.
//
// The deletion itself is the durable `is_deleted = TRUE` in MySQL, which the gateway
// checks (services/gateway/src/accountStatus.js). This Redis marker only makes the
// change visible immediately instead of after the gateway's few-second cache. It lives
// as long as the longest token user-service issues, after which no token for the
// account can still be valid anyway. Losing it (Redis restart, flush, outage) only
// brings back that few-second delay; it never brings back access.
const { getRedis, logger } = require('@airbnb/common');
const { ttlSeconds } = require('./auth');

const REVOKED_KEY_PREFIX = 'auth:revoked:'; // must match services/gateway/src/accountStatus.js
const CLOCK_SKEW_S = 300;
const TIMEOUT_MS = 500; // an unreachable Redis must not stall the delete request

async function markRevoked(userId, { redis = getRedis, timeoutMs = TIMEOUT_MS } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('redis timeout')), timeoutMs); });
  try {
    await Promise.race([(async () => {
      const r = redis();
      if (r.status === 'wait') await r.connect();
      if (r.status !== 'ready') throw new Error(`redis ${r.status}`);
      await r.set(`${REVOKED_KEY_PREFIX}${userId}`, '1', 'EX', ttlSeconds() + CLOCK_SKEW_S);
    })(), timeout]);
    return true;
  } catch (err) {
    logger.warn('could not write revocation marker; gateways will see the deletion from MySQL within seconds', { user_id: userId, error: err.message });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { markRevoked, REVOKED_KEY_PREFIX };
