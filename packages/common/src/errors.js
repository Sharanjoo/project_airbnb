// Common error model (API doc §2). Every error response has the same body.
class AppError extends Error {
  constructor(status, code, message, { details = [], retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

const Errors = {
  validation: (details, msg = 'Request body is invalid.') =>
    new AppError(400, 'VALIDATION_ERROR', msg, { details }),
  unauthenticated: (msg = 'Missing or invalid token.') => new AppError(401, 'UNAUTHENTICATED', msg),
  forbidden: (msg = 'Not allowed.') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found.`),
  conflict: (code, msg, details) => new AppError(409, code, msg, { details }),
  gone: (msg = 'Property is unavailable.') => new AppError(410, 'PROPERTY_UNAVAILABLE', msg),
  businessRule: (msg) => new AppError(422, 'BUSINESS_RULE_VIOLATION', msg),
  dependency: (what) =>
    new AppError(503, 'DEPENDENCY_UNAVAILABLE', `${what} is unavailable.`, { retryable: true }),
  notImplemented: (endpoint) =>
    new AppError(501, 'NOT_IMPLEMENTED', `${endpoint} is not implemented yet.`),
};

function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const traceId = req.traceId;
    if (err.type === 'entity.parse.failed') {
      err = Errors.validation([{ field: 'body', issue: 'malformed JSON' }]);
    }
    if (!(err instanceof AppError)) {
      logger.error('unhandled error', { trace_id: traceId, error: err.message, stack: err.stack });
      err = new AppError(500, 'INTERNAL_ERROR', 'Unexpected error.', { retryable: true });
    }
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, retryable: err.retryable },
      trace_id: traceId,
    });
  };
}

module.exports = { AppError, Errors, errorHandler };
