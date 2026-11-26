// Analytics and Logging Service (API doc §8, examples in §13.6). Owner: Slice 4.
// Dashboards must be computed from MySQL + Mongo events/traces, never static samples.
//
//   POST /events/ingest              services, admin    one envelope or {events:[…]} (max 500) -> 202 {accepted, rejected, errors}
//   GET  /analytics/properties/top   signed in   metric=views|bookings|revenue|saves, from, to, city, limit (default 10)
//   GET  /analytics/funnel           host (own), admin   host_id or property_id, from, to
//   GET  /analytics/geo              admin       from, to, group_by=city|state
//   GET  /analytics/host/dashboard   host (self), admin  host_id, from, to
//   GET  /analytics/guest/dashboard  guest (self), admin guest_id, days (default 30)
//   GET  /analytics/platform         admin       from, to
//   GET  /analytics/ai               admin       from, to, version
//   GET  /traces/{trace_id}          admin, or a user who took part in that journey
//
// from / to: a date (2026-10-01, whole day; `to` is inclusive) or an ISO timestamp
// (2026-10-27T15:00:00Z, exact). Default: the last 30 days up to now. Max 366 days.
const express = require('express');
const Joi = require('joi');
const {
  asyncHandler, requireRole, ok, Errors, AppError, validateEnvelope, TOPICS, logger,
} = require('@airbnb/common');
const defaultStats = require('./models/stats');
const defaultKafka = require('./models/kafkaStats');

const KNOWN_TOPICS = new Set(Object.values(TOPICS));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const MAX_INGEST = 500;

const range = { from: Joi.string().isoDate(), to: Joi.string().isoDate() };
const id = Joi.string().max(40);
const querySchemas = {
  range: Joi.object(range),
  top: Joi.object({
    ...range,
    metric: Joi.string().valid('views', 'bookings', 'revenue', 'saves').default('bookings'),
    city: Joi.string().max(80),
    limit: Joi.number().integer().min(1).max(50).default(10),
  }),
  funnel: Joi.object({ ...range, host_id: id, property_id: id }),
  geo: Joi.object({ ...range, group_by: Joi.string().valid('city', 'state').default('city') }),
  host: Joi.object({ ...range, host_id: id }),
  guest: Joi.object({ guest_id: id, days: Joi.number().integer().min(1).max(365).default(30) }),
  ai: Joi.object({ ...range, version: Joi.string().max(60) }),
};

const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Build the window every query uses (see models/stats.js). */
function makeWindow(fromMs, toMs) {
  const toDayMs = Math.ceil(toMs / DAY_MS) * DAY_MS; // DATE columns: whole days covering the window
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    fromSql: sqlTime(fromMs),
    toSql: sqlTime(toMs),
    fromDay: dayOf(Math.floor(fromMs / DAY_MS) * DAY_MS),
    toDay: dayOf(toDayMs),
    minutes: (toMs - fromMs) / 60000,
  };
}

function rangeWindow({ from, to }) {
  const toMs = to ? Date.parse(to) + (DATE_ONLY.test(to) ? DAY_MS : 0) : Date.now();
  const fromMs = from ? Date.parse(from) : toMs - 30 * DAY_MS;
  if (fromMs >= toMs) throw Errors.validation([{ field: 'from', issue: 'must be before to' }]);
  if (toMs - fromMs > 366 * DAY_MS) throw Errors.validation([{ field: 'from', issue: 'range is at most 366 days' }]);
  return makeWindow(fromMs, toMs);
}

/** The last `days` whole days, today included (guest dashboard). */
function daysWindow(days) {
  const tomorrow = Math.floor(Date.now() / DAY_MS) * DAY_MS + DAY_MS;
  return makeWindow(tomorrow - days * DAY_MS, tomorrow);
}

/** Validate req.query; unknown parameters are rejected like unknown body fields. */
function validateQuery(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query, { abortEarly: false, allowUnknown: false, convert: true });
    if (error) return next(Errors.validation(error.details.map((d) => ({ field: d.path.join('.'), issue: d.message }))));
    // Joi's isoDate() rewrites "2026-10-31" to "2026-10-31T00:00:00.000Z"; keep what the caller
    // sent, because a plain date `to` means "through the end of that day"
    for (const k of ['from', 'to']) if (typeof req.query[k] === 'string') value[k] = req.query[k];
    req.q = value;
    next();
  };
}

/** Anything that is not one of our errors means a database is unavailable. */
async function db(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error('analytics query failed', { error: err.message });
    throw Errors.dependency('Analytics data store');
  }
}

const echo = (w) => ({ from: w.from, to: w.to });

function buildRouter({ bus, stats = defaultStats, kafka = defaultKafka }) { // eslint-disable-line no-unused-vars
  const r = express.Router();

  // ------------------------------------------------------------ ingest
  // Services and admins only (review on #11): a guest or host token could otherwise write
  // events into the dashboards. Services publish to Kafka; this is for batch backfills.
  r.post('/events/ingest', requireRole('service'), asyncHandler(async (req, res) => {
    const body = req.body;
    // one envelope (has event_type) or { events: [...] }; anything else is not an ingest request at all
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('events' in body || 'event_type' in body)) {
      throw Errors.validation([{ field: 'body', issue: 'must be one envelope or { events: [...] }' }]);
    }
    const list = 'events' in body ? body.events : [body];
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_INGEST) {
      throw Errors.validation([{ field: 'events', issue: `must be an array of 1 to ${MAX_INGEST} envelopes` }]);
    }
    const valid = [];
    const errors = [];
    const rejected = [];
    list.forEach((env, index) => {
      let issue = null;
      if (!env || typeof env !== 'object' || Array.isArray(env)) issue = '/ must be an object';
      else if (!KNOWN_TOPICS.has(env.event_type)) issue = '/event_type is not a known topic';
      else {
        const check = validateEnvelope(env, env.event_type);
        if (!check.valid) issue = check.errors.join('; ');
      }
      if (issue) {
        errors.push({ index, issue });
        rejected.push({ index, issue, envelope: env, caller: req.user.id, trace_id: req.traceId });
      } else valid.push(env);
    });
    // Rejected envelopes are kept for the platform's rejected-envelope count.
    // TODO(shared): also send them to events.dlq once the team adds that topic.
    await db(() => stats.storeRejected(rejected));
    const stored = await db(() => stats.storeEvents(valid));
    return ok(res, { accepted: valid.length, rejected: rejected.length, errors, duplicates: valid.length - stored }, 202);
  }));

  // ------------------------------------------------------------ top
  r.get('/analytics/properties/top', requireRole('guest', 'host'), validateQuery(querySchemas.top), asyncHandler(async (req, res) => {
    const { metric, city, limit } = req.q;
    const w = rangeWindow(req.q);
    const items = await db(() => stats.top({ metric, city, limit }, w));
    return ok(res, { metric, ...echo(w), city: city || null, items });
  }));

  // ------------------------------------------------------------ funnel
  r.get('/analytics/funnel', requireRole('host'), validateQuery(querySchemas.funnel), asyncHandler(async (req, res) => {
    const w = rangeWindow(req.q);
    let { host_id: hostId, property_id: propertyId } = req.q;
    if (propertyId) {
      const owner = await db(() => stats.propertyOwner(propertyId));
      if (!owner) throw Errors.notFound('Property');
      if (req.user.role !== 'admin' && owner !== req.user.id) throw Errors.forbidden();
      if (hostId && hostId !== owner) throw Errors.validation([{ field: 'host_id', issue: 'does not own property_id' }]);
    }
    if (req.user.role !== 'admin') {
      if (hostId && hostId !== req.user.id) throw Errors.forbidden();
      hostId = req.user.id;
    }
    const result = await db(() => stats.funnel({ hostId, propertyId }, w));
    return ok(res, { host_id: hostId || null, property_id: propertyId || null, ...echo(w), ...result });
  }));

  // ------------------------------------------------------------ geo
  r.get('/analytics/geo', requireRole('admin'), validateQuery(querySchemas.geo), asyncHandler(async (req, res) => {
    const w = rangeWindow(req.q);
    const items = await db(() => stats.geo({ groupBy: req.q.group_by }, w));
    return ok(res, { group_by: req.q.group_by, ...echo(w), items });
  }));

  // ------------------------------------------------------------ host / guest dashboards
  r.get('/analytics/host/dashboard', requireRole('host'), validateQuery(querySchemas.host), asyncHandler(async (req, res) => {
    const w = rangeWindow(req.q);
    const hostId = req.q.host_id || (req.user.role === 'admin' ? null : req.user.id);
    if (!hostId) throw Errors.validation([{ field: 'host_id', issue: 'is required for admins' }]);
    if (req.user.role !== 'admin' && hostId !== req.user.id) throw Errors.forbidden();
    const data = await db(() => stats.hostDashboard(hostId, w));
    return ok(res, { host_id: hostId, ...echo(w), ...data });
  }));

  r.get('/analytics/guest/dashboard', requireRole('guest'), validateQuery(querySchemas.guest), asyncHandler(async (req, res) => {
    const guestId = req.q.guest_id || (req.user.role === 'admin' ? null : req.user.id);
    if (!guestId) throw Errors.validation([{ field: 'guest_id', issue: 'is required for admins' }]);
    if (req.user.role !== 'admin' && guestId !== req.user.id) throw Errors.forbidden();
    const w = daysWindow(req.q.days);
    const data = await db(() => stats.guestDashboard(guestId, w));
    return ok(res, { guest_id: guestId, days: req.q.days, ...data });
  }));

  // ------------------------------------------------------------ platform / ai
  r.get('/analytics/platform', requireRole('admin'), validateQuery(querySchemas.range), asyncHandler(async (req, res) => {
    const w = rangeWindow(req.q);
    const [data, k] = await Promise.all([db(() => stats.platform(w)), kafka.snapshot()]);
    return ok(res, {
      ...echo(w),
      events_by_topic: data.events_by_topic,
      consumer_lag: k.consumer_lag,
      throughput_per_min: data.throughput_per_min,
      errors: data.errors,
      retries: data.retries,
      dlq_messages: k.dlq_messages,
      rejected_envelopes: data.rejected_envelopes,
      avg_workflow_latency_ms: data.avg_workflow_latency_ms,
      ...(k.kafka_error ? { kafka_error: k.kafka_error } : {}),
    });
  }));

  r.get('/analytics/ai', requireRole('admin'), validateQuery(querySchemas.ai), asyncHandler(async (req, res) => {
    const w = rangeWindow(req.q);
    const data = await db(() => stats.ai({ version: req.q.version }, w));
    return ok(res, { ...echo(w), ...data });
  }));

  // ------------------------------------------------------------ traces
  r.get('/traces/:traceId', requireRole('guest', 'host'), asyncHandler(async (req, res) => {
    const { traceId } = req.params;
    if (!UUID.test(traceId)) throw Errors.validation([{ field: 'trace_id', issue: 'must be a UUID' }]);
    const { steps, participants } = await db(() => stats.trace(traceId));
    // Someone else's journey answers exactly like an unknown one.
    if (!steps.length || (req.user.role !== 'admin' && !participants.has(req.user.id))) throw Errors.notFound('Trace');
    const first = Date.parse(steps[0].timestamp);
    const last = Date.parse(steps[steps.length - 1].timestamp);
    return ok(res, { trace_id: traceId, total_latency_ms: last - first, steps });
  }));

  return r;
}

module.exports = { buildRouter, rangeWindow, daysWindow };
