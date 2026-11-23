// Review Service (API doc §7). Owner: Slice 4. Data in MongoDB reviews.
//
//   POST /reviews/create      guest, own COMPLETED stay, one review per reservation -> review.created
//   POST /reviews/get         public
//   POST /reviews/byProperty  public, newest first, with the average rating
//   POST /reviews/respond     host of that listing, once                            -> review.responded
//
// The property rating is not computed here: property-worker (slice 2) consumes
// review.created and recomputes rating and review_count from this collection,
// so every review carries property_id and rating.
//
// Public views never include guest_id or reservation_id, only a "First L." name.
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
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number().integer().min(1).max(50).default(10),
});
const respondSchema = Joi.object({
  review_id: Joi.string().required(),
  response_text: Joi.string().trim().min(1).max(2000).required(),
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
  return { ...rest, guest_name: names.get(guest_id) || 'Guest' };
}

function buildRouter({ bus, repo = defaultRepo }) {
  const r = express.Router();

  r.post('/reviews/create', requireRole('guest'), validateBody(createSchema), asyncHandler(async (req, res) => {
    const { reservation_id, rating, review_text, sub_ratings } = req.body;
    const resv = await db('MySQL', () => repo.findReservation(reservation_id));
    // Someone else's stay looks exactly like a missing one, so ids cannot be probed.
    if (!resv || resv.guest_id !== req.user.id) throw Errors.notFound('Reservation');
    if (resv.status !== 'COMPLETED') throw Errors.businessRule('You can review a stay only after it is completed.');

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
      host_response: null,
      trace_id: req.traceId,
      event_published: false,
    };
    const result = await db('MongoDB', () => repo.insert(doc));
    let review = doc;
    if (!result.inserted) {
      if (result.existing.event_published) {
        throw Errors.conflict('ALREADY_REVIEWED', 'You have already reviewed this stay.', [{ field: 'reservation_id', issue: 'already reviewed' }]);
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
      payload: {
        review_id: review.review_id,
        reservation_id: review.reservation_id,
        property_id: review.property_id,
        host_id: review.host_id,
        guest_id: review.guest_id,
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
    const names = await repo.guestNames([review.guest_id]);
    return ok(res, publicView(repo.toApi(review), names));
  }));

  r.post('/reviews/byProperty', validateBody(byPropertySchema), asyncHandler(async (req, res) => {
    const { property_id, page, page_size } = req.body;
    const status = await db('MySQL', () => repo.propertyExists(property_id));
    if (!status) throw Errors.notFound('Property');
    const { items, total, average_rating } = await db('MongoDB', () => repo.listByProperty(property_id, { page, pageSize: page_size }));
    const names = await repo.guestNames(items.map((x) => x.guest_id));
    return ok(res, {
      items: items.map((x) => publicView(repo.toApi(x), names)),
      page,
      page_size,
      total,
      average_rating,
    });
  }));

  r.post('/reviews/respond', requireRole('host'), validateBody(respondSchema), asyncHandler(async (req, res) => {
    const { review_id, response_text } = req.body;
    const review = await db('MongoDB', () => repo.findById(review_id));
    if (!review) throw Errors.notFound('Review');
    if (review.host_id !== req.user.id) throw Errors.forbidden('Only the host of this listing can respond.');
    if (review.host_response) throw Errors.conflict('ALREADY_RESPONDED', 'This review already has a response.');

    const response = { response_text, responded_at: new Date().toISOString() };
    const updated = await db('MongoDB', () => repo.setResponse(review_id, response));
    if (!updated) throw Errors.conflict('ALREADY_RESPONDED', 'This review already has a response.'); // lost a race

    const env = createEnvelope({
      eventType: TOPICS.REVIEW_RESPONDED,
      traceId: req.traceId,
      actorId: req.user.id,
      actorType: 'host',
      entityType: 'review',
      entityId: review_id,
      idempotencyKey: `review.responded:${review_id}`,
      payload: { review_id, property_id: review.property_id, host_id: review.host_id, guest_id: review.guest_id },
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
