// Booking service API (API doc section 5). This is the slice 3 file.
// The API checks the request, publishes an event and answers 202.
// The booking worker (worker.js) picks the event up and writes to MySQL.
const express = require('express');
const Joi = require('joi');
const {
  asyncHandler, validateBody, requireRole, Errors, createEnvelope, TOPICS,
} = require('@airbnb/common');
const defaultRepo = require('./models/booking');
const { priceBreakdown, nightsBetween } = require('./pricing');
const { guestMayCancel, GUEST_CANCEL_WINDOW_HOURS } = require('./policy');

const DATE = /^\d{4}-\d{2}-\d{2}$/; // stay dates are plain YYYY-MM-DD (API doc section 1)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestSchema = Joi.object({
  property_id: Joi.string().required(),
  check_in: Joi.string().pattern(DATE).required(),
  check_out: Joi.string().pattern(DATE).required(),
  guest_count: Joi.number().integer().min(1).max(16).required(),
  guest_message: Joi.string().max(1000).allow(''),
});

const STATUSES = ['REQUESTED', 'CONFIRMED', 'DECLINED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'COMPLETED'];
const pagination = {
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number().integer().min(1).max(100).default(20),
};
const statusFilter = Joi.array().items(Joi.string().valid(...STATUSES));

const getSchema = Joi.object({ reservation_id: Joi.string().required() });
const approveSchema = Joi.object({ reservation_id: Joi.string().required() });
const declineSchema = Joi.object({ reservation_id: Joi.string().required(), reason: Joi.string().trim().min(1).max(500).required() });
const cancelSchema = Joi.object({
  reservation_id: Joi.string().required(),
  cancellation_reason: Joi.string().trim().min(1).max(500).required(),
});
const byPropertySchema = Joi.object({
  property_id: Joi.string().required(),
  status: statusFilter,
  from: Joi.string().pattern(DATE),
  to: Joi.string().pattern(DATE),
  ...pagination,
});
const byGuestSchema = Joi.object({ guest_id: Joi.string().required(), status: statusFilter, ...pagination });

/** Turns a reservation row and its history into the response shape from the API doc. */
function shapeReservation(row, history, toIso) {
  return {
    reservation_id: row.reservation_id,
    property_id: row.property_id,
    guest_id: row.guest_id,
    host_id: row.host_id,
    check_in: row.check_in,
    check_out: row.check_out,
    guest_count: row.guest_count,
    price_breakdown: row.price_breakdown,
    booking_datetime: toIso(row.booking_datetime),
    status: row.status,
    cancellation_reason: row.cancellation_reason,
    guest_message: row.guest_message,
    status_history: history,
  };
}

function requireIdempotencyKey(req, res, next) {
  const key = req.get('Idempotency-Key');
  if (!key || !UUID.test(key)) {
    return next(Errors.validation([{ field: 'Idempotency-Key', issue: 'header is required and must be a UUID' }]));
  }
  req.idempotencyKey = key;
  next();
}

function buildRouter({ bus, repo = defaultRepo }) {
  const r = express.Router();

  // Two calls count as the same request when the route and the body match.
  const fingerprint = (req) => ({ path: req.path, body: req.body });

  /** Same key and same request returns the first answer. Same key with a different request returns 409. */
  async function replayIfSeen(req, res) {
    const previous = await repo.findIdempotentResponse(req.idempotencyKey);
    if (!previous) return false;
    if (previous.request_hash !== defaultRepo.hashBody(fingerprint(req))) {
      throw Errors.conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.', [
        { field: 'Idempotency-Key', issue: 'reused with a different body or endpoint' },
      ]);
    }
    res.status(previous.response_status).json(previous.response_body);
    return true;
  }

  async function mustFindReservation(id) {
    const row = await repo.findReservation(id);
    if (!row) throw Errors.notFound('Reservation');
    return row;
  }

  function assertState(row, allowed, verb) {
    if (!allowed.includes(row.status)) {
      throw Errors.conflict('INVALID_STATE_TRANSITION', `Cannot ${verb} a ${row.status} reservation.`);
    }
  }

  /** Publishes the event for the worker, saves the answer and replies 202. */
  async function accept(req, res, { topic, row, payload, status }) {
    const role = req.user.role;
    const env = createEnvelope({
      eventType: topic,
      traceId: req.traceId,
      actorId: req.user.id,
      actorType: role === 'admin' ? 'admin' : role,
      entityType: 'reservation',
      entityId: row.reservation_id,
      idempotencyKey: req.idempotencyKey,
      payload,
    });
    try {
      await bus.publish(topic, env, row.property_id); // the property id is the key, so one property's events stay in order
    } catch (err) {
      throw Errors.dependency('Kafka');
    }
    const body = { data: { reservation_id: row.reservation_id, status }, trace_id: req.traceId };
    await repo.saveIdempotentResponse(req.idempotencyKey, fingerprint(req), 202, body, req.user.id);
    return res.status(202).json(body);
  }

  const assertOwningHost = (req, row) => {
    if (req.user.role !== 'admin' && row.host_id !== req.user.id) throw Errors.forbidden();
  };

  r.post(
    '/bookings/request',
    requireRole('guest'),
    requireIdempotencyKey,
    validateBody(requestSchema),
    asyncHandler(async (req, res) => {
      const { property_id, check_in, check_out, guest_count, guest_message } = req.body;

      const today = new Date().toISOString().slice(0, 10); // the doc says check_in must be today or later (UTC)
      if (check_in < today) throw Errors.validation([{ field: 'check_in', issue: 'must be today or later' }]);
      const nights = nightsBetween(check_in, check_out);
      if (!Number.isInteger(nights) || nights < 1 || nights > 30) throw Errors.validation([{ field: 'check_out', issue: 'stay must be 1 to 30 nights' }]);

      // The same Idempotency-Key again returns the original answer.
      if (await replayIfSeen(req, res)) return;

      const property = await repo.findPropertyForBooking(property_id);
      if (!property) throw Errors.notFound('Property');
      if (property.status !== 'active') throw Errors.gone();
      if (guest_count > property.capacity) throw Errors.businessRule(`Property sleeps at most ${property.capacity}.`);

      // Same guest, property and dates while still active returns 409 (API doc section 2).
      // A repeat with the same key was already answered above.
      const duplicate = await repo.findActiveDuplicate(req.user.id, property_id, check_in, check_out);
      if (duplicate) {
        throw Errors.conflict('DUPLICATE_BOOKING', 'You already have an active request for this property and these dates.', [
          { field: 'check_in', issue: `same stay as reservation ${duplicate.reservation_id}` },
        ]);
      }

      // Built from the Idempotency-Key, so two calls with the same key get the same
      // reservation id and the worker only applies it once.
      const reservationId = `res_${req.idempotencyKey.replace(/-/g, '')}`;
      const env = createEnvelope({
        eventType: TOPICS.BOOKING_REQUESTED,
        traceId: req.traceId,
        actorId: req.user.id,
        actorType: 'guest',
        entityType: 'reservation',
        entityId: reservationId,
        idempotencyKey: req.idempotencyKey,
        payload: {
          reservation_id: reservationId,
          property_id,
          guest_id: req.user.id,
          host_id: property.host_id,
          check_in,
          check_out,
          guest_count,
          guest_message: guest_message || null,
          price_breakdown: priceBreakdown(property, nights),
        },
      });

      try {
        await bus.publish(TOPICS.BOOKING_REQUESTED, env, property_id); // the property id is the key, so one property's events stay in order
      } catch (err) {
        throw Errors.dependency('Kafka');
      }

      const body = { data: { reservation_id: reservationId, status: 'PENDING' }, trace_id: req.traceId };
      await repo.saveIdempotentResponse(req.idempotencyKey, fingerprint(req), 202, body, req.user.id);
      return res.status(202).json(body);
    }),
  );

  const reply = (req, res, data) => res.status(200).json({ data, trace_id: req.traceId });

  // For the guest or host on the booking (or an admin). Before the worker writes the row,
  // the Idempotency-Key record lets us answer PENDING so the client can keep checking.
  r.post(
    '/bookings/get',
    requireRole('guest', 'host'),
    validateBody(getSchema),
    asyncHandler(async (req, res) => {
      const row = await repo.findReservation(req.body.reservation_id);
      if (!row) {
        // Accepted but not written by the worker yet. Only the guest who asked can see it.
        const pending = await repo.findPendingReservation(req.body.reservation_id);
        if (!pending) throw Errors.notFound('Reservation');
        if (req.user.role !== 'admin' && pending.owner_id !== req.user.id) throw Errors.forbidden();
        return reply(req, res, { reservation_id: pending.reservation_id, status: pending.status });
      }
      const { id, role } = req.user;
      if (role !== 'admin' && row.guest_id !== id && row.host_id !== id) throw Errors.forbidden();
      const history = await repo.listStatusHistory(row.reservation_id);
      return reply(req, res, shapeReservation(row, history, repo.toIso));
    }),
  );

  // Owning host only: reservations for one of their properties.
  r.post(
    '/bookings/byProperty',
    requireRole('host'),
    validateBody(byPropertySchema),
    asyncHandler(async (req, res) => {
      const { property_id, status, from, to, page, page_size } = req.body;
      if (from && to && to < from) throw Errors.validation([{ field: 'to', issue: 'must not be before from' }]);
      const property = await repo.findPropertyOwner(property_id);
      if (!property) throw Errors.notFound('Property');
      if (req.user.role !== 'admin' && property.host_id !== req.user.id) throw Errors.forbidden();

      const { rows, total } = await repo.listByProperty({ propertyId: property_id, statuses: status, from, to, page, pageSize: page_size });
      return reply(req, res, {
        items: rows.map((x) => ({
          reservation_id: x.reservation_id, guest_id: x.guest_id, check_in: x.check_in, check_out: x.check_out,
          guest_count: x.guest_count, total: Number(x.total_price), status: x.status, booking_datetime: repo.toIso(x.booking_datetime),
        })),
        page, page_size, total,
      });
    }),
  );

  // Guests can only ask for their own stays. Includes review prompts.
  r.post(
    '/bookings/byGuest',
    requireRole('guest'),
    validateBody(byGuestSchema),
    asyncHandler(async (req, res) => {
      const { guest_id, status, page, page_size } = req.body;
      if (req.user.role !== 'admin' && guest_id !== req.user.id) throw Errors.forbidden();

      const { rows, total } = await repo.listByGuest({ guestId: guest_id, statuses: status, page, pageSize: page_size });
      const reviewed = await repo.reviewedReservationIds(rows.filter((x) => x.status === 'COMPLETED').map((x) => x.reservation_id));
      return reply(req, res, {
        items: rows.map((x) => {
          const item = {
            reservation_id: x.reservation_id, property_id: x.property_id, check_in: x.check_in, check_out: x.check_out,
            status: x.status, total: Number(x.total_price),
          };
          if (x.status === 'COMPLETED') item.review_due = !reviewed.has(x.reservation_id);
          return item;
        }),
        page, page_size, total,
      });
    }),
  );
  // Host approves a pending request. The worker confirms it and publishes booking.confirmed.
  r.post(
    '/bookings/approve',
    requireRole('host'),
    requireIdempotencyKey,
    validateBody(approveSchema),
    asyncHandler(async (req, res) => {
      if (await replayIfSeen(req, res)) return;
      const row = await mustFindReservation(req.body.reservation_id);
      assertOwningHost(req, row);
      assertState(row, ['REQUESTED'], 'approve');
      return accept(req, res, {
        topic: TOPICS.BOOKING_APPROVED, row, status: 'APPROVING',
        payload: { reservation_id: row.reservation_id, host_id: row.host_id },
      });
    }),
  );

  // Host declines a pending request. The worker releases the nights.
  r.post(
    '/bookings/decline',
    requireRole('host'),
    requireIdempotencyKey,
    validateBody(declineSchema),
    asyncHandler(async (req, res) => {
      if (await replayIfSeen(req, res)) return;
      const row = await mustFindReservation(req.body.reservation_id);
      assertOwningHost(req, row);
      assertState(row, ['REQUESTED'], 'decline');
      return accept(req, res, {
        topic: TOPICS.BOOKING_DECLINED, row, status: 'DECLINING',
        payload: { reservation_id: row.reservation_id, host_id: row.host_id, reason: req.body.reason },
      });
    }),
  );

  // The guest on the booking or its host. A guest cannot cancel within 24 hours of check-in (see policy.js).
  r.post(
    '/bookings/cancel',
    requireRole('guest', 'host'),
    requireIdempotencyKey,
    validateBody(cancelSchema),
    asyncHandler(async (req, res) => {
      if (await replayIfSeen(req, res)) return;
      const row = await mustFindReservation(req.body.reservation_id);
      const { id, role } = req.user;
      if (role !== 'admin' && row.guest_id !== id && row.host_id !== id) throw Errors.forbidden();
      assertState(row, ['REQUESTED', 'CONFIRMED'], 'cancel');
      if (role === 'guest' && !guestMayCancel(row.check_in)) {
        throw Errors.businessRule(`Guests cannot cancel within ${GUEST_CANCEL_WINDOW_HOURS} hours of check-in.`); // same text as the API doc example
      }
      return accept(req, res, {
        topic: TOPICS.BOOKING_CANCEL_REQUESTED, row, status: 'CANCELLING',
        payload: { reservation_id: row.reservation_id, requested_by: id, cancellation_reason: req.body.cancellation_reason },
      });
    }),
  );

  return r;
}

module.exports = { buildRouter };
