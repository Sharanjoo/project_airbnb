// Booking Worker: a separate process from the Booking API (spec §3.1).
// Consumes booking.requested and claims nights in one MySQL transaction.
// approve / decline / cancel handlers are left for Slice 3.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'booking-worker';
const {
  EventBus, withTransaction, claimEvent, createEnvelope, TOPICS, logger,
} = require('@airbnb/common');
const repo = require('./models/booking');

const GROUP = 'booking-worker-cg';
const bus = new EventBus('booking-worker');

async function handleBookingRequested(env, { topic }) {
  const p = env.payload;
  const outcome = await withTransaction(async (conn) => {
    // Duplicate delivery (redelivery after crash, retry): skip, already applied.
    if (!(await claimEvent(conn, GROUP, env, topic))) return 'duplicate';

    // Savepoint so a lost race on nights does not undo the processed_events row.
    await conn.query('SAVEPOINT claim_nights');
    try {
      await repo.insertReservationWithNights(conn, p, 'REQUESTED', env.trace_id);
      await repo.recordStatus(conn, { reservationId: p.reservation_id, from: null, to: 'REQUESTED', actorId: 'svc:booking-worker', traceId: env.trace_id });
      return 'REQUESTED';
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      await conn.query('ROLLBACK TO SAVEPOINT claim_nights');
      await repo.insertRejectedReservation(conn, p, 'DATE_CONFLICT', env.trace_id);
      await repo.recordStatus(conn, { reservationId: p.reservation_id, from: null, to: 'REJECTED', actorId: 'svc:booking-worker', reason: 'DATE_CONFLICT', traceId: env.trace_id });
      return 'REJECTED';
    }
  });

  logger.info('booking.requested processed', { trace_id: env.trace_id, reservation_id: p.reservation_id, outcome });
  if (outcome === 'REJECTED') {
    await bus.publish(TOPICS.BOOKING_REJECTED, createEnvelope({
      eventType: TOPICS.BOOKING_REJECTED,
      traceId: env.trace_id,
      actorId: 'svc:booking-worker',
      actorType: 'service',
      entityType: 'reservation',
      entityId: p.reservation_id,
      idempotencyKey: `${env.idempotency_key}:rejected`,
      payload: {
        reservation_id: p.reservation_id, property_id: p.property_id, guest_id: p.guest_id,
        check_in: p.check_in, check_out: p.check_out, previous_status: null, new_status: 'REJECTED', reason: 'DATE_CONFLICT',
      },
    }), p.property_id);
  }
  // TODO (slice 3): publish a status event the notification gateway pushes for REQUESTED too.
}

const handlers = {
  [TOPICS.BOOKING_REQUESTED]: handleBookingRequested,
  // TODO (slice 3): [TOPICS.BOOKING_APPROVED], [TOPICS.BOOKING_DECLINED], [TOPICS.BOOKING_CANCEL_REQUESTED]
};

async function main() {
  await bus.consume({
    groupId: GROUP,
    topics: Object.keys(handlers),
    handler: (env, meta) => handlers[meta.topic](env, meta),
  });
  logger.info('booking-worker consuming', { topics: Object.keys(handlers) });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('booking-worker crashed', { error: err.message });
    process.exit(1);
  });
  const shutdown = () => bus.disconnect().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { handleBookingRequested, bus };
