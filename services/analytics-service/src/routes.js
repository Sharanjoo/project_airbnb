// Analytics and Logging Service (API doc §8). Owner: Slice 4.
// Dashboards must be computed from MySQL + Mongo events/traces, never static samples.
//
// Every GET takes ?days=N (1..365, default 30): the window is the last N days
// including today (UTC). Answers are { data, trace_id } with `window` echoed back.
//
//   POST /events/ingest              admin   store envelopes; invalid ones -> <event_type>.dlq
//   GET  /analytics/properties/top   signed in  ?metric=bookings|revenue|views|rating&limit=10
//   GET  /analytics/funnel           host    viewed -> saved -> requested -> confirmed -> completed (?property_id=)
//   GET  /analytics/geo              admin   listings, bookings, revenue per city
//   GET  /analytics/host/dashboard   host    occupancy, revenue, cancellations, rating trend, response time
//   GET  /analytics/guest/dashboard  guest   bookings over time, status summary, saved, reviews, AI use
//   GET  /analytics/platform         admin   users, listings, bookings, revenue, events by type
//   GET  /analytics/ai               admin   AI requests, results, debate rounds, request->result latency
//   GET  /traces/{trace_id}          admin, or a user who took part in that journey
const express = require('express');
const Joi = require('joi');
const {
  asyncHandler, validateBody, requireRole, ok, Errors, AppError, validateEnvelope, dlqTopic, TOPICS, logger,
} = require('@airbnb/common');
const defaultStats = require('./models/stats');

const KNOWN_TOPICS = new Set(Object.values(TOPICS));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (t) => new Date(t).toISOString().slice(0, 10);

const windowFields = { days: Joi.number().integer().min(1).max(365).default(30) };
const querySchemas = {
  window: Joi.object(windowFields),
  top: Joi.object({
    ...windowFields,
    metric: Joi.string().valid('bookings', 'revenue', 'views', 'rating').default('bookings'),
    limit: Joi.number().integer().min(1).max(50).default(10),
  }),
  funnel: Joi.object({ ...windowFields, property_id: Joi.string().max(40) }),
};
const ingestSchema = Joi.object({ events: Joi.array().items(Joi.object().unknown(true)).min(1).max(500).required() });

/** Validate req.query (strings are converted to numbers); unknown parameters are rejected like unknown body fields. */
function validateQuery(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query, { abortEarly: false, allowUnknown: false, convert: true });
    if (error) return next(Errors.validation(error.details.map((d) => ({ field: d.path.join('.'), issue: d.message }))));
    req.q = value;
    // the window ends at the end of today (UTC) and covers `days` whole days
    const until = Date.parse(`${day(Date.now())}T00:00:00Z`) + 86400000;
    req.q.window = { days: value.days, since: day(until - value.days * 86400000), until: day(until) };
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

/** Did this user take part in the journey? (acted in it, or it is about their booking) */
function tookPart(user, evs) {
  return evs.some((e) => e.actor_id === user.id
    || (e.payload && (e.payload.guest_id === user.id || e.payload.host_id === user.id || e.payload.user_id === user.id)));
}

function defaultDlq(bus) {
  return async (topic, env, reason) => {
    const producer = await bus.connectProducer();
    await producer.send({
      topic: dlqTopic(topic),
      messages: [{
        key: (env.entity && env.entity.entity_id) || env.trace_id || null,
        value: JSON.stringify(env),
        headers: { failure_reason: reason.slice(0, 1000), failed_at: new Date().toISOString(), consumer_group: 'analytics-ingest', source_topic: topic },
      }],
    });
  };
}

function buildRouter({ bus, stats = defaultStats, sendToDlq = defaultDlq(bus) }) {
  const r = express.Router();
  const window = validateQuery(querySchemas.window);

  r.post('/events/ingest', requireRole('admin'), validateBody(ingestSchema), asyncHandler(async (req, res) => {
    const valid = [];
    const rejected = [];
    for (const [index, env] of req.body.events.entries()) {
      const known = typeof env.event_type === 'string' && KNOWN_TOPICS.has(env.event_type);
      const check = known ? validateEnvelope(env, env.event_type) : { valid: false, errors: ['/event_type is not a known topic'] };
      if (check.valid) {
        valid.push(env);
        continue;
      }
      const reason = check.errors.join('; ');
      let dlq = null;
      if (known) {
        try {
          await sendToDlq(env.event_type, env, reason);
          dlq = dlqTopic(env.event_type);
        } catch (err) {
          logger.error('ingest DLQ write failed', { trace_id: req.traceId, error: err.message });
        }
      }
      rejected.push({ index, event_id: env.event_id ?? null, reason, dlq });
    }
    const stored = await db(() => stats.storeEvents(valid));
    return ok(res, { accepted: valid.length, stored, duplicates: valid.length - stored, rejected });
  }));

  r.get('/analytics/properties/top', requireRole('guest', 'host'), validateQuery(querySchemas.top), asyncHandler(async (req, res) => {
    const { metric, limit, window: w } = req.q;
    const items = await db(() => stats.top({ metric, limit, ...w }));
    return ok(res, { metric, window: w, items });
  }));

  r.get('/analytics/funnel', requireRole('host'), validateQuery(querySchemas.funnel), asyncHandler(async (req, res) => {
    const { property_id, window: w } = req.q;
    const result = await db(() => stats.funnel(req.user.id, { ...w, propertyId: property_id }));
    // a listing that is not yours looks like one that does not exist
    if (property_id && !result.property_ids.length) throw Errors.notFound('Property');
    return ok(res, { window: w, property_id: property_id || null, steps: result.steps });
  }));

  r.get('/analytics/geo', requireRole('admin'), window, asyncHandler(async (req, res) => {
    const items = await db(() => stats.geo(req.q.window));
    return ok(res, { window: req.q.window, items });
  }));

  r.get('/analytics/host/dashboard', requireRole('host'), window, asyncHandler(async (req, res) => {
    const data = await db(() => stats.host(req.user.id, req.q.window));
    return ok(res, { window: req.q.window, ...data });
  }));

  r.get('/analytics/guest/dashboard', requireRole('guest'), window, asyncHandler(async (req, res) => {
    const data = await db(() => stats.guest(req.user.id, req.q.window));
    return ok(res, { window: req.q.window, ...data });
  }));

  r.get('/analytics/platform', requireRole('admin'), window, asyncHandler(async (req, res) => {
    const data = await db(() => stats.platform(req.q.window));
    return ok(res, { window: req.q.window, ...data });
  }));

  r.get('/analytics/ai', requireRole('admin'), window, asyncHandler(async (req, res) => {
    const data = await db(() => stats.ai(req.q.window));
    return ok(res, { window: req.q.window, ...data });
  }));

  r.get('/traces/:traceId', requireRole('guest', 'host'), asyncHandler(async (req, res) => {
    const { traceId } = req.params;
    if (!UUID.test(traceId)) throw Errors.validation([{ field: 'trace_id', issue: 'must be a UUID' }]);
    const evs = await db(() => stats.trace(traceId));
    // Someone else's journey answers exactly like an unknown one.
    if (!evs.length || (req.user.role !== 'admin' && !tookPart(req.user, evs))) throw Errors.notFound('Trace');
    const first = Date.parse(evs[0].timestamp);
    const last = Date.parse(evs[evs.length - 1].timestamp);
    return ok(res, {
      trace_id: traceId,
      started_at: evs[0].timestamp,
      ended_at: evs[evs.length - 1].timestamp,
      duration_ms: last - first,
      event_count: evs.length,
      topics: [...new Set(evs.map((e) => e.event_type))],
      events: evs.map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        timestamp: e.timestamp,
        since_start_ms: Date.parse(e.timestamp) - first,
        actor_id: e.actor_id,
        actor_type: e.actor_type,
        entity: e.entity,
        payload: e.payload,
        kafka: e.kafka || null,
      })),
    });
  }));

  return r;
}

module.exports = { buildRouter, tookPart };
