// Scheduler for bookings. It runs inside the booking worker on a timer.
//
// What it does:
//   A pending request expires after 24 hours with no host reply, or when check-in time arrives.
//   A confirmed stay is completed once check-out time has passed.
// Check-in is 15:00 and check-out is 11:00 in the listing's time zone (see timeutil.js).
//
// Each pass has two steps:
// 1. Change the status, one transaction per booking with the row locked.
//    Several workers can run this at once and each change still happens once.
// 2. Announce it with booking.cancelled (expired) or booking.completed, then save a marker.
//    If the process dies or Kafka is down, the next pass sends it again, so nothing is lost.
const { withTransaction, createEnvelope, TOPICS, logger } = require('@airbnb/common');
const repo = require('./models/booking');
const { localDate, checkInInstant, checkOutInstant } = require('./timeutil');

const ACTOR = 'svc:booking-scheduler';
const REQUEST_EXPIRY_HOURS = Number(process.env.REQUEST_EXPIRY_HOURS || 24);
const REPUBLISH_LOOKBACK_DAYS = Number(process.env.SCHEDULER_LOOKBACK_DAYS || 7);
const INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 60000);

/** A pending request expires 24 hours after it was made, or at check-in time, whichever comes first. */
function isExpired(row, now) {
  const ageHours = (now - Date.parse(repo.toIso(row.booking_datetime))) / 3600000;
  return ageHours >= REQUEST_EXPIRY_HOURS || now >= checkInInstant(row.check_in);
}

async function expireOne(id, now = Date.now()) {
  return withTransaction(async (conn) => {
    const row = await repo.lockReservation(conn, id);
    if (!row || row.status !== 'REQUESTED') return false; // approved, declined or cancelled in the meantime
    if (!isExpired(row, now)) return false; // the date matched but the time has not come yet
    await repo.setStatus(conn, { reservationId: id, from: 'REQUESTED', to: 'EXPIRED', reason: 'NO_HOST_RESPONSE' });
    await repo.releaseNights(conn, id);
    await repo.recordStatus(conn, { reservationId: id, from: 'REQUESTED', to: 'EXPIRED', actorId: ACTOR, reason: 'NO_HOST_RESPONSE', traceId: row.trace_id });
    return true;
  });
}

async function completeOne(id, now = Date.now()) {
  return withTransaction(async (conn) => {
    const row = await repo.lockReservation(conn, id);
    if (!row || row.status !== 'CONFIRMED') return false; // cancelled in the meantime
    if (now < checkOutInstant(row.check_out)) return false; // check-out time has not arrived yet
    await repo.setStatus(conn, { reservationId: id, from: 'CONFIRMED', to: 'COMPLETED' });
    await repo.recordStatus(conn, { reservationId: id, from: 'CONFIRMED', to: 'COMPLETED', actorId: ACTOR, traceId: row.trace_id });
    return true;
  });
}

/** Builds the event that announces the new status. It keeps the trace id of the original request. */
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

/** Runs one pass and returns what it did. */
async function runOnce(bus, now = Date.now()) {
  const result = { expired: 0, completed: 0, published: 0, failed: 0 };
  const today = localDate(now);

  for (const id of await repo.findExpirable(REQUEST_EXPIRY_HOURS, today)) {
    if (await expireOne(id, now)) result.expired++;
  }
  for (const id of await repo.findCompletable(today)) {
    if (await completeOne(id, now)) result.completed++;
  }

  for (const row of await repo.findUnpublished(REPUBLISH_LOOKBACK_DAYS)) {
    const { topic, env } = announcement(row);
    try {
      await bus.publish(topic, env, row.property_id);
      await repo.markPublished(row, env.event_id, topic);
      result.published++;
    } catch (err) {
      result.failed++; // no marker saved, so the next pass tries again
      logger.warn('scheduler could not publish, will retry', { reservation_id: row.reservation_id, topic, error: err.message });
    }
  }
  return result;
}

/** Starts the timer. Passes never overlap, and an error is logged instead of crashing the worker. */
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
