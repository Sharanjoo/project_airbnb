// Analytics queries (API doc §8 and the §13.6 examples). Everything is computed
// live from MySQL (users, listings, reservations), the MongoDB `events`
// collection that analytics-worker fills from every Kafka topic (one document
// per event, deduped on event_id), the `traces` collection (one document per
// workflow step, written by the services) and Mongo messages/reviews/ai data.
// No stored samples.
//
// Every function takes a window `w` built by the routes:
//   w.from / w.to        ISO timestamps (to exclusive), compared with event timestamps
//   w.fromSql / w.toSql  the same instants as MySQL DATETIME strings
//   w.fromDay / w.toDay  whole days (YYYY-MM-DD, toDay exclusive) for DATE columns
//   w.minutes            length of the window in minutes
const { getMysql, getMongo } = require('@airbnb/common');

const BOOKED = ['CONFIRMED', 'COMPLETED'];
const STATUSES = ['REQUESTED', 'CONFIRMED', 'DECLINED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'COMPLETED'];
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const round = (v, places) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 10 ** places) / 10 ** places);
const money = (v) => round(num(v), 2);
const ratio = (a, b) => (b ? round(a / b, 3) : null);
const q = async (sql, params) => (await getMysql().query(sql, params))[0];
const mongo = async (name) => (await getMongo()).collection(name);
const inWindow = (w) => ({ $gte: w.from, $lt: w.to });

/** Every day in [fromDay, toDay) with `blank()` where there is no row, so charts have no gaps. */
function fillDays(fromDay, toDay, byDay, blank) {
  const out = [];
  for (let t = Date.parse(`${fromDay}T00:00:00Z`); t < Date.parse(`${toDay}T00:00:00Z`); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    out.push({ date, ...(byDay.get(date) || blank()) });
  }
  return out;
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const average = (values) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : null);

// ---------------------------------------------------------------- funnel
const STEPS = ['viewed', 'saved', 'requested', 'confirmed', 'completed'];

/** Conversion between consecutive steps, named like the API doc example. */
function conversion(steps) {
  const out = {};
  for (let i = 1; i < STEPS.length; i++) out[`${STEPS[i - 1]}_to_${STEPS[i]}`] = ratio(steps[STEPS[i]], steps[STEPS[i - 1]]);
  return out;
}

/**
 * Listings in scope: one property, one host's listings, or (admin, no filter) all.
 * Returns rows { property_id, host_id }.
 */
async function scopeProperties({ hostId, propertyId }) {
  const where = ["status <> 'deleted'"];
  const params = [];
  if (hostId) { where.push('host_id = ?'); params.push(hostId); }
  if (propertyId) { where.push('property_id = ?'); params.push(propertyId); }
  return q(`SELECT property_id, host_id FROM properties WHERE ${where.join(' AND ')}`, params);
}

async function propertyOwner(propertyId) {
  const [row] = await q("SELECT host_id FROM properties WHERE property_id = ? AND status <> 'deleted'", [propertyId]);
  return row ? row.host_id : null;
}

/** viewed -> saved -> requested -> confirmed -> completed for these listings in the window. */
async function funnelCounts(ids, w) {
  if (!ids.length) return Object.fromEntries(STEPS.map((s) => [s, 0]));
  const ev = await mongo('events');
  const [viewed, saved, [r]] = await Promise.all([
    ev.countDocuments({ event_type: 'property.viewed', 'payload.property_id': { $in: ids }, timestamp: inWindow(w) }),
    ev.countDocuments({ event_type: 'property.saved', 'payload.property_id': { $in: ids }, 'payload.saved': true, timestamp: inWindow(w) }),
    // "confirmed" = ever confirmed, so a stay cancelled after confirmation still counts,
    // but a request the guest withdrew before the host answered does not
    q(`SELECT COUNT(*) AS requested,
              SUM(r.status IN (?) OR EXISTS (
                SELECT 1 FROM reservation_status_history h WHERE h.reservation_id = r.reservation_id AND h.to_status = 'CONFIRMED')) AS confirmed,
              SUM(r.status = 'COMPLETED') AS completed
       FROM reservations r WHERE r.property_id IN (?) AND r.booking_datetime >= ? AND r.booking_datetime < ?`, [BOOKED, ids, w.fromSql, w.toSql]),
  ]);
  return { viewed, saved, requested: num(r.requested), confirmed: num(r.confirmed), completed: num(r.completed) };
}

async function funnel({ hostId, propertyId }, w) {
  const props = await scopeProperties({ hostId, propertyId });
  const steps = await funnelCounts(props.map((p) => p.property_id), w);
  return { steps, conversion: conversion(steps) };
}

// ---------------------------------------------------------------- host dashboard
/** Minutes from a guest's first message in a thread to the host's first reply after it (API doc §8). */
async function responseMinutes(hostId, w) {
  const threads = await (await mongo('threads')).find({ host_id: hostId }, { projection: { _id: 1, guest_id: 1 } }).toArray();
  if (!threads.length) return [];
  const guestOf = new Map(threads.map((t) => [String(t._id), t.guest_id]));
  const msgs = await (await mongo('messages')).find(
    { thread_id: { $in: [...guestOf.keys()] } },
    { projection: { thread_id: 1, sender_id: 1, timestamp: 1 } },
  ).sort({ thread_id: 1, timestamp: 1 }).toArray();
  const first = new Map(); // thread -> { guestAt, hostAt }
  for (const m of msgs) {
    const t = String(m.thread_id);
    const at = new Date(m.timestamp).getTime();
    const s = first.get(t) || {};
    if (m.sender_id === guestOf.get(t) && s.guestAt === undefined) s.guestAt = at;
    else if (m.sender_id === hostId && s.guestAt !== undefined && s.hostAt === undefined) s.hostAt = at;
    first.set(t, s);
  }
  const from = Date.parse(w.from);
  const to = Date.parse(w.to);
  return [...first.values()]
    .filter((s) => s.hostAt !== undefined && s.guestAt >= from && s.guestAt < to)
    .map((s) => (s.hostAt - s.guestAt) / 60000);
}

async function hostDashboard(hostId, w) {
  const listings = await q("SELECT property_id, nightly_price, status FROM properties WHERE host_id = ? AND status <> 'deleted'", [hostId]);
  const active = listings.filter((l) => l.status === 'active');
  const ids = listings.map((l) => l.property_id);
  const activeIds = active.map((l) => l.property_id);
  const days = Math.round((Date.parse(`${w.toDay}T00:00:00Z`) - Date.parse(`${w.fromDay}T00:00:00Z`)) / 86400000);

  const [revenueRows, [booked], [blocked], [cancels], responses, trend, steps] = await Promise.all([
    // revenue is earned per night: each booked night carries total_price / nights
    ids.length ? q(`SELECT rn.night AS date, SUM(r.total_price / DATEDIFF(r.check_out, r.check_in)) AS revenue
       FROM reservation_nights rn JOIN reservations r ON r.reservation_id = rn.reservation_id
       WHERE r.host_id = ? AND r.status IN (?) AND rn.night >= ? AND rn.night < ?
       GROUP BY rn.night`, [hostId, BOOKED, w.fromDay, w.toDay]) : [],
    activeIds.length ? q(`SELECT COUNT(*) AS n FROM reservation_nights rn JOIN reservations r ON r.reservation_id = rn.reservation_id
       WHERE r.property_id IN (?) AND r.status IN (?) AND rn.night >= ? AND rn.night < ?`, [activeIds, BOOKED, w.fromDay, w.toDay]) : [{ n: 0 }],
    // nights the host blocked inside the window are not available
    activeIds.length ? q(`SELECT COALESCE(SUM(DATEDIFF(LEAST(end_date, ?), GREATEST(start_date, ?))), 0) AS n
       FROM availability_blocks WHERE property_id IN (?) AND status = 'blocked' AND source = 'host'
         AND start_date < ? AND end_date > ?`, [w.toDay, w.fromDay, activeIds, w.toDay, w.fromDay]) : [{ n: 0 }],
    q(`SELECT COUNT(DISTINCT h.reservation_id) AS n FROM reservation_status_history h
       JOIN reservations r ON r.reservation_id = h.reservation_id
       WHERE r.host_id = ? AND h.to_status = 'CANCELLED' AND h.at >= ? AND h.at < ?`, [hostId, w.fromSql, w.toSql]),
    responseMinutes(hostId, w),
    // monthly average rating over the 6 months ending at the window's end
    (await mongo('reviews')).aggregate([
      { $match: { host_id: hostId, created_datetime: { $gte: new Date(Date.parse(w.to) - 183 * 86400000).toISOString(), $lt: w.to } } },
      { $group: { _id: { $substr: ['$created_datetime', 0, 7] }, rating: { $avg: '$rating' } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    funnelCounts(ids, w),
  ]);

  const available = active.length * days - num(blocked.n);
  const byDay = new Map(revenueRows.map((r) => [String(r.date).slice(0, 10), { revenue: money(r.revenue) }]));
  const revenueByDay = fillDays(w.fromDay, w.toDay, byDay, () => ({ revenue: 0 }));
  const med = median(responses);
  return {
    occupancy_rate: available > 0 ? round(num(booked.n) / available, 3) : null,
    avg_nightly_price: active.length ? money(active.reduce((s, l) => s + Number(l.nightly_price), 0) / active.length) : null,
    revenue_total: money(revenueRows.reduce((s, r) => s + Number(r.revenue), 0)),
    revenue_by_day: revenueByDay,
    cancellations: num(cancels.n),
    rating_trend: trend.map((t) => ({ month: t._id, rating: round(t.rating, 2) })),
    median_response_minutes: med === null ? null : round(med, 1),
    funnel: steps,
  };
}

// ---------------------------------------------------------------- guest dashboard
async function guestDashboard(guestId, w) {
  const [perDay, statusRows] = await Promise.all([
    q(`SELECT DATE(booking_datetime) AS date, COUNT(*) AS count FROM reservations
       WHERE guest_id = ? AND booking_datetime >= ? AND booking_datetime < ? GROUP BY DATE(booking_datetime)`, [guestId, w.fromSql, w.toSql]),
    q(`SELECT status, COUNT(*) AS n FROM reservations
       WHERE guest_id = ? AND booking_datetime >= ? AND booking_datetime < ? GROUP BY status`, [guestId, w.fromSql, w.toSql]),
  ]);
  const ev = await mongo('events');
  const [saves, requests, approvals] = await Promise.all([
    ev.find({ event_type: 'property.saved', 'payload.guest_id': guestId, timestamp: inWindow(w) }, { projection: { _id: 0, timestamp: 1, 'payload.saved': 1 } }).toArray(),
    ev.find({ event_type: 'ai.requests', actor_id: guestId, timestamp: inWindow(w) }, { projection: { _id: 0, trace_id: 1 } }).toArray(),
    ev.find({ event_type: 'ai.approvals', timestamp: inWindow(w), $or: [{ actor_id: guestId }, { 'payload.reviewer_id': guestId }] },
      { projection: { _id: 0, 'payload.decision': 1 } }).toArray(),
  ]);
  // match score = the recommended property's score in the Chair's result (§9) for this guest's requests
  const results = requests.length
    ? await ev.find({ event_type: 'ai.results', trace_id: { $in: requests.map((r) => r.trace_id) } }, { projection: { _id: 0, 'payload.recommended.score': 1 } }).toArray()
    : [];
  const scores = results.map((r) => r.payload?.recommended?.score).filter((s) => typeof s === 'number');

  const savedByDay = new Map();
  for (const s of saves) {
    const d = s.timestamp.slice(0, 10);
    const cur = savedByDay.get(d) || { saved: 0, unsaved: 0 };
    if (s.payload?.saved) cur.saved++; else cur.unsaved++;
    savedByDay.set(d, cur);
  }
  const statusSummary = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of statusRows) statusSummary[r.status] = num(r.n);
  const decisions = { approved: 0, edited: 0, rejected: 0 };
  for (const a of approvals) {
    const d = String(a.payload?.decision || '').toLowerCase();
    if (d in decisions) decisions[d]++;
  }
  return {
    bookings_per_day: fillDays(w.fromDay, w.toDay, new Map(perDay.map((r) => [String(r.date).slice(0, 10), { count: num(r.count) }])), () => ({ count: 0 })),
    status_summary: statusSummary,
    saved_activity: fillDays(w.fromDay, w.toDay, savedByDay, () => ({ saved: 0, unsaved: 0 })),
    avg_match_score: round(average(scores), 3),
    recommendation_approvals: decisions,
  };
}

// ---------------------------------------------------------------- top properties
async function top({ metric, city, limit }, w) {
  let cityIds = null;
  if (city) cityIds = (await q("SELECT property_id FROM properties WHERE city = ? AND status <> 'deleted'", [city])).map((r) => r.property_id);
  if (cityIds && !cityIds.length) return [];

  let ranked; // [{ property_id, value }]
  if (metric === 'bookings' || metric === 'revenue') {
    const agg = metric === 'bookings' ? 'COUNT(*)' : 'SUM(total_price)';
    const rows = await q(`SELECT property_id, ${agg} AS value FROM reservations
      WHERE status IN (?) AND booking_datetime >= ? AND booking_datetime < ? ${cityIds ? 'AND property_id IN (?)' : ''}
      GROUP BY property_id ORDER BY value DESC, property_id LIMIT ?`,
    cityIds ? [BOOKED, w.fromSql, w.toSql, cityIds, limit] : [BOOKED, w.fromSql, w.toSql, limit]);
    ranked = rows.map((r) => ({ property_id: r.property_id, value: metric === 'revenue' ? money(r.value) : num(r.value) }));
  } else {
    const match = { event_type: metric === 'views' ? 'property.viewed' : 'property.saved', timestamp: inWindow(w) };
    if (metric === 'saves') match['payload.saved'] = true;
    if (cityIds) match['payload.property_id'] = { $in: cityIds };
    const rows = await (await mongo('events')).aggregate([
      { $match: match },
      { $group: { _id: '$payload.property_id', value: { $sum: 1 } } },
      { $sort: { value: -1, _id: 1 } },
      { $limit: limit },
    ]).toArray();
    ranked = rows.map((r) => ({ property_id: r._id, value: r.value }));
  }
  if (!ranked.length) return [];
  const titles = await q('SELECT property_id, title FROM properties WHERE property_id IN (?)', [ranked.map((r) => r.property_id)]);
  const byId = new Map(titles.map((t) => [t.property_id, t.title]));
  return ranked.map((r) => ({ property_id: r.property_id, title: byId.get(r.property_id) ?? null, value: r.value }));
}

// ---------------------------------------------------------------- geo (admin)
async function geo({ groupBy }, w) {
  const col = groupBy === 'state' ? 'state' : 'city'; // whitelisted by the route
  const [prices, bookings] = await Promise.all([
    q(`SELECT ${col} AS region, AVG(nightly_price) AS avg_price FROM properties WHERE status = 'active' GROUP BY ${col}`),
    q(`SELECT p.${col} AS region, COUNT(*) AS bookings FROM reservations r JOIN properties p ON p.property_id = r.property_id
       WHERE r.status IN (?) AND r.booking_datetime >= ? AND r.booking_datetime < ? GROUP BY p.${col}`, [BOOKED, w.fromSql, w.toSql]),
  ]);
  const booked = new Map(bookings.map((b) => [b.region, num(b.bookings)]));
  // searches: no service publishes a search event yet (asked Sharan); null means "not measured", not zero
  return prices
    .map((p) => ({ region: p.region, searches: null, bookings: booked.get(p.region) || 0, avg_price: money(p.avg_price) }))
    .sort((a, b) => b.bookings - a.bookings || String(a.region).localeCompare(String(b.region)));
}

// ---------------------------------------------------------------- platform (admin)
/** Classify a trace by the event that started it. */
function workflowOf(types) {
  if (types.includes('ai.requests')) return 'ai_recommendation';
  if (types.includes('booking.requested')) return 'booking';
  return null;
}

async function platform(w) {
  const db = await getMongo();
  const [byTopic, total, traceSpans, stepStatus, rejected] = await Promise.all([
    db.collection('events').aggregate([
      { $match: { timestamp: inWindow(w) } },
      { $group: { _id: '$event_type', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    db.collection('events').countDocuments({ timestamp: inWindow(w) }),
    // workflow latency = last step - first step of each trace (events and trace steps together)
    db.collection('events').aggregate([
      { $match: { timestamp: inWindow(w) } },
      { $project: { trace_id: 1, timestamp: 1, event_type: 1 } },
      { $unionWith: { coll: 'traces', pipeline: [{ $match: { timestamp: inWindow(w) } }, { $project: { trace_id: 1, timestamp: 1, event_type: 1 } }] } },
      { $group: { _id: '$trace_id', first: { $min: '$timestamp' }, last: { $max: '$timestamp' }, types: { $addToSet: '$event_type' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ]).toArray(),
    db.collection('traces').aggregate([
      { $match: { timestamp: inWindow(w), status: { $in: ['error', 'retry'] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).toArray(),
    db.collection('rejected_envelopes').countDocuments({ received_at: { $gte: new Date(w.from), $lt: new Date(w.to) } }),
  ]);
  const latency = { booking: [], ai_recommendation: [] };
  for (const t of traceSpans) {
    const kind = workflowOf(t.types);
    if (kind) latency[kind].push(Date.parse(t.last) - Date.parse(t.first));
  }
  const status = Object.fromEntries(stepStatus.map((s) => [s._id, s.count]));
  return {
    events_by_topic: Object.fromEntries(byTopic.map((r) => [r._id, r.count])),
    throughput_per_min: w.minutes ? round(total / w.minutes, 1) : null,
    errors: status.error || 0,
    retries: status.retry || 0,
    rejected_envelopes: rejected,
    avg_workflow_latency_ms: {
      booking: latency.booking.length ? Math.round(average(latency.booking)) : null,
      ai_recommendation: latency.ai_recommendation.length ? Math.round(average(latency.ai_recommendation)) : null,
    },
  };
}

// ---------------------------------------------------------------- ai (admin)
async function ai({ version }, w) {
  const db = await getMongo();
  const ev = db.collection('events');
  const reqMatch = { event_type: 'ai.requests', timestamp: inWindow(w) };
  if (version) reqMatch['payload.config_version'] = version;
  const requests = await ev.find(reqMatch, { projection: { _id: 0, trace_id: 1, timestamp: 1 } }).toArray();
  const traceIds = requests.map((r) => r.trace_id);
  const startOf = new Map(requests.map((r) => [r.trace_id, Date.parse(r.timestamp)]));
  const debate = traceIds.length
    ? await ev.find({ trace_id: { $in: traceIds }, event_type: { $in: ['debate.round.0', 'debate.round.1', 'debate.round.2', 'ai.results', 'ai.approvals'] } },
      { projection: { _id: 0, trace_id: 1, event_type: 1, timestamp: 1, payload: 1 } }).toArray()
    : [];

  const disagreements = [];
  let challenges = 0;
  const votes = { keep: 0, switch: 0, abstain: 0 };
  const approvals = { approved: 0, edited: 0, rejected: 0 };
  let results = 0;
  let withDissent = 0;
  const firstPublish = new Map(); // `${trace}|${agent}` -> ms after the request
  const verdictMs = [];
  for (const e of debate) {
    const p = e.payload || {};
    const after = Date.parse(e.timestamp) - startOf.get(e.trace_id);
    if (e.event_type === 'debate.round.0' && p.agent) {
      const k = `${e.trace_id}|${p.agent}`;
      if (!firstPublish.has(k) || after < firstPublish.get(k)) firstPublish.set(k, after);
    } else if (e.event_type === 'debate.round.1') {
      if (typeof p.disagreement_score === 'number') disagreements.push(p.disagreement_score);
      challenges += Array.isArray(p.challenges) ? p.challenges.length : 0;
    } else if (e.event_type === 'debate.round.2') {
      const choice = p.vote && p.vote.choice;
      if (choice in votes) votes[choice]++;
    } else if (e.event_type === 'ai.results') {
      results++;
      if (Array.isArray(p.dissent) && p.dissent.length) withDissent++;
      verdictMs.push(after);
    } else if (e.event_type === 'ai.approvals') {
      const d = String(p.decision || '').toLowerCase();
      if (d in approvals) approvals[d]++;
    }
  }
  const perAgent = {};
  for (const [k, ms] of firstPublish) {
    const agent = k.split('|')[1];
    (perAgent[agent] = perAgent[agent] || []).push(ms);
  }
  const timeline = Object.fromEntries(Object.entries(perAgent).map(([a, list]) => [a, Math.round(average(list))]));
  timeline.verdict = verdictMs.length ? Math.round(average(verdictMs)) : null;

  // precision@10 / recall@10 come from the evaluated config version (§11 agent_versions)
  const versions = db.collection('agent_versions');
  const v = version ? await versions.findOne({ version_id: version }) : await versions.find({ status: 'promoted' }).sort({ created_at: -1 }).limit(1).next();
  const metric = (doc, a, b) => (doc ? (doc[a] ?? doc[b] ?? null) : null);

  return {
    version: v ? v.version_id : version || null,
    tasks: requests.length,
    avg_disagreement: round(average(disagreements), 2),
    challenges,
    votes,
    dissent_rate: ratio(withDissent, results),
    precision_at_10: metric(v, 'precision_at_10', 'precision@10'),
    recall_at_10: metric(v, 'recall_at_10', 'recall@10'),
    approvals,
    publication_timeline_ms: timeline,
  };
}

// ---------------------------------------------------------------- traces
// Which service produces each topic (API doc §10 topic catalog), for steps built from events.
const PRODUCER = [
  [/^user\./, 'user-service'],
  [/^(property|availability)\./, 'property-service'],
  [/^booking\.(requested|approved|declined|cancel_requested)$/, 'booking-service'],
  [/^(booking|payment)\./, 'booking-worker'],
  [/^message\./, 'messaging-service'],
  [/^review\./, 'review-service'],
  [/^(ai|debate)\./, 'ai-service'],
];
const producerOf = (type) => (PRODUCER.find(([re]) => re.test(type)) || [null, 'unknown'])[1];

/**
 * Steps of one journey, oldest first: trace documents the services wrote, plus one
 * step per Kafka event (service = producer; latency_ms = delay until analytics consumed it).
 * Returns { steps, participants } so the route can check who may see it.
 */
async function trace(traceId) {
  const db = await getMongo();
  const [docs, evs] = await Promise.all([
    db.collection('traces').find({ trace_id: traceId }, { projection: { _id: 0 } }).sort({ timestamp: 1 }).limit(1000).toArray(),
    db.collection('events').find({ trace_id: traceId }, { projection: { _id: 0 } }).sort({ timestamp: 1 }).limit(1000).toArray(),
  ]);
  const steps = [
    ...docs.map((d) => ({
      service: d.service, event_type: d.event_type, step: d.step ?? null, timestamp: d.timestamp,
      latency_ms: d.latency_ms ?? null, status: d.status || 'ok', error: d.error ?? null,
    })),
    ...evs.map((e) => ({
      service: producerOf(e.event_type), event_type: e.event_type, step: 'published', timestamp: e.timestamp,
      latency_ms: e.received_at ? Math.max(0, new Date(e.received_at).getTime() - Date.parse(e.timestamp)) : null,
      status: 'ok', error: null,
    })),
  ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const participants = new Set();
  for (const e of evs) {
    for (const id of [e.actor_id, e.payload?.guest_id, e.payload?.host_id, e.payload?.user_id, e.payload?.reviewer_id]) if (id) participants.add(id);
  }
  return { steps, participants };
}

// ---------------------------------------------------------------- ingest
/** Store events, deduped on event_id. Returns how many were new. */
async function storeEvents(envs) {
  if (!envs.length) return 0;
  const res = await (await mongo('events')).bulkWrite(envs.map((env) => ({
    updateOne: {
      filter: { event_id: env.event_id },
      update: { $setOnInsert: { ...env, source: 'ingest', received_at: new Date() } },
      upsert: true,
    },
  })), { ordered: false });
  return res.upsertedCount;
}

/** Keep rejected envelopes so /analytics/platform can count them (rejected-envelope total). */
async function storeRejected(items) {
  if (!items.length) return;
  await (await mongo('rejected_envelopes')).insertMany(items.map((i) => ({ ...i, received_at: new Date() })));
}

module.exports = {
  funnel, propertyOwner, hostDashboard, guestDashboard, top, geo, platform, ai, trace, storeEvents, storeRejected,
  fillDays, median, conversion, producerOf, STATUSES,
};
