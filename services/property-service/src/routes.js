// Property Service (API doc §4). Owner: Slice 2.
// Owns listings, availability (optimistic lock, 13.3), saved properties,
// and the Redis search cache with invalidation (13.9).
const express = require('express');
const Joi = require('joi');
const {
  asyncHandler, validateBody, requireRole, ok, Errors, AppError, createEnvelope, newId, TOPICS, logger,
} = require('@airbnb/common');
const defaultRepo = require('./models/property');
const defaultAvailability = require('./models/availability');
const defaultSaved = require('./models/saved');
const defaultCache = require('./cache');
const { STRATEGIES } = require('./search/strategies');

const DEFAULT_STRATEGY = process.env.SEARCH_STRATEGY || 'mysql';
const PUBLISH_WAIT_MS = Number(process.env.PUBLISH_WAIT_MS || 2000);
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const PROPERTY_TYPES = ['entire_home', 'apartment', 'private_room', 'shared_room', 'cabin', 'condo'];
const AMENITIES = ['wifi', 'kitchen', 'parking', 'washer', 'ac', 'heating', 'pool', 'pet_friendly', 'workspace', 'self_checkin'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------- validation (API doc §4)
const fields = {
  title: Joi.string().trim().min(5).max(100),
  description: Joi.string().trim().min(1).max(5000),
  property_type: Joi.string().valid(...PROPERTY_TYPES),
  capacity: Joi.number().integer().min(1).max(16),
  bedrooms: Joi.number().integer().min(0).max(10),
  bathrooms: Joi.number().min(0.5).max(10).multiple(0.5),
  amenities: Joi.array().items(Joi.string().valid(...AMENITIES)).unique(),
  pet_friendly: Joi.boolean(),
  nightly_price: Joi.number().min(10).max(5000).precision(2),
  cleaning_fee: Joi.number().min(0).max(500).precision(2),
};
const address = {
  line1: Joi.string().trim().min(1).max(200),
  city: Joi.string().trim().min(1).max(80),
  state: Joi.string().trim().min(2).max(40),
  zip: Joi.string().trim().pattern(/^\d{5}(-\d{4})?$/),
  lat: Joi.number().min(-90).max(90),
  lng: Joi.number().min(-180).max(180),
};

const createSchema = Joi.object({
  title: fields.title.required(),
  description: fields.description.required(),
  property_type: fields.property_type.required(),
  address: Joi.object({
    line1: address.line1.required(),
    city: address.city.required(),
    state: address.state.required(),
    zip: address.zip.required(),
    lat: address.lat,
    lng: address.lng,
  }).required(),
  capacity: fields.capacity.required(),
  bedrooms: fields.bedrooms.required(),
  bathrooms: fields.bathrooms.required(),
  amenities: fields.amenities.required(),
  nightly_price: fields.nightly_price.required(),
  cleaning_fee: fields.cleaning_fee.default(0),
  pet_friendly: fields.pet_friendly.default(false),
});

const updateSchema = Joi.object({
  property_id: Joi.string().required(),
  version: Joi.number().integer().min(1).required(),
  ...fields,
  address: Joi.object(address).min(1),
  status: Joi.string().valid('active', 'inactive'), // deletion goes through /properties/delete
}).min(3); // property_id + version + at least one change

const idSchema = Joi.object({ property_id: Joi.string().required() });

const searchSchema = Joi.object({
  location: Joi.object({
    city: Joi.string().trim().max(80),
    lat: Joi.number().min(-90).max(90),
    lng: Joi.number().min(-180).max(180),
    radius_km: Joi.number().min(0).max(200),
  }).and('lat', 'lng'),
  check_in: Joi.string().pattern(DATE),
  check_out: Joi.string().pattern(DATE),
  guests: Joi.number().integer().min(1).max(16),
  price_min: Joi.number().min(0),
  price_max: Joi.number().min(0),
  property_types: Joi.array().items(Joi.string().valid(...PROPERTY_TYPES)).unique(),
  amenities: Joi.array().items(Joi.string().valid(...AMENITIES)).unique(),
  pet_friendly: Joi.boolean(),
  min_rating: Joi.number().min(0).max(5),
  host_id: Joi.string(), // a host listing their own properties (inactive included when it is the caller)
  sort: Joi.string().valid('price_asc', 'price_desc', 'rating_desc', 'newest').default('price_asc'),
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number().integer().min(1).max(100).default(20),
}).and('check_in', 'check_out');

const saveSchema = Joi.object({ property_id: Joi.string().required(), saved: Joi.boolean().required() });

const availabilitySchema = Joi.object({
  property_id: Joi.string().required(),
  action: Joi.string().valid('get', 'block', 'unblock').default('get'),
  start_date: Joi.string().pattern(DATE),
  end_date: Joi.string().pattern(DATE),
  availability_id: Joi.string(),
  expected_version: Joi.number().integer().min(1),
})
  .when(Joi.object({ action: Joi.valid('block').required() }).unknown(), {
    then: Joi.object({
      start_date: Joi.required(), end_date: Joi.required(), expected_version: Joi.required(), availability_id: Joi.forbidden(),
    }),
  })
  .when(Joi.object({ action: Joi.valid('unblock').required() }).unknown(), {
    then: Joi.object({ availability_id: Joi.required(), expected_version: Joi.required() }),
  });

/** Joi cannot compare two date strings for us; do it here with a field-level error. */
function assertRange(start, end, { startField, endField, notPast = false, maxDays = 365 }) {
  if (end <= start) throw Errors.validation([{ field: endField, issue: `must be after ${startField}` }]);
  if (notPast && start < today()) throw Errors.validation([{ field: startField, issue: 'must be today or later' }]);
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  if (days > maxDays) throw Errors.validation([{ field: endField, issue: `range is limited to ${maxDays} days` }]);
}

// ---------------------------------------------------------------- helpers
function assertOwner(req, row) {
  if (req.user.role !== 'admin' && row.host_id !== req.user.id) {
    throw Errors.forbidden('You can only change your own listings.');
  }
}

function buildRouter({
  bus, repo = defaultRepo, availability = defaultAvailability, saved = defaultSaved, cache = defaultCache, strategies = STRATEGIES,
}) {
  const r = express.Router();

  /**
   * Publish a property event. The database write has already committed, so a
   * Kafka failure is logged rather than returned: retrying the HTTP call would
   * create a second listing. (A transactional outbox would close this gap.)
   * We wait at most PUBLISH_WAIT_MS so a slow or down broker cannot stall the
   * host's request; the send keeps retrying in the background.
   */
  async function publish(req, topic, row, extraPayload, idempotencyKey) {
    const env = createEnvelope({
      eventType: topic,
      traceId: req.traceId,
      actorId: req.user ? req.user.id : 'anonymous',
      actorType: req.user ? req.user.role : 'system',
      entityType: 'property',
      entityId: row.property_id,
      idempotencyKey,
      payload: { property_id: row.property_id, ...extraPayload },
    });
    const sending = Promise.resolve()
      .then(() => bus.publish(topic, env, row.property_id)) // key = property_id
      .then(() => true)
      .catch((err) => {
        logger.error('event publish failed', { topic, trace_id: req.traceId, property_id: row.property_id, error: err.message });
        return false;
      });
    const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), PUBLISH_WAIT_MS).unref());
    if ((await Promise.race([sending, timedOut])) === 'timeout') {
      logger.warn('event publish still pending, not blocking the response', { topic, trace_id: req.traceId, property_id: row.property_id });
    }
  }

  // ---- create
  r.post('/properties/create', requireRole('host'), validateBody(createSchema), asyncHandler(async (req, res) => {
    const property = { ...req.body, property_id: newId('prp'), host_id: req.user.id };
    const row = await repo.insert(property);
    await cache.invalidateProperty(row.property_id); // a new listing can appear in cached searches
    await publish(req, TOPICS.PROPERTY_CREATED, row, {
      host_id: row.host_id, changed_fields: [], nightly_price: Number(row.nightly_price), status: row.status,
    }, `${row.property_id}:v${row.version}`);
    return ok(res, repo.toApi(row), 201);
  }));

  // ---- get (public)
  r.post('/properties/get', validateBody(idSchema), asyncHandler(async (req, res) => {
    const row = await repo.findByIdAnyStatus(req.body.property_id);
    if (!row) throw Errors.notFound('Property');
    if (row.status === 'deleted') throw Errors.gone();

    // Analytics event: fire and forget, never slows down or fails the page view.
    publish(req, TOPICS.PROPERTY_VIEWED, row, {
      viewer_id: req.user ? req.user.id : null,
      source: ['search', 'ai', 'direct'].includes(req.get('X-View-Source')) ? req.get('X-View-Source') : 'direct',
    }).catch(() => {});

    return ok(res, repo.toApi(row));
  }));

  // ---- update (optimistic lock on `version`)
  r.post('/properties/update', requireRole('host'), validateBody(updateSchema), asyncHandler(async (req, res) => {
    const { property_id, version, ...changes } = req.body;

    const current = await repo.findByIdAnyStatus(property_id);
    if (!current) throw Errors.notFound('Property');
    if (current.status === 'deleted') throw Errors.gone();
    assertOwner(req, current);

    const { updated, row } = await repo.updateWithVersion(property_id, version, changes);
    if (!updated) {
      if (!row) throw Errors.notFound('Property');
      if (row.status === 'deleted') throw Errors.gone();
      throw new AppError(409, 'VERSION_CONFLICT',
        `Property ${property_id} was changed by someone else.`,
        { details: [{ field: 'version', issue: `current version is ${row.version}` }], retryable: true });
    }

    // Invalidate first: the next search must not see the old price, even if Kafka is slow.
    await cache.invalidateProperty(property_id);
    await publish(req, TOPICS.PROPERTY_UPDATED, row, {
      host_id: row.host_id, changed_fields: Object.keys(changes), nightly_price: Number(row.nightly_price), status: row.status,
    }, `${row.property_id}:v${row.version}`);
    return ok(res, repo.toApi(row));
  }));

  // ---- delete (soft)
  r.post('/properties/delete', requireRole('host'), validateBody(idSchema), asyncHandler(async (req, res) => {
    const current = await repo.findByIdAnyStatus(req.body.property_id);
    if (!current) throw Errors.notFound('Property');
    assertOwner(req, current);
    if (current.status === 'deleted') {
      return ok(res, { property_id: current.property_id, status: 'deleted' }); // idempotent
    }

    const upcoming = await repo.countUpcomingBookings(current.property_id);
    if (upcoming > 0) {
      throw Errors.conflict('INVALID_STATE_TRANSITION', `Property has ${upcoming} upcoming booking${upcoming > 1 ? 's' : ''}.`);
    }

    await repo.softDelete(current.property_id);
    const row = await repo.findByIdAnyStatus(current.property_id);
    await cache.invalidateProperty(row.property_id);
    await publish(req, TOPICS.PROPERTY_UPDATED, row, {
      host_id: row.host_id, changed_fields: ['status'], nightly_price: Number(row.nightly_price), status: 'deleted',
    }, `${row.property_id}:v${row.version}`);
    return ok(res, { property_id: row.property_id, status: 'deleted' });
  }));

  // ---- search (two strategies, Redis cache-aside; features 13.8 and 13.9)
  // Headers for experiments and demos:
  //   X-Search-Strategy: mysql | mongo   (default from SEARCH_STRATEGY, else mysql)
  //   X-Cache-Mode: bypass               (skip the cache, measure the raw strategy)
  r.post('/properties/search', validateBody(searchSchema), asyncHandler(async (req, res) => {
    const f = req.body;
    if (f.check_in) assertRange(f.check_in, f.check_out, { startField: 'check_in', endField: 'check_out', notPast: true, maxDays: 30 });
    if (f.price_min !== undefined && f.price_max !== undefined && f.price_max < f.price_min) {
      throw Errors.validation([{ field: 'price_max', issue: 'must be greater than or equal to price_min' }]);
    }

    const strategy = (req.get('X-Search-Strategy') || DEFAULT_STRATEGY).toLowerCase();
    if (!strategies[strategy]) {
      throw Errors.validation([{ field: 'X-Search-Strategy', issue: `must be one of ${Object.keys(strategies).join(', ')}` }]);
    }
    // A host looking at their own listings also sees inactive ones; that view is never cached.
    const ownerView = Boolean(f.host_id && req.user && (req.user.id === f.host_id || req.user.role === 'admin'));
    const bypass = ownerView || (req.get('X-Cache-Mode') || '').toLowerCase() === 'bypass';

    const started = process.hrtime.bigint();
    let out;
    try {
      out = await cache.cachedSearch(strategy, f, () => strategies[strategy](f, { ownerView }), { bypass });
    } catch (err) {
      logger.error('search failed', { trace_id: req.traceId, strategy, error: err.message });
      throw Errors.dependency(strategy === 'mongo' ? 'MongoDB' : 'MySQL');
    }
    const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
    res.set('X-Cache', out.cache);
    return ok(res, { ...out.result, strategy, cache: out.cache, took_ms: Math.round(tookMs * 10) / 10 });
  }));

  // ---- save / unsave
  r.post('/properties/save', requireRole('guest'), validateBody(saveSchema), asyncHandler(async (req, res) => {
    const row = await repo.findByIdAnyStatus(req.body.property_id);
    if (!row) throw Errors.notFound('Property');
    if (row.status === 'deleted') throw Errors.gone();
    const changed = await saved.setSaved(req.user.id, row.property_id, req.body.saved);
    if (changed) {
      await publish(req, TOPICS.PROPERTY_SAVED, row, { guest_id: req.user.id, saved: req.body.saved },
        `${req.user.id}:${row.property_id}:${req.body.saved ? 'save' : 'unsave'}:${req.traceId}`);
    }
    return ok(res, { property_id: row.property_id, saved: req.body.saved, changed });
  }));

  // ---- availability: read the calendar, or a host blocks / unblocks dates (feature 13.3)
  r.post('/properties/availability', validateBody(availabilitySchema), asyncHandler(async (req, res) => {
    const { property_id, action } = req.body;
    if (!req.user) throw Errors.unauthenticated();
    const row = await repo.findByIdAnyStatus(property_id);
    if (!row) throw Errors.notFound('Property');
    if (row.status === 'deleted') throw Errors.gone();

    if (action === 'get') {
      const from = req.body.start_date || today();
      const to = req.body.end_date || addDays(from, 90);
      assertRange(from, to, { startField: 'start_date', endField: 'end_date' });
      // Cache the default window only; custom ranges go straight to MySQL.
      const isDefault = !req.body.start_date && !req.body.end_date;
      const out = isDefault
        ? await cache.cachedCalendar(property_id, () => availability.getCalendar(property_id, from, to))
        : { result: await availability.getCalendar(property_id, from, to), cache: 'BYPASS' };
      res.set('X-Cache', out.cache);
      return ok(res, { ...out.result, cache: out.cache });
    }

    if (req.user.role !== 'host' && req.user.role !== 'admin') throw Errors.forbidden();
    assertOwner(req, row);

    let change;
    try {
      if (action === 'block') {
        assertRange(req.body.start_date, req.body.end_date, { startField: 'start_date', endField: 'end_date', notPast: true });
        change = await availability.blockDates(property_id, req.body.expected_version, req.body.start_date, req.body.end_date);
      } else {
        change = await availability.unblock(property_id, req.body.availability_id, req.body.expected_version);
      }
    } catch (err) {
      if (err instanceof availability.AvailabilityConflict) {
        if (err.kind === 'version') {
          throw new AppError(409, 'VERSION_CONFLICT', err.message, {
            details: [{ field: 'expected_version', issue: `current version is ${err.currentVersion}` }], retryable: true,
          });
        }
        if (err.kind === 'not_found') throw Errors.notFound('Availability block');
        throw Errors.conflict('DATE_CONFLICT', err.message);
      }
      throw err;
    }

    await cache.invalidateProperty(property_id);
    await publish(req, TOPICS.AVAILABILITY_CHANGED, row, {
      start_date: change.start_date, end_date: change.end_date, status: change.status,
      availability_version: change.availability_version, source: 'host',
    }, `${property_id}:avail:v${change.availability_version}`);
    return ok(res, change);
  }));

  return r;
}

module.exports = { buildRouter, PROPERTY_TYPES, AMENITIES };
