// Review Service (API doc §7). Owner: Slice 4. Data in MongoDB reviews.
//
//   POST /reviews/create      guest, own COMPLETED stay, one review per reservation -> review.created
//   POST /reviews/get         public
//   POST /reviews/byProperty  public, sort newest | rating_desc | rating_asc, with average_rating and review_count
//   POST /reviews/respond     host of that listing, once                            -> review.responded
//
// The property rating is not computed here: property-worker (slice 2) consumes
// review.created and recomputes rating and review_count from this collection,
// so every review carries property_id and rating.
//
// Shapes, limits and error codes follow API doc §7 and the examples in §13.5.
// Public views (get, byProperty) never include guest_id or reservation_id, only guest_first_name.
const express = require('express');
const Joi = require('joi');
const {
  asyncHandler, validateBody, requireRole, ok, Errors, AppError, createEnvelope, newId, TOPICS, logger,
} = require('@airbnb/common');
const defaultRepo = require('./models/review');

const subRating = Joi.number().integer().min(1).max(5);
const createSchema = Joi.object({
  reservation_id: Joi.string().required(),
  rating: Joi.number().integer().min(1).max(5).required(),
  review_text: Joi.string().trim().min(20).max(3000).required(),
  sub_ratings: Joi.object({
    cleanliness: subRating, accuracy: subRating, communication: subRating, location: subRating, value: subRating,
  }),
});
const getSchema = Joi.object({ review_id: Joi.string().required() });
const byPropertySchema = Joi.object({
  property_id: Joi.string().required(),
  sort: Joi.string().valid('newest', 'rating_desc', 'rating_asc').default('newest'),
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number().integer().min(1).max(100).default(20), // API doc §1 pagination
});
const respondSchema = Joi.object({
  review_id: Joi.string().required(),
  response_text: Joi.string().trim().min(1).max(1000).required(),
});

/** Run a data call; anything that is not one of our errors means the database is unavailable. */
async function db(what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error('database call failed', { what, error: err.message });
    throw Errors.dependency(what);
  }
}

function publicView(review, names) {
  if (!review) return null;
  const { guest_id, reservation_id, ...rest } = review; // eslint-disable-line no-unused-vars
  return { ...rest, guest_first_name: names.get(guest_id) || null };
}

function buildRouter({ bus, repo = defaultRepo }) {
  const r = express.Router();

  r.post('/reviews/create', requireRole('guest'), validateBody(createSchema), asyncHandler(async (req, res) => {
    const { reservation_id, rating, review_text, sub_ratings } = req.body;
    const resv = await db('MySQL', () => repo.findReservation(reservation_id));
    if (!resv) throw Errors.notFound('Reservation');
    if (resv.guest_id !== req.user.id) throw Errors.forbidden('Only the guest on this reservation can review it.');
    if (resv.status !== 'COMPLETED') throw Errors.businessRule('You can review a stay after checkout.');

    const doc = {
      review_id: newId('rev'),
      reservation_id,
      property_id: resv.property_id,
      host_id: resv.host_id,
      guest_id: resv.guest_id,
      rating,
      review_text,
      sub_ratings: sub_ratings || null,
      created_datetime: new Date().toISOString(),
      response_text: null,
      response_datetime: null,
      trace_id: req.traceId,
      event_published: false,
    };
    const result = await db('MongoDB', () => repo.insert(doc));
    let review = doc;
    if (!result.inserted) {
      if (result.existing.event_published) {
        throw Errors.conflict('ALREADY_REVIEWED', 'This reservation already has a review.');
      }
      // An earlier attempt saved the review but could not announce it (Kafka was down): finish that job now.
      review = result.existing;
    }

    const env = createEnvelope({
      eventType: TOPICS.REVIEW_CREATED,
      traceId: req.traceId,
      actorId: req.user.id,
      actorType: 'guest',
      entityType: 'review',
      entityId: review.review_id,
      idempotencyKey: `review.created:${review.review_id}`,
      // API doc §10 payload
      payload: {
        review_id: review.review_id,
        reservation_id: review.reservation_id,
        property_id: review.property_id,
        host_id: review.host_id,
        rating: review.rating,
      },
    });
    try {
      await bus.publish(TOPICS.REVIEW_CREATED, env, review.property_id); // keyed by property, like booking events
    } catch (err) {
      logger.error('event publish failed', { topic: TOPICS.REVIEW_CREATED, trace_id: req.traceId, review_id: review.review_id, error: err.message });
      // The review is saved; retrying the same request publishes it without creating a second one.
      throw Errors.dependency('Kafka');
    }
    await db('MongoDB', () => repo.markPublished(review.review_id));
    return ok(res, repo.toApi({ ...review, event_published: true }), result.inserted ? 201 : 200);
  }));

  r.post('/reviews/get', validateBody(getSchema), asyncHandler(async (req, res) => {
    const review = await db('MongoDB', () => repo.findById(req.body.review_id));
    if (!review) throw Errors.notFound('Review');
    const names = await repo.guestFirstNames([review.guest_id]);
    return ok(res, publicView(repo.toApi(review), names));
  }));

  r.post('/reviews/byProperty', validateBody(byPropertySchema), asyncHandler(async (req, res) => {
    const { property_id, sort, page, page_size } = req.body;
    const status = await db('MySQL', () => repo.propertyExists(property_id));
    if (!status) throw Errors.notFound('Property');
    const { items, review_count, average_rating } = await db('MongoDB', () => repo.listByProperty(property_id, { page, pageSize: page_size, sort }));
    const names = await repo.guestFirstNames(items.map((x) => x.guest_id));
    return ok(res, {
      average_rating,
      review_count,
      sort,
      items: items.map((x) => publicView(repo.toApi(x), names)),
      page,
      page_size,
      total: review_count,
    });
  }));

  r.post('/reviews/respond', requireRole('host'), validateBody(respondSchema), asyncHandler(async (req, res) => {
    const { review_id, response_text } = req.body;
    const review = await db('MongoDB', () => repo.findById(review_id));
    if (!review) throw Errors.notFound('Review');
    if (review.host_id !== req.user.id) throw Errors.forbidden('Only the host of this listing can respond.');
    const answered = () => Errors.conflict('INVALID_STATE_TRANSITION', 'This review already has a response.');
    if (review.response_text) throw answered();

    const updated = await db('MongoDB', () => repo.setResponse(review_id, response_text));
    if (!updated) throw answered(); // another request answered first

    const env = createEnvelope({
      eventType: TOPICS.REVIEW_RESPONDED,
      traceId: req.traceId,
      actorId: req.user.id,
      actorType: 'host',
      entityType: 'review',
      entityId: review_id,
      idempotencyKey: `review.responded:${review_id}`,
      payload: { review_id, property_id: review.property_id, host_id: review.host_id }, // API doc §10 payload
    });
    try {
      await bus.publish(TOPICS.REVIEW_RESPONDED, env, review.property_id);
      await db('MongoDB', () => repo.markPublished(review_id, 'response_event_published'));
    } catch (err) {
      // Nothing depends on this event for correctness; the answer is saved and visible.
      logger.error('event publish failed', { topic: TOPICS.REVIEW_RESPONDED, trace_id: req.traceId, review_id, error: err.message });
    }
    return ok(res, repo.toApi(updated));
  }));

  return r;
}

module.exports = { buildRouter };
