// Booking Service API (API doc §5). Owner: Slice 3.
// /bookings/request is implemented end to end as the REFERENCE PATTERN for the
// team: validate -> check Idempotency-Key -> look up -> publish event -> 202.
// The Booking Worker (src/worker.js) consumes the event and writes MySQL.
const express = require('express');
const Joi = require('joi');
const {
  asyncHandler, validateBody, requireRole, Errors, createEnvelope, newId, TOPICS,
} = require('@airbnb/common');
const defaultRepo = require('./models/booking');
const { priceBreakdown, nightsBetween } = require('./pricing');

const DATE = /^\d{4}-\d{2}-\d{2}$/; // stay dates stay plain YYYY-MM-DD (API doc §1)
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
const byPropertySchema = Joi.object({
  property_id: Joi.string().required(),
  status: statusFilter,
  from: Joi.string().pattern(DATE),
  to: Joi.string().pattern(DATE),
  ...pagination,
});
const byGuestSchema = Joi.object({ guest_id: Joi.string().required(), status: statusFilter, ...pagination });

/** Reservation row + history -> the API doc §13.3 response shape. */
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

  r.post(
    '/bookings/request',
    requireRole('guest'),
    requireIdempotencyKey,
    validateBody(requestSchema),
    asyncHandler(async (req, res) => {
      const { property_id, check_in, check_out, guest_count, guest_message } = req.body;

      const today = new Date().toISOString().slice(0, 10);
      if (check_in < today) throw Errors.validation([{ field: 'check_in', issue: 'must be today or later' }]);
      const nights = nightsBetween(check_in, check_out);
      if (!Number.isInteger(nights) || nights < 1 || nights > 30) throw Errors.validation([{ field: 'check_out', issue: 'stay must be 1 to 30 nights' }]);

      // A repeat of the same Idempotency-Key returns the original answer.
      const previous = await repo.findIdempotentResponse(req.idempotencyKey);
      if (previous) return res.status(previous.response_status).json(previous.response_body);

      const property = await repo.findPropertyForBooking(property_id);
      if (!property) throw Errors.notFound('Property');
      if (property.status !== 'active') throw Errors.gone();
      if (guest_count > property.capacity) throw Errors.businessRule(`Property sleeps at most ${property.capacity}.`);

      const reservationId = newId('res');
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
        await bus.publish(TOPICS.BOOKING_REQUESTED, env, property_id); // key = property_id -> ordered per property
      } catch (err) {
        throw Errors.dependency('Kafka');
      }

      const body = { data: { reservation_id: reservationId, status: 'PENDING' }, trace_id: req.traceId };
      await repo.saveIdempotentResponse(req.idempotencyKey, req.body, 202, body);
      return res.status(202).json(body);
    }),
  );

  const reply = (req, res, data) => res.status(200).json({ data, trace_id: req.traceId });

  // Guest or host on the booking (or admin). Before the worker has written the
  // row, the Idempotency-Key record answers with PENDING so a client can poll.
  r.post(
    '/bookings/get',
    requireRole('guest', 'host'),
    validateBody(getSchema),
    asyncHandler(async (req, res) => {
      const row = await repo.findReservation(req.body.reservation_id);
      if (!row) {
        const pending = await repo.findPendingReservation(req.body.reservation_id);
        if (pending) return reply(req, res, pending);
        throw Errors.notFound('Reservation');
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

  // Self only: a guest's own upcoming, past and cancelled stays, with review prompts.
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
  // approve / decline / cancel: same shape as request -> publish booking.approved|declined|cancel_requested, 202
  r.post('/bookings/approve', requireRole('host'), requireIdempotencyKey, asyncHandler(async () => { throw Errors.notImplemented('POST /bookings/approve'); }));
  r.post('/bookings/decline', requireRole('host'), requireIdempotencyKey, asyncHandler(async () => { throw Errors.notImplemented('POST /bookings/decline'); }));
  r.post('/bookings/cancel', requireRole('guest', 'host'), requireIdempotencyKey, asyncHandler(async () => { throw Errors.notImplemented('POST /bookings/cancel'); }));

  return r;
}

module.exports = { buildRouter };
