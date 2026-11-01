// Express app factory every Node service uses: JSON body, trace id, user
// context from the gateway, /health, uniform success and error bodies.
const express = require('express');
const { randomUUID } = require('crypto');
const { errorHandler, Errors } = require('./errors');

function createApp({ name, logger }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Trace id: reuse the caller's, or create one. Returned on every response.
  app.use((req, res, next) => {
    req.traceId = req.get('X-Trace-Id') || randomUUID();
    res.set('X-Trace-Id', req.traceId);
    // The gateway verifies the JWT and forwards these; services trust them.
    req.user = req.get('X-User-Id')
      ? { id: req.get('X-User-Id'), role: req.get('X-User-Role') }
      : null;
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', service: name }));

  // Routes are mounted by the service; call finalize() afterwards.
  app.finalize = () => {
    app.use((req, res, next) => next(Errors.notFound(`Route ${req.method} ${req.path}`)));
    app.use(errorHandler(logger));
    return app;
  };
  return app;
}

// Wrap async route handlers so thrown errors reach the error middleware.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Success envelope: { data, trace_id }
function ok(res, data, status = 200) {
  return res.status(status).json({ data, trace_id: res.req.traceId });
}

// Joi body validation; unknown fields are rejected (API doc §2).
function validateBody(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false, allowUnknown: false });
    if (error) {
      return next(
        Errors.validation(error.details.map((d) => ({ field: d.path.join('.'), issue: d.message }))),
      );
    }
    req.body = value;
    next();
  };
}

// Role guard: requireRole('host'), requireRole('guest', 'host')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(Errors.unauthenticated());
    if (!roles.includes(req.user.role) && req.user.role !== 'admin') return next(Errors.forbidden());
    next();
  };
}

module.exports = { createApp, asyncHandler, ok, validateBody, requireRole };
