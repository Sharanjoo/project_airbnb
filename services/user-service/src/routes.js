// User Service (API doc §3). Owner: Slice 1.
// Each handler is a stub that returns 501 until implemented.
// Pattern to follow: validateBody(schema) -> model call -> bus.publish(...) -> ok(res, data).
const express = require('express');
const Joi = require('joi');
const { asyncHandler, validateBody, requireRole, Errors } = require('@airbnb/common');

const guestCreateSchema = Joi.object({
  first_name: Joi.string().min(1).max(60).required(),
  last_name: Joi.string().min(1).max(60).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  phone: Joi.string().pattern(/^\+[1-9]\d{6,14}$/),
  location: Joi.string().max(120),
  profile_photo_url: Joi.string().uri(),
  preferences: Joi.object({
    budget_max: Joi.number().min(0),
    amenities: Joi.array().items(Joi.string()),
    property_types: Joi.array().items(Joi.string()),
    pet_friendly: Joi.boolean(),
  }),
});

function buildRouter({ bus }) { // eslint-disable-line no-unused-vars
  const r = express.Router();

  // ---- guests
  r.post('/guests/create', validateBody(guestCreateSchema), asyncHandler(async () => {
    // TODO: hash password (bcryptjs), insert via models/guest.js, publish user.created
    throw Errors.notImplemented('POST /guests/create');
  }));
  r.post('/guests/get', requireRole('guest'), asyncHandler(async () => { throw Errors.notImplemented('POST /guests/get'); }));
  r.post('/guests/update', requireRole('guest'), asyncHandler(async () => { throw Errors.notImplemented('POST /guests/update'); }));
  r.post('/guests/delete', requireRole('guest'), asyncHandler(async () => { throw Errors.notImplemented('POST /guests/delete'); }));
  r.post('/guests/search', requireRole('admin'), asyncHandler(async () => { throw Errors.notImplemented('POST /guests/search'); }));

  // ---- hosts
  r.post('/hosts/create', asyncHandler(async () => { throw Errors.notImplemented('POST /hosts/create'); }));
  r.post('/hosts/get', asyncHandler(async () => { throw Errors.notImplemented('POST /hosts/get'); }));
  r.post('/hosts/update', requireRole('host'), asyncHandler(async () => { throw Errors.notImplemented('POST /hosts/update'); }));

  // ---- auth
  r.post('/auth/login', asyncHandler(async () => {
    // TODO: check bcrypt hash, sign JWT { sub, role } with JWT_SECRET, return { token, expires_at, user_id }
    throw Errors.notImplemented('POST /auth/login');
  }));

  return r;
}

module.exports = { buildRouter };
