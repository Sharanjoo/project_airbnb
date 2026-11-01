// API Gateway (API doc §1): /api/v1/<service>/... -> service, JWT check,
// rate limit, trace id. Services trust X-User-Id / X-User-Role from here.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'gateway';
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { randomUUID } = require('crypto');
const { logger } = require('@airbnb/common');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-dev-secret';

const ROUTES = {
  user: process.env.USER_SERVICE_URL || 'http://localhost:8001',
  property: process.env.PROPERTY_SERVICE_URL || 'http://localhost:8002',
  booking: process.env.BOOKING_SERVICE_URL || 'http://localhost:8003',
  messaging: process.env.MESSAGING_SERVICE_URL || 'http://localhost:8004',
  review: process.env.REVIEW_SERVICE_URL || 'http://localhost:8005',
  analytics: process.env.ANALYTICS_SERVICE_URL || 'http://localhost:8006',
  ai: process.env.AI_SERVICE_URL || 'http://localhost:8007',
};

// Reachable without a token
const PUBLIC = [
  'POST /api/v1/user/guests/create',
  'POST /api/v1/user/hosts/create',
  'POST /api/v1/user/auth/login',
  'POST /api/v1/property/properties/search',
  'POST /api/v1/property/properties/get',
  'POST /api/v1/review/reviews/byProperty',
  'POST /api/v1/review/reviews/get',
];

const errorBody = (res, status, code, message) =>
  res.status(status).json({ error: { code, message, details: [], retryable: status >= 500 || status === 429 }, trace_id: res.req.traceId });

function createGateway() {
  const app = express();

  app.use((req, res, next) => {
    req.traceId = req.get('X-Trace-Id') || randomUUID();
    req.headers['x-trace-id'] = req.traceId;
    res.set('X-Trace-Id', req.traceId);
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'gateway', routes: Object.keys(ROUTES) }));

  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: Number(process.env.RATE_LIMIT_PER_MIN || 100),
      keyGenerator: (req) => req.get('Authorization') || req.ip,
      handler: (req, res) => errorBody(res, 429, 'RATE_LIMITED', 'Too many requests.'),
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // Auth: never trust identity headers from the client; derive them from the JWT.
  app.use('/api', (req, res, next) => {
    delete req.headers['x-user-id'];
    delete req.headers['x-user-role'];
    const auth = req.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token) {
      try {
        const claims = jwt.verify(token, JWT_SECRET);
        req.headers['x-user-id'] = claims.sub;
        req.headers['x-user-role'] = claims.role;
        return next();
      } catch {
        return errorBody(res, 401, 'UNAUTHENTICATED', 'Invalid or expired token.');
      }
    }
    if (PUBLIC.includes(`${req.method} ${req.originalUrl.split('?')[0]}`)) return next();
    return errorBody(res, 401, 'UNAUTHENTICATED', 'Missing token.');
  });

  for (const [name, target] of Object.entries(ROUTES)) {
    app.use(
      `/api/v1/${name}`,
      createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: name === 'ai',
        proxyTimeout: 3000,
        on: {
          error: (err, req, res) => {
            logger.warn('upstream error', { trace_id: req.traceId, service: name, error: err.code || err.message });
            if (res.headersSent || typeof res.status !== 'function') return;
            errorBody(res, 503, 'DEPENDENCY_UNAVAILABLE', `${name} service is unavailable.`);
          },
        },
      }),
    );
  }

  app.use((req, res) => errorBody(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found.`));
  return app;
}

if (require.main === module) {
  const port = Number(process.env.GATEWAY_PORT || 8080);
  createGateway().listen(port, () => logger.info(`gateway listening on ${port}`, { routes: ROUTES }));
}

module.exports = { createGateway, ROUTES };
