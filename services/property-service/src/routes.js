// Property Service (API doc §4). Owner: Slice 2.
// Owns listings, availability (optimistic lock, 13.3), saved properties,
// and the Redis search cache with invalidation (13.9).
const express = require('express');
const Joi = require('joi');
const { asyncHandler, validateBody, requireRole, Errors } = require('@airbnb/common');

const PROPERTY_TYPES = ['entire_home', 'apartment', 'private_room', 'shared_room', 'cabin', 'condo'];
const AMENITIES = ['wifi', 'kitchen', 'parking', 'washer', 'ac', 'heating', 'pool', 'pet_friendly', 'workspace', 'self_checkin'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const searchSchema = Joi.object({
  location: Joi.object({ city: Joi.string(), radius_km: Joi.number().min(0).max(200) }),
  check_in: Joi.string().pattern(DATE),
  check_out: Joi.string().pattern(DATE), // TODO: reject check_out <= check_in
  guests: Joi.number().integer().min(1).max(16),
  price_min: Joi.number().min(0),
  price_max: Joi.number().min(0),
  property_types: Joi.array().items(Joi.string().valid(...PROPERTY_TYPES)),
  amenities: Joi.array().items(Joi.string().valid(...AMENITIES)),
  min_rating: Joi.number().min(0).max(5),
  sort: Joi.string().valid('price_asc', 'price_desc', 'rating_desc', 'newest').default('price_asc'),
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number().integer().min(1).max(100).default(20),
}).and('check_in', 'check_out');

function buildRouter({ bus }) { // eslint-disable-line no-unused-vars
  const r = express.Router();

  r.post('/properties/create', requireRole('host'), asyncHandler(async () => { throw Errors.notImplemented('POST /properties/create'); }));
  r.post('/properties/get', asyncHandler(async () => {
    // TODO: read, then publish property.viewed (do not block the response on Kafka)
    throw Errors.notImplemented('POST /properties/get');
  }));
  r.post('/properties/update', requireRole('host'), asyncHandler(async () => {
    // TODO: optimistic lock on version; publish property.updated; invalidate cache
    throw Errors.notImplemented('POST /properties/update');
  }));
  r.post('/properties/delete', requireRole('host'), asyncHandler(async () => { throw Errors.notImplemented('POST /properties/delete'); }));
  r.post('/properties/search', validateBody(searchSchema), asyncHandler(async () => {
    // TODO: cache key search:{search:version}:{sha256(body)}, TTL 60s; return cache HIT/MISS
    throw Errors.notImplemented('POST /properties/search');
  }));
  r.post('/properties/save', requireRole('guest'), asyncHandler(async () => { throw Errors.notImplemented('POST /properties/save'); }));
  r.post('/properties/availability', asyncHandler(async () => {
    // TODO: action get|block|unblock; writes need expected_version (UPDATE ... WHERE availability_version = ?)
    throw Errors.notImplemented('POST /properties/availability');
  }));

  return r;
}

module.exports = { buildRouter, PROPERTY_TYPES, AMENITIES };
