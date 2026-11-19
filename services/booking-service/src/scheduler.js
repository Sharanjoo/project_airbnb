// Booking scheduler (API doc §5, reservation status transitions). Runs inside the
// booking-worker process on a timer.
//
//   REQUESTED, no host action in 24 h (or check-in day reached) -> EXPIRED, nights released
//   CONFIRMED, check-out day reached                             -> COMPLETED
//
// Every pass has two steps:
//   1. apply: one transaction per reservation (row lock + status guard), so
//      several worker replicas can run this at once and each change happens once;
//   2. announce: publish booking.cancelled (EXPIRED) / booking.completed for every
//      reservation that has no "published" marker yet, then store the marker.
//      If the process dies or Kafka is down between 1 and 2, the next pass
//      announces it, so the review prompt or the freed dates are never lost.
//      Consumers dedupe on the stable idempotency_key.
const { withTransaction, createEnvelope, TOPICS, logger } = require('@airbnb/common');
const repo = require('./models/booking');

const ACTOR = 'svc:booking-scheduler';
const REQUEST_EXPIRY_HOURS = Number(process.env.REQUEST_EXPIRY_HOURS || 24);
const REPUBLISH_LOOKBACK_DAYS = Number(process.env.SCHEDULER_LOOKBACK_DAYS || 7);
const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 60000);

async function expireOne(id) {
  return withTransaction(async (conn) => {
    const row = await repo.lockReservation(conn, id);
    if (!row || row.status !== 'REQUESTED') return false; // approved, declined or cancelled in the meantime
    await repo.setStatus(conn, { reservationId: id, from: 'REQUESTED', to: 'EXPIRED', reason: 'NO_HOST_RESPONSE' });
    await repo.releaseNights(conn, id);
    await repo.recordStatus(conn, { reservationId: id, from: 'REQUESTED', to: 'EXPIRED', actorId: ACTOR, reason: 'NO_HOST_RESPONSE', traceId: row.trace_id });
    return true;
  });
}

async function completeOne(id) {
  return withTransaction(async (conn) => {
    const row = await repo.lockReservation(conn, id);
    if (!row || row.status !== 'CONFIRMED') return false; // cancelled in the meantime
    await repo.setStatus(conn, { reservationId: id, from: 'CONFIRMED', to: 'COMPLETED' });
    await repo.recordStatus(conn, { reservationId: id, from: 'CONFIRMED', to: 'COMPLETED', actorId: ACTOR, traceId: row.trace_id });
    return true;
  });
}

/** The event that announces a scheduler-made status. trace_id is the one from the original request. */
function announcement(row) {
  const expired = row.status === 'EXPIRED';
  const topic = expired ? TOPICS.BOOKING_CANCELLED : TOPICS.BOOKING_COMPLETED;
  const payload = {
    reservation_id: row.reservation_id,
    property_id: row.property_id,
    guest_id: row.guest_id,
    host_id: row.host_id,
  };
  if (expired) {
    Object.assign(payload, {
      check_in: row.check_in, check_out: row.check_out, previous_status: 'REQUESTED', new_status: 'EXPIRED', reason: 'NO_HOST_RESPONSE',
    });
  }
  return {
    topic,
    env: createEnvelope({
      eventType: topic,
      traceId: row.trace_id,
      actorId: ACTOR,
      actorType: 'service',
      entityType: 'reservation',
      entityId: row.reservation_id,
      idempotencyKey: `${row.status.toLowerCase()}:${row.reservation_id}`,
      payload,
    }),
  };
}

/** One scheduler pass. Returns what it did (used by the tests and the logs). */
async function runOnce(bus) {
  const result = { expired: 0, completed: 0, published: 0, failed: 0 };

  for (const id of await repo.findExpirable(REQUEST_EXPIRY_HOURS)) {
    if (await expireOne(id)) result.expired++;
  }
  for (const id of await repo.findCompletable()) {
    if (await completeOne(id)) result.completed++;
  }

  for (const row of await repo.findUnpublished(REPUBLISH_LOOKBACK_DAYS)) {
    const { topic, env } = announcement(row);
    try {
      await bus.publish(topic, env, row.property_id);
      await repo.markPublished(row, env.event_id, topic);
      result.published++;
    } catch (err) {
      result.failed++; // no marker, so the next pass tries again
      logger.warn('scheduler could not publish, will retry', { reservation_id: row.reservation_id, topic, error: err.message });
    }
  }
  return result;
}

/** Start the timer. A pass never overlaps the previous one; errors are logged, never fatal. */
function startScheduler(bus, intervalMs = INTERVAL_MS) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runOnce(bus);
      if (r.expired || r.completed || r.published || r.failed) logger.info('scheduler pass', r);
    } catch (err) {
      logger.error('scheduler pass failed', { error: err.message });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(timer);
}

module.exports = { runOnce, startScheduler, announcement, REQUEST_EXPIRY_HOURS };
