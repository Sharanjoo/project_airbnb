// Booking worker. It runs as its own process, separate from the booking API.
//
// Events it handles:
//   booking.requested: claims the nights, or rejects the request if they are taken or blocked,
//     or if the guest's account was deleted in the meantime
//   booking.approved: confirms the booking and sends booking.confirmed and payment.completed
//   booking.declined: marks it declined, frees the nights and sends booking.rejected
//   booking.cancel_requested: cancels it, frees the nights and sends booking.cancelled
// The scheduler in scheduler.js also runs here to expire old requests and complete finished stays.
//
// Two rules keep this safe when something crashes:
// 1. The database change and the "already processed" record go in one transaction,
//    so an event that arrives twice is only applied once.
// 2. The outcome event is sent after the commit. If the worker dies before sending it,
//    the event comes back, the database change is skipped, but the outcome is sent again.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'booking-worker';
const {
  EventBus, PermanentError, withTransaction, claimEvent, createEnvelope, TOPICS, logger,
} = require('@airbnb/common');
const repo = require('./models/booking');
const { startScheduler } = require('./scheduler');

const GROUP = 'booking-worker-cg';
const ACTOR = 'svc:booking-worker';
const bus = new EventBus('booking-worker');

/** Sends one outcome event. The property id is the key, so one property's events stay in order. */
async function publishOutcome(env, { topic, suffix, row, previous, to, reason }) {
  await bus.publish(topic, createEnvelope({
    eventType: topic,
    traceId: env.trace_id,
    actorId: ACTOR,
    actorType: 'service',
    entityType: 'reservation',
    entityId: row.reservation_id,
    idempotencyKey: `${env.idempotency_key}:${suffix}`,
    payload: {
      reservation_id: row.reservation_id,
      property_id: row.property_id,
      guest_id: row.guest_id,
      host_id: row.host_id,
      check_in: row.check_in,
      check_out: row.check_out,
      previous_status: previous,
      new_status: to,
      reason: reason || null,
    },
  }), row.property_id);
}

// Handler for booking.requested

async function handleBookingRequested(env, { topic }) {
  const p = env.payload;
  const result = await withTransaction(async (conn) => {
    // We already handled this event (a retry or a redelivery). Skip the write but still report the outcome.
    if (!(await claimEvent(conn, GROUP, env, topic))) {
      const existing = await repo.lockReservation(conn, p.reservation_id);
      return { outcome: 'duplicate', rejected: existing && existing.status === 'REJECTED' ? existing.cancellation_reason : null };
    }

    // Savepoint so losing the race for a night does not undo the processed_events row.
    await conn.query('SAVEPOINT claim_nights');
    let rejectedReason = null;
    try {
      // The account can be deleted after the API accepted the request but before we got here.
      const guest = await repo.lockGuestShared(conn, p.guest_id);
      if (!guest) throw new PermanentError(`guest ${p.guest_id} does not exist`);
      if (guest.is_deleted) {
        rejectedReason = 'GUEST_DELETED';
      } else {
        // Wait for any host who is blocking dates on this property right now.
        await repo.lockPropertyShared(conn, p.property_id);
        if (await repo.hasBlockedDates(conn, p.property_id, p.check_in, p.check_out)) {
          rejectedReason = 'DATE_CONFLICT'; // the host blocked these dates
        } else {
          await repo.insertReservationWithNights(conn, p, 'REQUESTED', env.trace_id);
          await repo.recordStatus(conn, { reservationId: p.reservation_id, from: null, to: 'REQUESTED', actorId: ACTOR, traceId: env.trace_id });
        }
      }
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      await conn.query('ROLLBACK TO SAVEPOINT claim_nights');
      rejectedReason = 'DATE_CONFLICT'; // someone else already holds one of these nights
    }

    if (rejectedReason) {
      await repo.insertRejectedReservation(conn, p, rejectedReason, env.trace_id);
      await repo.recordStatus(conn, { reservationId: p.reservation_id, from: null, to: 'REJECTED', actorId: ACTOR, reason: rejectedReason, traceId: env.trace_id });
      return { outcome: 'REJECTED', rejected: rejectedReason };
    }
    return { outcome: 'REQUESTED', rejected: null };
  });

  logger.info('booking.requested processed', { trace_id: env.trace_id, reservation_id: p.reservation_id, outcome: result.outcome });
  if (result.rejected) {
    await publishOutcome(env, {
      topic: TOPICS.BOOKING_REJECTED,
      suffix: 'rejected',
      row: { ...p },
      previous: null,
      to: 'REJECTED',
      reason: result.rejected,
    });
  }
  // The guest hears about a new request from the booking.requested event itself.
}

// Handlers for approve, decline and cancel

const TRANSITIONS = {
  [TOPICS.BOOKING_APPROVED]: {
    from: ['REQUESTED'],
    to: 'CONFIRMED',
    releases: false,
    actorOf: (env) => env.payload.requested_by || env.payload.host_id, // older events only carry host_id
    allowedActors: (row) => [row.host_id],
    reasonOf: () => null,
    outcome: TOPICS.BOOKING_CONFIRMED,
    suffix: 'confirmed',
    simulatePayment: true,
  },
  [TOPICS.BOOKING_DECLINED]: {
    from: ['REQUESTED'],
    to: 'DECLINED',
    releases: true,
    actorOf: (env) => env.payload.requested_by || env.payload.host_id, // older events only carry host_id
    allowedActors: (row) => [row.host_id],
    reasonOf: (env) => env.payload.reason,
    outcome: TOPICS.BOOKING_REJECTED,
    suffix: 'declined',
  },
  [TOPICS.BOOKING_CANCEL_REQUESTED]: {
    from: ['REQUESTED', 'CONFIRMED'],
    to: 'CANCELLED',
    releases: true,
    actorOf: (env) => env.payload.requested_by,
    allowedActors: (row) => [row.guest_id, row.host_id],
    reasonOf: (env) => env.payload.cancellation_reason,
    outcome: TOPICS.BOOKING_CANCELLED,
    suffix: 'cancelled',
  },
};

async function publishTransitionOutcome(env, spec, row, previous, reason) {
  await publishOutcome(env, { topic: spec.outcome, suffix: spec.suffix, row, previous, to: spec.to, reason });
  if (spec.simulatePayment) {
    // Simulated payment. The charge goes through once the host confirms.
    await bus.publish(TOPICS.PAYMENT_COMPLETED, createEnvelope({
      eventType: TOPICS.PAYMENT_COMPLETED,
      traceId: env.trace_id,
      actorId: ACTOR,
      actorType: 'service',
      entityType: 'reservation',
      entityId: row.reservation_id,
      idempotencyKey: `${env.idempotency_key}:payment`,
      payload: { reservation_id: row.reservation_id, amount: Number(row.total_price), currency: 'USD', method: 'simulated' },
    }), row.reservation_id);
  }
}

async function handleTransition(env, { topic }) {
  const spec = TRANSITIONS[topic];
  const id = env.payload.reservation_id;

  const result = await withTransaction(async (conn) => {
    const first = await claimEvent(conn, GROUP, env, topic);
    const row = await repo.lockReservation(conn, id); // lock it so two changes to one booking cannot overlap
    if (!row) throw new PermanentError(`reservation ${id} does not exist`);

    if (!first) {
      const previous = row.status === spec.to ? await repo.previousStatusBefore(conn, id, spec.to) : null;
      return { kind: 'duplicate', row, previous };
    }
    // The API already checked who is calling. Refuse an event that names someone else.
    const actor = spec.actorOf(env);
    if (env.actor_type !== 'admin' && !spec.allowedActors(row).includes(actor)) {
      throw new PermanentError(`${actor} may not ${topic} reservation ${id}`);
    }
    // Someone got there first, like the guest cancelling while the host approves. Nothing to do.
    if (!spec.from.includes(row.status)) return { kind: 'ignored', row };

    const reason = spec.reasonOf(env);
    await repo.setStatus(conn, { reservationId: id, from: row.status, to: spec.to, reason });
    if (spec.releases) await repo.releaseNights(conn, id);
    await repo.recordStatus(conn, { reservationId: id, from: row.status, to: spec.to, actorId: actor, reason, traceId: env.trace_id });
    return { kind: 'applied', row, previous: row.status, reason };
  });

  logger.info(`${topic} processed`, { trace_id: env.trace_id, reservation_id: id, outcome: result.kind, status: result.row.status });
  if (result.kind === 'applied') {
    await publishTransitionOutcome(env, spec, result.row, result.previous, result.reason);
  } else if (result.kind === 'duplicate' && result.row.status === spec.to) {
    // Already applied. Send the outcome again in case the first attempt died before sending it.
    await publishTransitionOutcome(env, spec, result.row, result.previous, result.row.cancellation_reason);
  } else if (result.kind === 'ignored') {
    logger.warn('transition ignored, reservation is no longer in a valid state', { trace_id: env.trace_id, reservation_id: id, topic, status: result.row.status });
  }
  return result.kind;
}

const handlers = {
  [TOPICS.BOOKING_REQUESTED]: handleBookingRequested,
  [TOPICS.BOOKING_APPROVED]: handleTransition,
  [TOPICS.BOOKING_DECLINED]: handleTransition,
  [TOPICS.BOOKING_CANCEL_REQUESTED]: handleTransition,
};

async function main() {
  await bus.consume({
    groupId: GROUP,
    topics: Object.keys(handlers),
    handler: (env, meta) => handlers[meta.topic](env, meta),
  });
  logger.info('booking-worker consuming', { topics: Object.keys(handlers) });
  // Expire and complete bookings on a timer. Safe with several workers because each change locks the row.
  startScheduler(bus);
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

module.exports = { handleBookingRequested, handleTransition, handlers, bus };
