// Kafka producer/consumer helpers implementing the API doc §10 rules:
//  - validate the envelope before publish and after consume
//  - invalid envelope            -> <topic>.dlq immediately
//  - handler throws (transient)  -> bounded retries with backoff, then DLQ
//  - handler throws permanent    -> DLQ immediately
//  - offsets committed only after the handler finished (at-least-once)
//  - consumers dedupe with claimEvent() inside their DB transaction
//
// NOTE (slice 3): retries are in-process here. The API doc also describes
// <topic>.retry.N topics; switch to those if the team wants retries that
// survive a consumer restart.
const { Kafka, logLevel } = require('kafkajs');
const { validateEnvelope } = require('./envelope');
const { dlqTopic } = require('./topics');
const logger = require('./logger');

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
 */
async function processMessage({ topic, partition, message, handler, sendToDlq, groupId, maxRetries = 3, baseDelayMs = 200 }) {
  let env;
  try {
    env = JSON.parse(message.value.toString());
  } catch {
    await sendToDlq(dlqRecord({ topic, partition, message, reason: 'malformed JSON', groupId }));
    return 'dlq';
  }

  const check = validateEnvelope(env, topic);
  if (!check.valid) {
    logger.warn('envelope rejected', { topic, trace_id: env && env.trace_id, errors: check.errors });
    await sendToDlq(dlqRecord({ topic, partition, message, reason: `invalid envelope: ${check.errors.join('; ')}`, groupId }));
    return 'dlq';
  }

  for (let attempt = 0; ; attempt++) {
    try {
      await handler(env, { topic, partition, offset: message.offset, attempt });
      return 'ok';
    } catch (err) {
      const permanent = err.permanent || err.retryable === false;
      if (permanent || attempt >= maxRetries) {
        logger.error('event failed, sent to DLQ', { topic, trace_id: env.trace_id, attempt, error: err.message });
        await sendToDlq(dlqRecord({ topic, partition, message, reason: err.message, groupId }));
        return 'dlq';
      }
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * baseDelayMs);
      logger.warn('event failed, retrying', { topic, trace_id: env.trace_id, attempt, delay_ms: delay, error: err.message });
      await sleep(delay);
    }
  }
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
  async consume({ groupId, topics, handler, maxRetries = 3, fromBeginning = false }) {
    const consumer = this.kafka.consumer({ groupId });
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

module.exports = { EventBus, PermanentError, processMessage, claimEvent, createKafka };
