// Analytics queries. Everything is computed live from MySQL (users, listings,
// reservations) and the MongoDB `events` collection that analytics-worker fills
// from every Kafka topic. No stored samples.
//
// Windows: `since` / `until` are YYYY-MM-DD (UTC). MySQL compares DATE/DATETIME
// columns against them; Mongo compares the envelope's ISO `timestamp` string,
// which sorts correctly as text.
const { getMysql, getMongo } = require('@airbnb/common');

const BOOKED = ['CONFIRMED', 'COMPLETED'];
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const money = (v) => Math.round(num(v) * 100) / 100;
const iso = (day) => `${day}T00:00:00.000Z`;
const q = async (sql, params) => (await getMysql().query(sql, params))[0];
const events = async () => (await getMongo()).collection('events');

/** Every day in [since, until) with 0 where there is no row, so charts have no gaps. */
function fillDays(since, until, rows, key = 'day', value = 'count') {
  const byDay = new Map(rows.map((r) => [String(r[key]).slice(0, 10), num(r[value])]));
  const out = [];
  for (let t = Date.parse(iso(since)); t < Date.parse(iso(until)); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    out.push({ day: d, count: byDay.get(d) || 0 });
  }
  return out;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const statusMap = (rows) => Object.fromEntries(rows.map((r) => [r.status, num(r.n)]));

// ---------------------------------------------------------------- platform (admin)
async function platform({ since, until }) {
  const [[users], props, resv, [rev], perDay] = await Promise.all([
    q(`SELECT (SELECT COUNT(*) FROM guests WHERE is_deleted = 0) AS guests,
              (SELECT COUNT(*) FROM hosts WHERE is_deleted = 0) AS hosts`),
    q('SELECT status, COUNT(*) AS n FROM properties GROUP BY status'),
    q('SELECT status, COUNT(*) AS n FROM reservations WHERE booking_datetime >= ? AND booking_datetime < ? GROUP BY status', [since, until]),
    q(`SELECT COALESCE(SUM(total_price), 0) AS revenue, COUNT(*) AS n FROM reservations
       WHERE status IN (?) AND booking_datetime >= ? AND booking_datetime < ?`, [BOOKED, since, until]),
    q(`SELECT DATE(booking_datetime) AS day, COUNT(*) AS count FROM reservations
       WHERE booking_datetime >= ? AND booking_datetime < ? GROUP BY DATE(booking_datetime)`, [since, until]),
  ]);
  const ev = await events();
  const [byType, total] = await Promise.all([
    ev.aggregate([
      { $match: { timestamp: { $gte: iso(since), $lt: iso(until) } } },
      { $group: { _id: '$event_type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    ev.estimatedDocumentCount(),
  ]);
  return {
    users: { guests: num(users.guests), hosts: num(users.hosts) },
    properties: statusMap(props),
    reservations: { by_status: statusMap(resv), booked: num(rev.n), revenue: money(rev.revenue) },
    bookings_per_day: fillDays(since, until, perDay),
    events: {
      stored_total: total,
      in_window: byType.reduce((s, r) => s + r.count, 0),
      by_type: byType.map((r) => ({ event_type: r._id, count: r.count })),
    },
  };
}

// ---------------------------------------------------------------- traces
/** All events of one journey, oldest first. */
async function trace(traceId) {
  return (await events()).find({ trace_id: traceId }, { projection: { _id: 0 } })
    .sort({ timestamp: 1, received_at: 1 }).limit(1000).toArray();
}

// ---------------------------------------------------------------- host
async function host(hostId, { since, until, days }) {
  const [listings, resv, [rev], [nights], responses, cancels] = await Promise.all([
    q("SELECT property_id, title, status, rating, review_count FROM properties WHERE host_id = ? AND status <> 'deleted'", [hostId]),
    q('SELECT status, COUNT(*) AS n FROM reservations WHERE host_id = ? AND booking_datetime >= ? AND booking_datetime < ? GROUP BY status', [hostId, since, until]),
    q(`SELECT COALESCE(SUM(total_price), 0) AS revenue, COUNT(*) AS n FROM reservations
       WHERE host_id = ? AND status IN (?) AND check_in >= ? AND check_in < ?`, [hostId, BOOKED, since, until]),
    q(`SELECT COUNT(*) AS n FROM reservation_nights rn
       JOIN reservations r ON r.reservation_id = rn.reservation_id
       WHERE r.host_id = ? AND r.status IN (?) AND rn.night >= ? AND rn.night < ?`, [hostId, BOOKED, since, until]),
    // minutes from the request to the host's first decision
    q(`SELECT TIMESTAMPDIFF(SECOND, r.booking_datetime, MIN(h.at)) / 60 AS minutes
       FROM reservations r JOIN reservation_status_history h ON h.reservation_id = r.reservation_id
       WHERE r.host_id = ? AND h.from_status = 'REQUESTED' AND h.to_status IN ('CONFIRMED', 'DECLINED') AND h.actor_id = ?
         AND r.booking_datetime >= ? AND r.booking_datetime < ?
       GROUP BY r.reservation_id, r.booking_datetime`, [hostId, hostId, since, until]),
    q(`SELECT
         SUM(status = 'CANCELLED') AS cancelled,
         SUM(status IN ('CONFIRMED', 'COMPLETED', 'CANCELLED')) AS ever_booked
       FROM reservations WHERE host_id = ? AND booking_datetime >= ? AND booking_datetime < ?`, [hostId, since, until]),
  ]);
  const active = listings.filter((l) => l.status === 'active').length;
  const rated = listings.filter((l) => l.rating !== null);
  const reviews = (await getMongo()).collection('reviews');
  const trend = await reviews.aggregate([
    { $match: { host_id: hostId } },
    { $group: { _id: { $substr: ['$created_datetime', 0, 7] }, average: { $avg: '$rating' }, count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  const minutes = responses.map((r) => num(r.minutes));
  const c = cancels[0] || {};
  return {
    listings: { total: listings.length, active },
    reservations: { by_status: statusMap(resv) },
    revenue: money(rev.revenue),
    booked_stays: num(rev.n),
    occupancy: active ? Math.round((num(nights.n) / (active * days)) * 1000) / 1000 : 0,
    booked_nights: num(nights.n),
    cancellation_rate: num(c.ever_booked) ? Math.round((num(c.cancelled) / num(c.ever_booked)) * 1000) / 1000 : 0,
    response_time_minutes: { median: median(minutes), decisions: minutes.length },
    rating: {
      average: rated.length ? Math.round((rated.reduce((s, l) => s + Number(l.rating), 0) / rated.length) * 100) / 100 : null,
      trend: trend.map((t) => ({ month: t._id, average: Math.round(t.average * 100) / 100, count: t.count })),
    },
    properties: listings.map((l) => ({
      property_id: l.property_id, title: l.title, status: l.status,
      rating: l.rating === null ? null : Number(l.rating), review_count: num(l.review_count),
    })),
  };
}

// ---------------------------------------------------------------- funnel (host)
async function funnel(hostId, { since, until, propertyId }) {
  const own = await q("SELECT property_id FROM properties WHERE host_id = ? AND status <> 'deleted'", [hostId]);
  let ids = own.map((r) => r.property_id);
  if (propertyId) ids = ids.filter((id) => id === propertyId);
  if (!ids.length) return { property_ids: ids, steps: emptySteps() };

  const ev = await events();
  const window = { $gte: iso(since), $lt: iso(until) };
  const [views, saves, [resv]] = await Promise.all([
    ev.countDocuments({ event_type: 'property.viewed', 'payload.property_id': { $in: ids }, timestamp: window }),
    ev.countDocuments({ event_type: 'property.saved', 'payload.property_id': { $in: ids }, 'payload.saved': true, timestamp: window }),
    // "confirmed" = ever confirmed, so a stay cancelled after confirmation still counts,
    // but a request the guest withdrew before the host answered does not
    q(`SELECT COUNT(*) AS requested,
              SUM(r.status IN ('CONFIRMED', 'COMPLETED') OR EXISTS (
                SELECT 1 FROM reservation_status_history h WHERE h.reservation_id = r.reservation_id AND h.to_status = 'CONFIRMED')) AS confirmed,
              SUM(r.status = 'COMPLETED') AS completed
       FROM reservations r WHERE r.property_id IN (?) AND r.booking_datetime >= ? AND r.booking_datetime < ?`, [ids, since, until]),
  ]);
  const counts = [views, saves, num(resv.requested), num(resv.confirmed), num(resv.completed)];
  return { property_ids: ids, steps: toSteps(counts) };
}

const STEP_NAMES = ['viewed', 'saved', 'requested', 'confirmed', 'completed'];
const emptySteps = () => toSteps([0, 0, 0, 0, 0]);
/** Each step with its conversion from views and from the step before. */
function toSteps(counts) {
  return STEP_NAMES.map((name, i) => ({
    step: name,
    count: counts[i],
    from_views: counts[0] ? Math.round((counts[i] / counts[0]) * 1000) / 1000 : null,
    from_previous: i === 0 ? null : (counts[i - 1] ? Math.round((counts[i] / counts[i - 1]) * 1000) / 1000 : null),
  }));
}

// ---------------------------------------------------------------- guest
async function guest(guestId, { since, until }) {
  const [perDay, all, [spent], [saved], [upcoming]] = await Promise.all([
    q(`SELECT DATE(booking_datetime) AS day, COUNT(*) AS count FROM reservations
       WHERE guest_id = ? AND booking_datetime >= ? AND booking_datetime < ? GROUP BY DATE(booking_datetime)`, [guestId, since, until]),
    q('SELECT status, COUNT(*) AS n FROM reservations WHERE guest_id = ? GROUP BY status', [guestId]),
    q('SELECT COALESCE(SUM(total_price), 0) AS total FROM reservations WHERE guest_id = ? AND status IN (?)', [guestId, BOOKED]),
    q('SELECT COUNT(*) AS n FROM saved_properties WHERE guest_id = ?', [guestId]),
    q("SELECT COUNT(*) AS n FROM reservations WHERE guest_id = ? AND status IN ('REQUESTED', 'CONFIRMED') AND check_out >= CURRENT_DATE()", [guestId]),
  ]);
  const db = await getMongo();
  const [reviews, aiRequests, aiResults, approvals] = await Promise.all([
    db.collection('reviews').countDocuments({ guest_id: guestId }),
    db.collection('events').countDocuments({ event_type: 'ai.requests', actor_id: guestId }),
    db.collection('events').find({ event_type: 'ai.results', 'payload.user_id': guestId }, { projection: { _id: 0, payload: 1 } })
      .sort({ timestamp: -1 }).limit(50).toArray(),
    db.collection('events').countDocuments({ event_type: 'ai.approvals', actor_id: guestId }),
  ]);
  const scores = aiResults.map((r) => r.payload && (r.payload.match_score ?? r.payload.score)).filter((s) => typeof s === 'number');
  return {
    bookings_per_day: fillDays(since, until, perDay),
    reservations: { by_status: statusMap(all), upcoming: num(upcoming.n), total_spent: money(spent.total) },
    saved_properties: num(saved.n),
    reviews_written: reviews,
    ai: {
      requests: aiRequests,
      results: aiResults.length,
      approvals,
      average_match_score: scores.length ? Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 1000) / 1000 : null,
    },
  };
}

// ---------------------------------------------------------------- top properties
async function top({ metric, since, until, limit }) {
  if (metric === 'rating') {
    const rows = await q(`SELECT property_id, title, city, rating AS value, review_count FROM properties
      WHERE status = 'active' AND rating IS NOT NULL ORDER BY rating DESC, review_count DESC LIMIT ?`, [limit]);
    return rows.map((r) => ({ ...r, value: Number(r.value), review_count: num(r.review_count) }));
  }
  if (metric === 'bookings' || metric === 'revenue') {
    const agg = metric === 'bookings' ? 'COUNT(*)' : 'SUM(r.total_price)';
    const rows = await q(`SELECT p.property_id, p.title, p.city, ${agg} AS value FROM reservations r
      JOIN properties p ON p.property_id = r.property_id
      WHERE r.status IN (?) AND r.booking_datetime >= ? AND r.booking_datetime < ?
      GROUP BY p.property_id, p.title, p.city ORDER BY value DESC LIMIT ?`, [BOOKED, since, until, limit]);
    return rows.map((r) => ({ ...r, value: metric === 'revenue' ? money(r.value) : num(r.value) }));
  }
  // views: from property.viewed events
  const counts = await (await events()).aggregate([
    { $match: { event_type: 'property.viewed', timestamp: { $gte: iso(since), $lt: iso(until) } } },
    { $group: { _id: '$payload.property_id', value: { $sum: 1 } } },
    { $sort: { value: -1 } },
    { $limit: limit },
  ]).toArray();
  if (!counts.length) return [];
  const names = await q('SELECT property_id, title, city FROM properties WHERE property_id IN (?)', [counts.map((c) => c._id)]);
  const byId = new Map(names.map((n) => [n.property_id, n]));
  return counts.map((c) => ({ property_id: c._id, title: byId.get(c._id)?.title ?? null, city: byId.get(c._id)?.city ?? null, value: c.value }));
}

// ---------------------------------------------------------------- geo (admin)
async function geo({ since, until }) {
  const rows = await q(`SELECT p.state, p.city,
      COUNT(DISTINCT p.property_id) AS listings,
      COUNT(r.reservation_id) AS bookings,
      COALESCE(SUM(r.total_price), 0) AS revenue
    FROM properties p
    LEFT JOIN reservations r ON r.property_id = p.property_id AND r.status IN (?)
      AND r.booking_datetime >= ? AND r.booking_datetime < ?
    WHERE p.status = 'active'
    GROUP BY p.state, p.city ORDER BY bookings DESC, listings DESC`, [BOOKED, since, until]);
  return rows.map((r) => ({ state: r.state, city: r.city, listings: num(r.listings), bookings: num(r.bookings), revenue: money(r.revenue) }));
}

// ---------------------------------------------------------------- ai (admin)
async function ai({ since, until }) {
  const ev = await events();
  const window = { $gte: iso(since), $lt: iso(until) };
  const [byType, latencies] = await Promise.all([
    ev.aggregate([
      { $match: { event_type: { $regex: '^(ai|debate)\\.' }, timestamp: window } },
      { $group: { _id: '$event_type', count: { $sum: 1 } } },
    ]).toArray(),
    // request -> result time per trace
    ev.aggregate([
      { $match: { event_type: { $in: ['ai.requests', 'ai.results'] }, timestamp: window } },
      { $group: {
        _id: '$trace_id',
        requested: { $min: { $cond: [{ $eq: ['$event_type', 'ai.requests'] }, '$timestamp', null] } },
        resulted: { $min: { $cond: [{ $eq: ['$event_type', 'ai.results'] }, '$timestamp', null] } },
      } },
      { $match: { requested: { $ne: null }, resulted: { $ne: null } } },
    ]).toArray(),
  ]);
  const counts = Object.fromEntries(byType.map((r) => [r._id, r.count]));
  const ms = latencies.map((l) => Date.parse(l.resulted) - Date.parse(l.requested)).filter((x) => x >= 0).sort((a, b) => a - b);
  const pct = (p) => (ms.length ? ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)] : null);
  const requests = counts['ai.requests'] || 0;
  const results = counts['ai.results'] || 0;
  return {
    requests,
    results,
    approvals: counts['ai.approvals'] || 0,
    completion_rate: requests ? Math.round((results / requests) * 1000) / 1000 : null,
    debate_messages: {
      round_0: counts['debate.round.0'] || 0,
      round_1: counts['debate.round.1'] || 0,
      round_2: counts['debate.round.2'] || 0,
    },
    latency_ms: { completed: ms.length, median: median(ms), p95: pct(95), max: ms.length ? ms[ms.length - 1] : null },
  };
}

// ---------------------------------------------------------------- ingest
/** Store events, deduped on event_id. Returns how many were new. */
async function storeEvents(envs) {
  if (!envs.length) return 0;
  const res = await (await events()).bulkWrite(envs.map((env) => ({
    updateOne: {
      filter: { event_id: env.event_id },
      update: { $setOnInsert: { ...env, source: 'ingest', received_at: new Date() } },
      upsert: true,
    },
  })), { ordered: false });
  return res.upsertedCount;
}

module.exports = { platform, trace, host, funnel, guest, top, geo, ai, storeEvents, fillDays, median, toSteps };
