// User worker (consumer group user-cg). Separate process from the user API.
// Keeps the two counters on `guests` up to date from other slices' events:
//
//   booking.confirmed (slice 3) -> guests.booking_count += 1 for payload.guest_id,
//                                  at most once per reservation_id
//   property.saved    (slice 2) -> guests.saved_properties_count recomputed for payload.guest_id
//                                  from saved_properties (covers save and unsave)
//
// Definitions (team decision, Slice 1 phase 2):
//  - booking_count = lifetime number of unique reservations of this guest that were ever
//    confirmed. It only goes up. A later cancellation, completion or any other status
//    change does not reduce it, so this worker does not subscribe to booking.cancelled,
//    booking.declined, booking.expired or booking.completed.
//  - saved_properties_count = number of rows in saved_properties for this guest right now
//    (goes down on unsave).
//
// Producer behaviour this relies on, taken from their code:
//  - property-service publishes property.saved { property_id, guest_id, saved } only
//    when the saved state really changed, keyed by property_id. saved_properties is
//    the source of truth, so the count is recomputed from it (idempotent, order independent).
//  - booking-service publishes booking.confirmed { reservation_id, guest_id, host_id, ...,
//    new_status: 'CONFIRMED' } when a host approves a REQUESTED booking, and republishes
//    the same event (same idempotency key) after a redelivery. A reservation reaches
//    CONFIRMED at most once, so the counter is claimed per reservation_id.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'user-worker';
const {
  EventBus, PermanentError, withTransaction: defaultWithTransaction, claimEvent: defaultClaimEvent, TOPICS, logger,
} = require('@airbnb/common');
const defaultGuests = require('./models/guest');

const GROUP = 'user-cg';

const requireString = (env, field) => {
  const v = env.payload && env.payload[field];
  // A malformed payload will never succeed: PermanentError sends it straight to the DLQ.
  if (typeof v !== 'string' || !v) throw new PermanentError(`${env.event_type} payload is missing ${field}`);
  return v;
};

function buildHandlers({ guests = defaultGuests, withTransaction = defaultWithTransaction, claimEvent = defaultClaimEvent } = {}) {
  async function onBookingConfirmed(env, { topic }) {
    const reservationId = requireString(env, 'reservation_id');
    const guestId = requireString(env, 'guest_id');
    if (env.payload.new_status && env.payload.new_status !== 'CONFIRMED') {
      logger.warn('booking.confirmed with another status, ignored', { trace_id: env.trace_id, reservation_id: reservationId, new_status: env.payload.new_status });
      return 'ignored';
    }

    const outcome = await withTransaction(async (conn) => {
      // Claim per reservation, not per event: a second booking.confirmed for the same
      // reservation (redelivery, a republish after a crash, or a replay from the start
      // of the topic) can never count twice. Same transaction as the increment.
      const claim = { ...env, idempotency_key: `booking_count:${reservationId}` };
      if (!(await claimEvent(conn, GROUP, claim, topic))) return 'duplicate';
      return (await guests.incrementBookingCount(conn, guestId)) ? 'counted' : 'unknown_guest';
    });

    const log = outcome === 'unknown_guest' ? logger.warn : logger.info;
    log('booking.confirmed processed', { trace_id: env.trace_id, reservation_id: reservationId, guest_id: guestId, outcome });
    return outcome;
  }

  async function onPropertySaved(env) {
    const guestId = requireString(env, 'guest_id');
    const count = await guests.recomputeSavedCount(guestId);
    if (count === null) {
      logger.warn('property.saved for an unknown guest, ignored', { trace_id: env.trace_id, guest_id: guestId });
      return 'unknown_guest';
    }
    logger.info('saved_properties_count recomputed', { trace_id: env.trace_id, guest_id: guestId, property_id: env.payload.property_id, saved: env.payload.saved, count });
    return 'recomputed';
  }

  return {
    [TOPICS.BOOKING_CONFIRMED]: onBookingConfirmed,
    [TOPICS.PROPERTY_SAVED]: onPropertySaved,
  };
}

async function main() {
  const bus = new EventBus('user-worker');
  const handlers = buildHandlers();
  await bus.consume({
    groupId: GROUP,
    topics: Object.keys(handlers),
    // A new group starts from the oldest retained event, so bookings confirmed and
    // listings saved before this worker first ran are still counted. Safe to replay:
    // bookings are claimed per reservation and saved counts are recomputed.
    fromBeginning: true,
    handler: (env, meta) => handlers[meta.topic](env, meta),
  });
  logger.info('user-worker consuming', { topics: Object.keys(handlers) });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('user-worker crashed', { error: err.message });
    process.exit(1);
  });
}

module.exports = { buildHandlers, GROUP };
