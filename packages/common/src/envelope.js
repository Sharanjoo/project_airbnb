// Shared Kafka envelope: build and validate. Schema lives in /contracts so the
// Python AI service validates against exactly the same file.
const Ajv = require('ajv');
const { randomUUID } = require('crypto');
const schema = require('../../../contracts/envelope.schema.json');

const ajv = new Ajv({ allErrors: true });
const validateFn = ajv.compile(schema);

// Max clock skew accepted on timestamps (API doc §10: not more than 5 min in the future).
const MAX_FUTURE_MS = 5 * 60 * 1000;

/**
 * Build a valid envelope. trace_id must be passed through from the request that
 * caused this event, never regenerated mid-workflow.
 */
function createEnvelope({
  eventType,
  traceId,
  actorId,
  actorType,
  entityType,
  entityId,
  payload,
  idempotencyKey,
  schemaVersion = 1,
}) {
  return {
    event_id: randomUUID(),
    event_type: eventType,
    schema_version: schemaVersion,
    trace_id: traceId,
    timestamp: new Date().toISOString(),
    actor_id: actorId,
    actor_type: actorType,
    entity: { entity_type: entityType, entity_id: entityId },
    payload,
    idempotency_key: idempotencyKey || randomUUID(),
  };
}

/**
 * Validate an envelope. Returns { valid: true } or { valid: false, errors: [string] }.
 * Pass `topic` to also check that event_type matches the topic name.
 */
function validateEnvelope(env, topic) {
  const errors = [];
  if (!validateFn(env)) {
    for (const e of validateFn.errors) errors.push(`${e.instancePath || '/'} ${e.message}`);
    return { valid: false, errors };
  }
  if (Date.parse(env.timestamp) - Date.now() > MAX_FUTURE_MS) {
    errors.push('/timestamp is more than 5 minutes in the future');
  }
  if (topic && env.event_type !== topic.replace(/\.dlq$/, '')) {
    errors.push(`/event_type "${env.event_type}" does not match topic "${topic}"`);
  }
  return errors.length ? { valid: false, errors } : { valid: true };
}

module.exports = { createEnvelope, validateEnvelope };
