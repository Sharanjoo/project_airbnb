// Messaging consumer: opens a thread when a booking is requested (API doc §6).
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'messaging-worker';
const { EventBus, TOPICS, logger } = require('@airbnb/common');

const GROUP = 'messaging-cg';
const bus = new EventBus('messaging-worker');

async function handleBookingRequested(env) {
  // TODO (slice 1): upsert thread {guest_id, host_id, property_id, reservation_id};
  // insert guest_message as first message with idempotent _id = env.idempotency_key
  logger.info('would open thread for booking', { trace_id: env.trace_id, reservation_id: env.payload.reservation_id });
}

async function main() {
  await bus.consume({ groupId: GROUP, topics: [TOPICS.BOOKING_REQUESTED], handler: handleBookingRequested });
  logger.info('messaging-worker consuming');
}

if (require.main === module) {
  main().catch((err) => { logger.error('messaging-worker crashed', { error: err.message }); process.exit(1); });
}

module.exports = { handleBookingRequested };
