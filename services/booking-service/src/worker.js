// Booking Worker: a separate process from the Booking API (spec §3.1).
//
//   booking.requested        -> claim the nights (or reject: taken / blocked by the host)
//   booking.approved         -> CONFIRMED, publishes booking.confirmed + payment.completed
//   booking.declined         -> DECLINED, nights released, publishes booking.rejected (new_status DECLINED)
//   booking.cancel_requested -> CANCELLED, nights released, publishes booking.cancelled
//   (timer, src/scheduler.js)  -> EXPIRED after 24 h without a host reply, COMPLETED after check-out
//
// Reliability rules (API doc §10, feature 13.2):
//  - each handler does its database work in ONE transaction together with
//    claimEvent(), so a redelivered event is applied exactly once;
//  - outcome events are published AFTER the commit. If the worker dies between
//    the commit and the publish, the redelivered event is a duplicate for the
//    database but still re-publishes the outcome (same idempotency_key), so the
//    outcome is never lost and downstream consumers dedupe it.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'booking-worker';
const {
  EventBus, PermanentError, withTransaction, claimEvent, createEnvelope, TOPICS, logger,
} = require('@airbnb/common');
const repo = require('./models/booking');
const { startScheduler } = require('./scheduler');

const GROUP = 'booking-worker-cg';
const ACTOR = 'svc:booking-worker';
const bus = new EventBus('booking-worker');

/** Publish one outcome event for a reservation. The key (property_id) keeps a property's events in order. */
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

// ------------------------------------------------------------------ booking.requested

async function handleBookingRequested(env, { topic }) {
  const p = env.payload;
  const result = await withTransaction(async (conn) => {
    // Duplicate delivery (redelivery after a crash, retry): skip the write, but report what happened.
    if (!(await claimEvent(conn, GROUP, env, topic))) {
      const existing = await repo.lockReservation(conn, p.reservation_id);
      return { outcome: 'duplicate', rejected: existing && existing.status === 'REJECTED' ? existing.cancellation_reason : null };
    }

    // Savepoint so a lost race on nights does not undo the processed_events row.
    await conn.query('SAVEPOINT claim_nights');
    let rejectedReason = null;
    try {
      // Serialise against a host blocking dates on this property (Property Service holds the exclusive lock).
      await repo.lockPropertyShared(conn, p.property_id);
      if (await repo.hasBlockedDates(conn, p.property_id, p.check_in, p.check_out)) {
        rejectedReason = 'DATE_CONFLICT'; // inside dates the host has blocked
      } else {
        await repo.insertReservationWithNights(conn, p, 'REQUESTED', env.trace_id);
        await repo.recordStatus(conn, { reservationId: p.reservation_id, from: null, to: 'REQUESTED', actorId: ACTOR, traceId: env.trace_id });
      }
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
      await conn.query('ROLLBACK TO SAVEPOINT claim_nights');
      rejectedReason = 'DATE_CONFLICT'; // another reservation holds a night (13.1)
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
  // The guest's "request received" push comes from booking.requested itself (the notification gateway can consume it).
}

// ------------------------------------------------------------------ approve / decline / cancel

const TRANSITIONS = {
  [TOPICS.BOOKING_APPROVED]: {
    from: ['REQUESTED'],
    to: 'CONFIRMED',
    releases: false,
    actorOf: (env) => env.payload.host_id,
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
    actorOf: (env) => env.payload.host_id,
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
    // Simulated payment (spec): the charge succeeds when the host confirms.
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
    const row = await repo.lockReservation(conn, id); // serialises with any other change to this reservation
    if (!row) throw new PermanentError(`reservation ${id} does not exist`);

    if (!first) {
      const previous = row.status === spec.to ? await repo.previousStatusBefore(conn, id, spec.to) : null;
      return { kind: 'duplicate', row, previous };
    }
    // The API already checked who is calling; refuse an event that claims someone else.
    const actor = spec.actorOf(env);
    if (env.actor_type !== 'admin' && !spec.allowedActors(row).includes(actor)) {
      throw new PermanentError(`${actor} may not ${topic} reservation ${id}`);
    }
    // Someone got there first (e.g. the guest cancelled while the host was approving): nothing to do.
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
    // Already applied: re-send the outcome in case the first delivery died before publishing it.
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
  // EXPIRED / COMPLETED timer. Safe with several replicas: every change is row-locked and status-guarded.
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
