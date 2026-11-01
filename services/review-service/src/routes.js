// Review Service (API doc §7). Owner: Slice 4. Data in MongoDB reviews.
const express = require('express');
const Joi = require('joi');
const { asyncHandler, validateBody, requireRole, Errors } = require('@airbnb/common');

const subRating = Joi.number().integer().min(1).max(5);
const createSchema = Joi.object({
  reservation_id: Joi.string().required(),
  rating: Joi.number().integer().min(1).max(5).required(),
  review_text: Joi.string().min(20).max(3000).required(),
  sub_ratings: Joi.object({
    cleanliness: subRating, accuracy: subRating, communication: subRating, location: subRating, value: subRating,
  }),
});

function buildRouter({ bus }) { // eslint-disable-line no-unused-vars
  const r = express.Router();

  r.post('/reviews/create', requireRole('guest'), validateBody(createSchema), asyncHandler(async () => {
    // TODO: reservation must be COMPLETED and belong to req.user; one review per reservation; publish review.created
    throw Errors.notImplemented('POST /reviews/create');
  }));
  r.post('/reviews/get', asyncHandler(async () => { throw Errors.notImplemented('POST /reviews/get'); }));
  r.post('/reviews/byProperty', asyncHandler(async () => { throw Errors.notImplemented('POST /reviews/byProperty'); }));
  r.post('/reviews/respond', requireRole('host'), asyncHandler(async () => { throw Errors.notImplemented('POST /reviews/respond'); }));

  return r;
}

module.exports = { buildRouter };
