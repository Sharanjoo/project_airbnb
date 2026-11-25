// Messaging consumer (group messaging-cg): opens a thread when a booking is requested (API doc §6).
//
//   booking.requested (slice 3) -> thread for (guest_id, host_id, property_id), created or reused,
//                                  with reservation_id added; payload.guest_message (if any)
//                                  becomes a message from the guest to the host; message.sent published.
//
// Fields used, all set by booking-service from the token and the listing row (main and
// slice3/booking-reads publish the same shape): reservation_id, guest_id, host_id,
// property_id, guest_message (string or null). Nothing else is assumed.
//
// Redelivery, retries and replays from the start of the topic are harmless:
//  - the thread is an upsert on the unique (guest_id, host_id, property_id) index;
//  - the first message is stored under the dedupe key "booking:<reservation_id>", so a
//    second delivery finds it instead of inserting another;
//  - message.sent is republished only while the message is not flagged `notified`.
// A booking request is announced before booking-worker checks the dates, so a thread can
// exist for a request that is later rejected. The conversation is still useful (the guest
// can ask about other dates) and the reservation id stays on the thread for reference.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'messaging-worker';
const {
  EventBus, PermanentError, TOPICS, logger,
} = require('@airbnb/common');
const { createStore } = require('./models');
const { bookingDedupeKey } = require('./models/messages');
const { deliver } = require('./delivery');

const GROUP = 'messaging-cg';

const requireString = (env, field) => {
  const v = env.payload && env.payload[field];
  if (typeof v !== 'string' || !v) throw new PermanentError(`${env.event_type} payload is missing ${field}`);
  return v;
};

function buildHandlers({ bus, store = createStore() }) {
  async function onBookingRequested(env) {
    const reservationId = requireString(env, 'reservation_id');
    const guestId = requireString(env, 'guest_id');
    const hostId = requireString(env, 'host_id');
    const propertyId = requireString(env, 'property_id');
    const raw = env.payload.guest_message;
    const text = typeof raw === 'string' ? raw.trim().slice(0, 2000) : '';

    const { thread, created: threadCreated } = await store.threads.openThread({ guestId, hostId, propertyId, reservationId });

    let outcome = threadCreated ? 'thread_created' : 'thread_reused';
    if (text) {
      // The event time, not "now", so a replay keeps the message where it belongs in the history.
      const sentAt = env.timestamp ? new Date(env.timestamp) : new Date();
      const { message, created } = await store.messages.insert({
        threadId: thread._id,
        senderId: guestId,
        receiverId: hostId,
        text,
        dedupeKey: bookingDedupeKey(reservationId),
        reservationId,
        timestamp: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
      });
      // Throws if Kafka is down: processMessage retries, and the retry finds the stored message.
      await deliver({ bus, store, message, traceId: env.trace_id, actorId: guestId, actorType: 'guest' });
      outcome += created ? '+message' : '+message_duplicate';
    }
    logger.info('booking.requested processed', { trace_id: env.trace_id, reservation_id: reservationId, thread_id: thread._id, outcome });
    return outcome;
  }

  return { [TOPICS.BOOKING_REQUESTED]: onBookingRequested };
}

async function main() {
  const bus = new EventBus('messaging-worker');
  const handlers = buildHandlers({ bus });
  await bus.consume({
    groupId: GROUP,
    topics: Object.keys(handlers),
    // A new group reads every retained request, so bookings made before the first deploy
    // still get their thread. Safe to replay (see above).
    fromBeginning: true,
    handler: (env, meta) => handlers[meta.topic](env, meta),
  });
  logger.info('messaging-worker consuming', { topics: Object.keys(handlers) });
}

if (require.main === module) {
  main().catch((err) => { logger.error('messaging-worker crashed', { error: err.message }); process.exit(1); });
}

module.exports = { buildHandlers, GROUP };
