// Redis cache for search results and availability calendars (API doc §4, feature 13.9).
//
// Keys
//   search:version                              counter, bumped on every relevant change
//   search:<version>:<strategy>:<sha256(body)>  cached search response, 60 s
//   avail:<property_id>                         cached calendar, 300 s
//
// Every Redis call is best-effort: if Redis is down we log and fall back to the
// database (cache: "BYPASS"), because MySQL is always the source of truth.
const { createHash } = require('crypto');
const { getRedis, logger } = require('@airbnb/common');

const SEARCH_VERSION_KEY = 'search:version';
const SEARCH_TTL_S = Number(process.env.SEARCH_CACHE_TTL_S || 60);
const AVAIL_TTL_S = Number(process.env.AVAIL_CACHE_TTL_S || 300);
const availKey = (propertyId) => `avail:${propertyId}`;

async function client() {
  const r = getRedis();
  if (r.status === 'wait') await r.connect(); // lazyConnect: open on first use
  if (r.status !== 'ready') throw new Error(`redis ${r.status}`);
  return r;
}

/** Stable JSON: same filters in any key order -> same cache key. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function searchKey(version, strategy, body) {
  return `search:${version}:${strategy}:${createHash('sha256').update(canonical(body)).digest('hex')}`;
}

/**
 * Cache-aside search. `compute()` runs the real query on a miss.
 * The version is read BEFORE computing: if an invalidation lands while we
 * compute, our result is stored under the old version and is never served.
 * Returns { result, cache: 'HIT' | 'MISS' | 'BYPASS' }.
 */
async function cachedSearch(strategy, body, compute, { bypass = false } = {}) {
  if (bypass) return { result: await compute(), cache: 'BYPASS' };
  let r;
  let key;
  try {
    r = await client();
    const version = Number((await r.get(SEARCH_VERSION_KEY)) || 0);
    key = searchKey(version, strategy, body);
    const hit = await r.get(key);
    if (hit) return { result: JSON.parse(hit), cache: 'HIT' };
  } catch (err) {
    logger.warn('search cache unavailable, reading database', { error: err.message });
    return { result: await compute(), cache: 'BYPASS' };
  }
  const result = await compute();
  try {
    await r.set(key, JSON.stringify(result), 'EX', SEARCH_TTL_S);
  } catch (err) {
    logger.warn('search cache write failed', { error: err.message });
  }
  return { result, cache: 'MISS' };
}

/** Cache-aside for one property's calendar. Returns { result, cache }. */
async function cachedCalendar(propertyId, compute) {
  let r;
  try {
    r = await client();
    const hit = await r.get(availKey(propertyId));
    if (hit) return { result: JSON.parse(hit), cache: 'HIT' };
  } catch (err) {
    logger.warn('availability cache unavailable, reading database', { property_id: propertyId, error: err.message });
    return { result: await compute(), cache: 'BYPASS' };
  }
  const result = await compute();
  try {
    await r.set(availKey(propertyId), JSON.stringify(result), 'EX', AVAIL_TTL_S);
  } catch (err) {
    logger.warn('availability cache write failed', { error: err.message });
  }
  return { result, cache: 'MISS' };
}

/**
 * Call after any change that can affect search results or a property's calendar
 * (price, status, availability, a booking confirmed or cancelled, a new rating).
 * Bumping search:version makes every cached search key stale at once.
 */
async function invalidateProperty(propertyId) {
  try {
    const r = await client();
    await r.multi().incr(SEARCH_VERSION_KEY).del(availKey(propertyId)).exec();
    return true;
  } catch (err) {
    logger.warn('cache invalidation skipped (Redis unavailable)', { property_id: propertyId, error: err.message });
    return false;
  }
}

module.exports = {
  cachedSearch, cachedCalendar, invalidateProperty, searchKey, canonical, SEARCH_VERSION_KEY, availKey,
};
