// Kafka producer/consumer helpers implementing the API doc §10 rules:
//  - validate the envelope before publish and after consume
//  - invalid envelope            -> <topic>.dlq immediately
//  - handler throws (transient)  -> bounded retries with backoff, then DLQ
//  - handler throws permanent    -> DLQ immediately
//  - offsets committed only after the handler finished (at-least-once)
//  - consumers dedupe with claimEvent() inside their DB transaction
//  - every consumed event leaves a trace step in MongoDB `traces` (API doc §8): which
//    service handled it, how long it took, and whether it succeeded, was retried, was
//    rejected or went to the DLQ. Best effort: a failed write never stops a consumer.
//
// NOTE (slice 3): retries are in-process here. The API doc also describes
// <topic>.retry.N topics; switch to those if the team wants retries that
// survive a consumer restart.
const { Kafka, logLevel } = require('kafkajs');
const { validateEnvelope } = require('./envelope');
const { dlqTopic } = require('./topics');
const logger = require('./logger');
const { getMongo } = require('./db');

// Known, harmless KafkaJS startup notices that would otherwise print on every boot:
//  - the v2 default-partitioner notice (we always set a message key, so the partitioner choice is explicit)
//  - "limiting retries for the idempotent producer": retries are bounded on purpose so the
//    Booking API answers 503 when Kafka is down instead of hanging
const IGNORED_KAFKAJS_WARNINGS = [/switched default partitioner/, /Limiting retries for the idempotent producer/];

// Route KafkaJS logs through our JSON logger so every line has the same shape.
const kafkaLogCreator = () => ({ level, log }) => {
  const { message, timestamp, logger: _l, ...extra } = log; // eslint-disable-line no-unused-vars
  if (IGNORED_KAFKAJS_WARNINGS.some((re) => re.test(message))) return;
  const fn = level <= logLevel.ERROR ? logger.error : logger.warn;
  fn(`kafkajs: ${message}`, extra);
};

function createKafka(clientId) {
  return new Kafka({
    clientId,
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9094').split(','),
    logLevel: logLevel.WARN,
    logCreator: kafkaLogCreator,
    retry: { retries: 5 },
  });
}

class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build the DLQ record: original value unchanged + failure headers (trace_id kept inside). */
function dlqRecord({ topic, partition, message, reason, groupId }) {
  return {
    key: message.key,
    value: message.value,
    headers: {
      failure_reason: String(reason).slice(0, 1000),
      failed_at: new Date().toISOString(),
      consumer_group: groupId || '',
      source_topic: topic,
      source_partition: String(partition ?? ''),
      source_offset: String(message.offset ?? ''),
    },
  };
}

/**
 * Pure per-message logic, separated from kafkajs so it can be unit tested.
 * Returns 'ok' | 'dlq'.
 *
 * traceStep(step) is called once per outcome, so the caller can persist it:
 *   { trace_id, event_type, step, status, latency_ms, error, attempt, kafka }
 *   step   handled (handler finished, or failed on this attempt) | dead_lettered | rejected
 *   status ok | retry (failed, will try again) | error (rejected or sent to the DLQ)
 */
async function processMessage({
  topic, partition, message, handler, sendToDlq, groupId, maxRetries = 3, baseDelayMs = 200, traceStep = () => {},
}) {
  const kafka = { topic, partition, offset: message.offset };
  const report = (env, fields) => {
    try {
      traceStep({ trace_id: (env && env.trace_id) || null, event_type: topic, error: null, attempt: 0, kafka, ...fields });
    } catch { /* tracing must never affect processing */ }
  };
  let env;
  try {
    env = JSON.parse(message.value.toString());
  } catch {
    await sendToDlq(dlqRecord({ topic, partition, message, reason: 'malformed JSON', groupId }));
    report(null, { step: 'rejected', status: 'error', latency_ms: 0, error: 'malformed JSON' });
    return 'dlq';
  }

  const check = validateEnvelope(env, topic);
  if (!check.valid) {
    logger.warn('envelope rejected', { topic, trace_id: env && env.trace_id, errors: check.errors });
    const reason = `invalid envelope: ${check.errors.join('; ')}`;
    await sendToDlq(dlqRecord({ topic, partition, message, reason, groupId }));
    report(env, { step: 'rejected', status: 'error', latency_ms: 0, error: reason });
    return 'dlq';
  }

  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      await handler(env, { topic, partition, offset: message.offset, attempt });
      report(env, { step: 'handled', status: 'ok', latency_ms: Date.now() - started, attempt });
      return 'ok';
    } catch (err) {
      const latency = Date.now() - started;
      const permanent = err.permanent || err.retryable === false;
      if (permanent || attempt >= maxRetries) {
        logger.error('event failed, sent to DLQ', { topic, trace_id: env.trace_id, attempt, error: err.message });
        await sendToDlq(dlqRecord({ topic, partition, message, reason: err.message, groupId }));
        report(env, { step: 'dead_lettered', status: 'error', latency_ms: latency, error: err.message, attempt });
        return 'dlq';
      }
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs);
      logger.warn('event failed, retrying', { topic, trace_id: env.trace_id, attempt, delay_ms: delay, error: err.message });
      report(env, { step: 'handled', status: 'retry', latency_ms: latency, error: err.message, attempt });
      await sleep(delay);
    }
  }
}

const MAX_PENDING_TRACE_WRITES = 1000;

/**
 * Persist trace steps to MongoDB `traces` without making the consumer wait. If MongoDB is
 * slow or down, steps beyond MAX_PENDING_TRACE_WRITES are dropped (counted in the log) rather
 * than piling up in memory; the consumer itself is never slowed or failed by tracing.
 */
function mongoTraceWriter({ service, groupId }) {
  let pending = 0;
  let dropped = 0;
  let warned = false;
  return (step) => {
    if (pending >= MAX_PENDING_TRACE_WRITES) { dropped++; return; }
    pending++;
    const doc = { ...step, service, consumer_group: groupId, timestamp: new Date().toISOString() };
    getMongo()
      .then((db) => db.collection('traces').insertOne(doc))
      .then(() => {
        if (dropped) { logger.warn('trace steps dropped while MongoDB was slow', { dropped }); dropped = 0; }
        warned = false;
      })
      .catch((err) => {
        if (!warned) logger.warn('trace step not stored', { error: err.message });
        warned = true;
      })
      .finally(() => { pending--; });
  };
}

/** Trace steps are on by default; off in unit tests, with TRACE_STEPS=off, or per consumer. */
function traceStepsEnabled(option) {
  if (option === false) return false;
  if (process.env.TRACE_STEPS === 'off') return false;
  return process.env.NODE_ENV !== 'test' || process.env.TRACE_STEPS === 'on';
}

class EventBus {
  constructor(clientId) {
    this.kafka = createKafka(clientId);
    this.producer = null;
    this.consumers = [];
  }

  async connectProducer() {
    if (!this.producer) {
      this.producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
      await this.producer.connect();
    }
    return this.producer;
  }

  /** Validate, then publish. key decides the partition (property_id or trace_id, see API doc §10). */
  async publish(topic, envelope, key) {
    const check = validateEnvelope(envelope, topic);
    if (!check.valid) {
      const err = new Error(`refusing to publish invalid envelope to ${topic}: ${check.errors.join('; ')}`);
      err.permanent = true;
      throw err;
    }
    const producer = await this.connectProducer();
    await producer.send({
      topic,
      messages: [{ key: key || envelope.entity.entity_id, value: JSON.stringify(envelope) }],
    });
  }

  /**
   * Start a consumer group. handler(envelope, meta) must be idempotent: use
   * claimEvent() inside the same DB transaction as the business write.
   */
  async consume({ groupId, topics, handler, maxRetries = 3, fromBeginning = false, traceSteps }) {
    const consumer = this.kafka.consumer({ groupId });
    const traceStep = traceStepsEnabled(traceSteps)
      ? mongoTraceWriter({ service: process.env.SERVICE_NAME || groupId, groupId })
      : undefined;
    await consumer.connect();
    for (const topic of topics) await consumer.subscribe({ topic, fromBeginning });
    const producer = await this.connectProducer();

    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        await processMessage({
          topic,
          partition,
          message,
          handler,
          groupId,
          maxRetries,
          traceStep,
          sendToDlq: (record) => producer.send({ topic: dlqTopic(topic), messages: [record] }),
        });
        // Commit only after the handler (or DLQ write) finished.
        await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
      },
    });
    this.consumers.push(consumer);
    return consumer;
  }

  async disconnect() {
    await Promise.all(this.consumers.map((c) => c.disconnect()));
    if (this.producer) await this.producer.disconnect();
  }
}

/**
 * Consumer idempotency. Call inside the transaction that does the business write.
 * Returns true the first time, false if this group already processed the event.
 */
async function claimEvent(conn, groupId, env, topic) {
  try {
    await conn.execute(
      'INSERT INTO processed_events (consumer_group, idempotency_key, event_id, topic) VALUES (?, ?, ?, ?)',
      [groupId, env.idempotency_key, env.event_id, topic],
    );
    return true;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

module.exports = { EventBus, PermanentError, processMessage, claimEvent, createKafka, traceStepsEnabled };
