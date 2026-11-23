// User Service (API doc §3). Owner: Slice 1.
// Pattern: validateBody(schema) -> model call -> bus.publish(...) -> ok(res, data).
// Phase 1: sign-up and login. Phase 2: profiles (get / update / delete / admin search).
const express = require('express');
const Joi = require('joi');
const {
  asyncHandler, validateBody, requireRole, ok, Errors, AppError, createEnvelope, newId, TOPICS, logger,
} = require('@airbnb/common');
const defaultGuests = require('./models/guest');
const defaultHosts = require('./models/host');
const { hashPassword, verifyPassword, issueToken, BCRYPT_MAX_BYTES } = require('./auth');

const PUBLISH_WAIT_MS = Number(process.env.PUBLISH_WAIT_MS || 2000);

// ---------------------------------------------------------------- schemas
// Unknown fields are rejected by validateBody, so a sign-up body can never carry
// role, access_level, verification_status or an id of its own choosing.
// Format check only, no IANA TLD list: demo and test accounts use reserved domains
// such as @demo.invalid (slice 3 double-booking demo), which must still log in.
const email = Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(255);
const newPassword = Joi.string().min(8).custom((value, helpers) => (
  Buffer.byteLength(value, 'utf8') > BCRYPT_MAX_BYTES ? helpers.error('string.maxBytes') : value
)).messages({ 'string.maxBytes': `"password" must be at most ${BCRYPT_MAX_BYTES} bytes` });
const phone = Joi.string().pattern(/^\+[1-9]\d{6,14}$/).messages({ 'string.pattern.base': '"phone" must be E.164, e.g. +14085550101' });
const photoUrl = Joi.string().uri({ scheme: ['http', 'https'] }).max(500);

const guestCreateSchema = Joi.object({
  first_name: Joi.string().trim().min(1).max(60).required(),
  last_name: Joi.string().trim().min(1).max(60).required(),
  email: email.required(),
  password: newPassword.required(),
  phone,
  location: Joi.string().trim().max(120),
  profile_photo_url: photoUrl,
  preferences: Joi.object({
    budget_max: Joi.number().min(0),
    amenities: Joi.array().items(Joi.string()),
    property_types: Joi.array().items(Joi.string()),
    pet_friendly: Joi.boolean(),
  }),
});

const hostCreateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  email: email.required(),
  password: newPassword.required(),
  phone,
  profile_photo_url: photoUrl,
});

const loginSchema = Joi.object({
  email: email.required(),
  // No minimum here: login must not reveal password rules. The cap stops huge bodies reaching bcrypt.
  password: Joi.string().min(1).max(1024).required(),
  // Optional. The same email may have a guest and a host account; role picks one.
  role: Joi.string().valid('guest', 'host'),
});

// ---- profile schemas (phase 2). Same shape as /properties/update: id + version + changes.
const id = (prefix) => Joi.string().pattern(new RegExp(`^${prefix}_[A-Za-z0-9]{1,36}$`)).required();
const version = Joi.number().integer().min(1).required();
const pagination = {
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number().integer().min(1).max(100).default(20),
};

const guestGetSchema = Joi.object({ guest_id: id('gst') });
const guestDeleteSchema = Joi.object({ guest_id: id('gst') });
const guestUpdateSchema = Joi.object({
  guest_id: id('gst'),
  version,
  first_name: Joi.string().trim().min(1).max(60),
  last_name: Joi.string().trim().min(1).max(60),
  phone: phone.allow(null), // null clears an optional field
  location: Joi.string().trim().max(120).allow(null),
  profile_photo_url: photoUrl.allow(null),
  preferences: guestCreateSchema.extract('preferences').allow(null),
}).min(3); // guest_id + version + at least one change

const guestSearchSchema = Joi.object({
  q: Joi.string().trim().min(1).max(100),
  location: Joi.string().trim().min(1).max(120),
  include_deleted: Joi.boolean().default(false),
  ...pagination,
});

const hostGetSchema = Joi.object({ host_id: id('hst') });
const hostUpdateSchema = Joi.object({
  host_id: id('hst'),
  version,
  name: Joi.string().trim().min(1).max(120),
  phone: phone.allow(null),
  profile_photo_url: photoUrl.allow(null),
}).min(3);

/** Guests and hosts may only read or change their own profile; admins may act on anyone. */
function assertSelfOrAdmin(req, userId) {
  if (req.user.role !== 'admin' && req.user.id !== userId) {
    throw Errors.forbidden('You can only access your own profile.');
  }
}

const versionConflict = (what, current) => new AppError(409, 'VERSION_CONFLICT', `${what} was changed by someone else.`, {
  details: [{ field: 'version', issue: `current version is ${current}` }], retryable: true,
});

const emailTaken = () => Errors.conflict('EMAIL_TAKEN', 'An account with this email already exists.', [
  { field: 'email', issue: 'already registered' },
]);

function buildRouter({ bus, guests = defaultGuests, hosts = defaultHosts }) {
  const r = express.Router();

  /**
   * Publish a user event. The row is already committed, so a Kafka failure is
   * logged rather than returned: retrying the sign-up would only hit EMAIL_TAKEN.
   * We wait at most PUBLISH_WAIT_MS so a slow broker cannot stall sign-up.
   * (Same approach as property-service; a transactional outbox would close the gap.)
   */
  async function publish(req, topic, { userId, userType, payload, idempotencyKey, actor }) {
    const env = createEnvelope({
      eventType: topic,
      traceId: req.traceId,
      // Sign-up: the new user is the actor. Profile changes: whoever made them (the user or an admin).
      actorId: actor ? actor.id : userId,
      actorType: actor ? actor.role : userType,
      entityType: userType,
      entityId: userId,
      idempotencyKey,
      payload: { user_id: userId, user_type: userType, ...payload },
    });
    const sending = Promise.resolve()
      .then(() => bus.publish(topic, env, userId)) // key = user id, so one user's events stay in order
      .then(() => true)
      .catch((err) => {
        logger.error('event publish failed', { topic, trace_id: req.traceId, user_id: userId, error: err.message });
        return false;
      });
    const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), PUBLISH_WAIT_MS).unref());
    if ((await Promise.race([sending, timedOut])) === 'timeout') {
      logger.warn('event publish still pending, not blocking the response', { topic, trace_id: req.traceId, user_id: userId });
    }
  }

  /** Insert, mapping the email UNIQUE key violation to 409. No pre-check, so there is no race window. */
  async function insertOrConflict(model, record) {
    try {
      return await model.insert(record);
    } catch (err) {
      // Only the email key means "taken"; any other duplicate (an id collision) stays a 500.
      if (err.code === 'ER_DUP_ENTRY' && /email/i.test(err.sqlMessage || err.message)) throw emailTaken();
      throw err;
    }
  }

  // ---- guests
  r.post('/guests/create', validateBody(guestCreateSchema), asyncHandler(async (req, res) => {
    const { password, ...profile } = req.body;
    const guestId = newId('gst');
    const row = await insertOrConflict(guests, { ...profile, guest_id: guestId, password_hash: await hashPassword(password) });
    const guest = guests.toApi(row);
    // No email or phone in the event: every consumer group (analytics included) stores it.
    await publish(req, TOPICS.USER_CREATED, {
      userId: guestId,
      userType: 'guest',
      idempotencyKey: `${guestId}:created`,
      payload: { location: guest.location, preferences: guest.preferences, created_at: guest.profile_created_datetime },
    });
    return ok(res, guest, 201);
  }));

  r.post('/guests/get', requireRole('guest'), validateBody(guestGetSchema), asyncHandler(async (req, res) => {
    assertSelfOrAdmin(req, req.body.guest_id);
    const row = await guests.findById(req.body.guest_id);
    if (!row) throw Errors.notFound('Guest');
    return ok(res, guests.toApi(row));
  }));

  // ---- update (optimistic lock on `version`)
  r.post('/guests/update', requireRole('guest'), validateBody(guestUpdateSchema), asyncHandler(async (req, res) => {
    const { guest_id: guestId, version: expected, ...changes } = req.body;
    assertSelfOrAdmin(req, guestId);
    const { updated, row } = await guests.updateWithVersion(guestId, expected, changes);
    if (!updated) {
      if (!row || row.is_deleted) throw Errors.notFound('Guest');
      throw versionConflict(`Guest ${guestId}`, row.version);
    }
    // Field names only, never values: every consumer group stores this event.
    await publish(req, TOPICS.USER_UPDATED, {
      userId: guestId,
      userType: 'guest',
      actor: req.user,
      idempotencyKey: `${guestId}:v${row.version}`,
      payload: { changed_fields: Object.keys(changes), version: row.version, deleted: false },
    });
    return ok(res, guests.toApi(row));
  }));

  // ---- delete (soft). Repeating it is harmless, like /properties/delete.
  r.post('/guests/delete', requireRole('guest'), validateBody(guestDeleteSchema), asyncHandler(async (req, res) => {
    const guestId = req.body.guest_id;
    assertSelfOrAdmin(req, guestId);
    const current = await guests.findByIdAnyStatus(guestId);
    if (!current) throw Errors.notFound('Guest');
    if (current.is_deleted) return ok(res, { guest_id: guestId, deleted: true });

    const active = await guests.countActiveReservations(guestId);
    if (active > 0) {
      throw Errors.conflict('INVALID_STATE_TRANSITION', `Guest has ${active} active reservation${active > 1 ? 's' : ''}. Cancel ${active > 1 ? 'them' : 'it'} first.`);
    }
    if (await guests.softDelete(guestId)) {
      const row = await guests.findByIdAnyStatus(guestId);
      await publish(req, TOPICS.USER_UPDATED, {
        userId: guestId,
        userType: 'guest',
        actor: req.user,
        idempotencyKey: `${guestId}:deleted`,
        payload: { changed_fields: ['is_deleted'], version: row.version, deleted: true },
      });
    }
    return ok(res, { guest_id: guestId, deleted: true });
  }));

  // ---- admin search
  r.post('/guests/search', requireRole('admin'), validateBody(guestSearchSchema), asyncHandler(async (req, res) => {
    const { q, location, include_deleted: includeDeleted, page, page_size: pageSize } = req.body;
    const { rows, total } = await guests.search({ q, location, includeDeleted, page, pageSize });
    return ok(res, {
      items: rows.map((row) => ({ ...guests.toApi(row), deleted: Boolean(row.is_deleted) })),
      page,
      page_size: pageSize,
      total,
    });
  }));

  // ---- hosts
  r.post('/hosts/create', validateBody(hostCreateSchema), asyncHandler(async (req, res) => {
    const { password, ...profile } = req.body;
    const hostId = newId('hst');
    const row = await insertOrConflict(hosts, { ...profile, host_id: hostId, password_hash: await hashPassword(password) });
    const host = hosts.toApi(row);
    await publish(req, TOPICS.USER_CREATED, {
      userId: hostId,
      userType: 'host',
      idempotencyKey: `${hostId}:created`,
      payload: { created_at: host.host_since },
    });
    return ok(res, host, 201);
  }));

  // Any signed-in user may look a host up (a guest viewing a listing). Contact
  // details and version are only shown to the host themself and to admins.
  r.post('/hosts/get', requireRole('guest', 'host'), validateBody(hostGetSchema), asyncHandler(async (req, res) => {
    const row = await hosts.findById(req.body.host_id);
    if (!row) throw Errors.notFound('Host');
    const full = req.user.role === 'admin' || req.user.id === row.host_id;
    return ok(res, full ? hosts.toApi(row) : hosts.toPublic(row));
  }));

  r.post('/hosts/update', requireRole('host'), validateBody(hostUpdateSchema), asyncHandler(async (req, res) => {
    const { host_id: hostId, version: expected, ...changes } = req.body;
    assertSelfOrAdmin(req, hostId);
    const { updated, row } = await hosts.updateWithVersion(hostId, expected, changes);
    if (!updated) {
      if (!row || row.is_deleted) throw Errors.notFound('Host');
      throw versionConflict(`Host ${hostId}`, row.version);
    }
    await publish(req, TOPICS.USER_UPDATED, {
      userId: hostId,
      userType: 'host',
      actor: req.user,
      idempotencyKey: `${hostId}:v${row.version}`,
      payload: { changed_fields: Object.keys(changes), version: row.version, deleted: false },
    });
    return ok(res, hosts.toApi(row));
  }));

  // ---- auth
  r.post('/auth/login', validateBody(loginSchema), asyncHandler(async (req, res) => {
    const { email: address, password, role } = req.body;

    // Look up the requested account type, or both when no role is given.
    const candidates = [];
    if (!role || role === 'guest') candidates.push({ role: 'guest', row: await guests.findByEmail(address) });
    if (!role || role === 'host') candidates.push({ role: 'host', row: await hosts.findByEmail(address) });

    // Always run bcrypt for every candidate, even a missing one, so timing is the same.
    const matches = [];
    for (const c of candidates) {
      if (await verifyPassword(password, c.row ? c.row.password_hash : null)) matches.push(c);
    }

    // One message for unknown email and wrong password, so login does not reveal which emails exist.
    if (matches.length === 0) throw Errors.unauthenticated('Invalid email or password.');
    if (matches.length > 1) {
      // Only reachable with the right password for both accounts.
      throw Errors.conflict('AMBIGUOUS_ACCOUNT', 'This email has a guest and a host account. Choose which one to log in to.', [
        { field: 'role', issue: 'must be "guest" or "host"' },
      ]);
    }

    const { role: accountType, row } = matches[0];
    const userId = accountType === 'guest' ? row.guest_id : row.host_id;
    // Admin is never self-service: it comes only from hosts.access_level, which sign-up cannot set.
    const tokenRole = accountType === 'host' && row.access_level === 'admin' ? 'admin' : accountType;
    return ok(res, issueToken({ userId, role: tokenRole }));
  }));

  return r;
}

module.exports = { buildRouter, guestCreateSchema, hostCreateSchema, loginSchema, guestUpdateSchema, hostUpdateSchema };
