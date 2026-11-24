// API Gateway (API doc §1): /api/v1/<service>/... -> service, JWT check,
// rate limit, trace id. Services trust X-User-Id / X-User-Role from here.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'gateway';
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { randomUUID } = require('crypto');
const { logger } = require('@airbnb/common');
const { createAccountStatus } = require('./accountStatus');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-dev-secret';
const JWT_ALGORITHM = 'HS256'; // the user service signs with HS256; refuse anything else

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

/**
 * accounts: decides whether a verified token's account is still allowed in (deleted
 * accounts are not). Tests pass a stub; the default reads Redis and MySQL.
 */
function createGateway({ accounts = createAccountStatus() } = {}) {
  const app = express();

  app.use((req, res, next) => {
    req.traceId = req.get('X-Trace-Id') || randomUUID();
    req.headers['x-trace-id'] = req.traceId;
    res.set('X-Trace-Id', req.traceId);
    next();
  });

  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'gateway', routes: Object.keys(ROUTES) }));

  // 1. Identify: never trust identity headers from the client; derive them only from
  //    a verified JWT whose account still exists. Nothing is rejected here, so the rate
  //    limiter below can key on the verified user instead of on a header the client controls.
  //    A deleted account's token is treated exactly like an expired one (401 on protected
  //    routes, anonymous plus X-Auth-Status on public ones), so the client contract is unchanged.
  app.use('/api', async (req, res, next) => {
    delete req.headers['x-user-id'];
    delete req.headers['x-user-role'];
    const auth = req.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    req.auth = null;
    req.authError = null;
    req.authUnavailable = false;
    if (token) {
      let claims = null;
      try {
        claims = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
        if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.role !== 'string' || !claims.role) throw new Error('missing claims');
      } catch {
        claims = null;
        req.authError = 'Invalid or expired token.';
      }
      if (claims) {
        const status = await accounts.check(claims.sub).catch(() => 'unavailable');
        if (status === 'active') req.auth = claims;
        else if (status === 'revoked') req.authError = 'This account is no longer active.';
        else req.authUnavailable = true; // cannot tell right now: never treat it as signed in
      }
    }
    next();
  });

  // 2. Rate limit per verified user, otherwise per client IP. Keying on the raw
  //    Authorization header would let a client get a fresh bucket per request just
  //    by sending a different made-up token.
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: Number(process.env.RATE_LIMIT_PER_MIN || 100),
      keyGenerator: (req) => (req.auth ? `user:${req.auth.sub}` : `ip:${req.ip}`),
      handler: (req, res) => errorBody(res, 429, 'RATE_LIMITED', 'Too many requests.'),
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // 3. Enforce. A valid token always passes identity on. A bad or expired token is
  //    401 on every protected route. On a public route (search, sign-up, login) it
  //    is dropped and the request continues anonymously, so a stale session in the
  //    browser cannot lock the user out of logging in again.
  app.use('/api', (req, res, next) => {
    if (req.auth) {
      req.headers['x-user-id'] = req.auth.sub;
      req.headers['x-user-role'] = req.auth.role;
      return next();
    }
    if (PUBLIC.includes(`${req.method} ${req.originalUrl.split('?')[0]}`)) {
      if (req.authError) {
        delete req.headers.authorization;
        res.set('X-Auth-Status', 'invalid'); // tells the client to drop its stored session
      } else if (req.authUnavailable) {
        delete req.headers.authorization; // continue anonymously, but keep the client's session
      }
      return next();
    }
    // Account status could not be checked (MySQL down): fail closed, and say it is retryable
    // instead of 401 so the client does not log the user out over an outage.
    if (req.authUnavailable) return errorBody(res, 503, 'DEPENDENCY_UNAVAILABLE', 'Cannot verify the account right now.');
    return errorBody(res, 401, 'UNAUTHENTICATED', req.authError || 'Missing token.');
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
