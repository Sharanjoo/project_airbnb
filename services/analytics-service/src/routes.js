// Analytics and Logging Service (API doc §8). Owner: Slice 4.
// Dashboards must be computed from MySQL + Mongo events/traces, never static samples.
const express = require('express');
const { asyncHandler, requireRole, Errors } = require('@airbnb/common');

function buildRouter({ bus }) { // eslint-disable-line no-unused-vars
  const r = express.Router();

  r.post('/events/ingest', asyncHandler(async () => {
    // TODO: validate each envelope; valid -> events collection, invalid -> events.dlq; return { accepted, rejected }
    throw Errors.notImplemented('POST /events/ingest');
  }));

  r.get('/analytics/properties/top', asyncHandler(async () => { throw Errors.notImplemented('GET /analytics/properties/top'); }));
  r.get('/analytics/funnel', requireRole('host'), asyncHandler(async () => { throw Errors.notImplemented('GET /analytics/funnel'); }));
  r.get('/analytics/geo', requireRole('admin'), asyncHandler(async () => { throw Errors.notImplemented('GET /analytics/geo'); }));
  r.get('/analytics/host/dashboard', requireRole('host'), asyncHandler(async () => { throw Errors.notImplemented('GET /analytics/host/dashboard'); }));
  r.get('/analytics/guest/dashboard', requireRole('guest'), asyncHandler(async () => { throw Errors.notImplemented('GET /analytics/guest/dashboard'); }));
  r.get('/analytics/platform', requireRole('admin'), asyncHandler(async () => { throw Errors.notImplemented('GET /analytics/platform'); }));
  r.get('/analytics/ai', requireRole('admin'), asyncHandler(async () => { throw Errors.notImplemented('GET /analytics/ai'); }));
  r.get('/traces/:traceId', asyncHandler(async () => { throw Errors.notImplemented('GET /traces/{trace_id}'); }));

  return r;
}

module.exports = { buildRouter };
