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

  r.post('/bookings/get', asyncHandler(async () => { throw Errors.notImplemented('POST /bookings/get'); }));
  r.post('/bookings/byProperty', requireRole('host'), asyncHandler(async () => { throw Errors.notImplemented('POST /bookings/byProperty'); }));
  r.post('/bookings/byGuest', requireRole('guest'), asyncHandler(async () => { throw Errors.notImplemented('POST /bookings/byGuest'); }));
  // approve / decline / cancel: same shape as request -> publish booking.approved|declined|cancel_requested, 202
  r.post('/bookings/approve', requireRole('host'), requireIdempotencyKey, asyncHandler(async () => { throw Errors.notImplemented('POST /bookings/approve'); }));
  r.post('/bookings/decline', requireRole('host'), requireIdempotencyKey, asyncHandler(async () => { throw Errors.notImplemented('POST /bookings/decline'); }));
  r.post('/bookings/cancel', requireRole('guest', 'host'), requireIdempotencyKey, asyncHandler(async () => { throw Errors.notImplemented('POST /bookings/cancel'); }));

  return r;
}

module.exports = { buildRouter };
