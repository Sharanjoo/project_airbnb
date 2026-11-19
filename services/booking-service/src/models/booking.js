// Data access layer for reservations, nights, status history and idempotency keys.
const { createHash } = require('crypto');
const { getMysql, getMongo } = require('@airbnb/common');
const { eachNight } = require('../pricing');

const hashBody = (body) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

async function findPropertyForBooking(propertyId) {
  const [rows] = await getMysql().execute(
    'SELECT property_id, host_id, status, capacity, nightly_price, cleaning_fee FROM properties WHERE property_id = ?',
    [propertyId],
  );
  return rows[0] || null;
}

// Keys are remembered for 24 hours (API doc §1).
async function findIdempotentResponse(key) {
  const [rows] = await getMysql().execute(
    `SELECT request_hash, response_status, response_body FROM idempotency_keys
     WHERE idempotency_key = ? AND created_at > NOW(3) - INTERVAL 24 HOUR`,
    [key],
  );
  return rows[0] || null;
}

/** `fingerprint` is whatever identifies the request (route + body); it is hashed so a reused key with a different request can be detected. */
async function saveIdempotentResponse(key, fingerprint, status, responseBody) {
  const db = getMysql();
  // An expired key still occupies the primary key; clear it so the key can be used again.
  await db.execute('DELETE FROM idempotency_keys WHERE idempotency_key = ? AND created_at <= NOW(3) - INTERVAL 24 HOUR', [key]);
  await db.execute(
    'INSERT IGNORE INTO idempotency_keys (idempotency_key, request_hash, response_status, response_body) VALUES (?, ?, ?, ?)',
    [key, hashBody(fingerprint), status, JSON.stringify(responseBody)],
  );
}

/**
 * Insert reservation + one row per night in the caller's transaction.
 * Throws ER_DUP_ENTRY if any night is already taken (13.1 guarantee).
 */
async function insertReservationWithNights(conn, p, status, traceId) {
  await conn.execute(
    `INSERT INTO reservations (reservation_id, property_id, guest_id, host_id, check_in, check_out,
       guest_count, price_breakdown, total_price, status, guest_message, trace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.reservation_id, p.property_id, p.guest_id, p.host_id, p.check_in, p.check_out, p.guest_count,
      JSON.stringify(p.price_breakdown), p.price_breakdown.total, status, p.guest_message, traceId],
  );
  for (const night of eachNight(p.check_in, p.check_out)) {
    await conn.execute(
      'INSERT INTO reservation_nights (property_id, night, reservation_id) VALUES (?, ?, ?)',
      [p.property_id, night, p.reservation_id],
    );
  }
}

async function insertRejectedReservation(conn, p, reason, traceId) {
  await conn.execute(
    `INSERT INTO reservations (reservation_id, property_id, guest_id, host_id, check_in, check_out,
       guest_count, price_breakdown, total_price, status, cancellation_reason, guest_message, trace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REJECTED', ?, ?, ?)`,
    [p.reservation_id, p.property_id, p.guest_id, p.host_id, p.check_in, p.check_out, p.guest_count,
      JSON.stringify(p.price_breakdown), p.price_breakdown.total, reason, p.guest_message, traceId],
  );
}

async function recordStatus(conn, { reservationId, from, to, actorId, reason, traceId }) {
  await conn.execute(
    `INSERT INTO reservation_status_history (reservation_id, from_status, to_status, actor_id, reason, trace_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [reservationId, from, to, actorId, reason || null, traceId],
  );
}

// ---------------------------------------------------------------- worker transitions (13.1, 13.2)

/** Row lock: concurrent approve / cancel / expiry for one reservation run one after another. */
async function lockReservation(conn, reservationId) {
  const [rows] = await conn.execute('SELECT * FROM reservations WHERE reservation_id = ? FOR UPDATE', [reservationId]);
  return rows[0] || null;
}

/**
 * Move a reservation from one status to another. The `status = from` guard means
 * a transition can only happen once. Returns true if a row changed.
 */
async function setStatus(conn, { reservationId, from, to, reason }) {
  const [res] = await conn.execute(
    `UPDATE reservations SET status = ?, cancellation_reason = COALESCE(?, cancellation_reason), version = version + 1
     WHERE reservation_id = ? AND status = ?`,
    [to, reason || null, reservationId, from],
  );
  return res.affectedRows === 1;
}

/** Free the nights so other guests can book them (and search shows them again). */
async function releaseNights(conn, reservationId) {
  await conn.execute('DELETE FROM reservation_nights WHERE reservation_id = ?', [reservationId]);
}

/**
 * Shared lock on the property row. A host blocking dates (Property Service)
 * takes the exclusive lock on the same row, so a booking and a block for the
 * same property can never both pass their checks at the same time.
 */
async function lockPropertyShared(conn, propertyId) {
  await conn.execute('SELECT property_id FROM properties WHERE property_id = ? FOR SHARE', [propertyId]);
}

/** Does a host block overlap the stay [checkIn, checkOut)? */
async function hasBlockedDates(conn, propertyId, checkIn, checkOut) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM availability_blocks
     WHERE property_id = ? AND status = 'blocked' AND start_date < ? AND end_date > ? LIMIT 1`,
    [propertyId, checkOut, checkIn],
  );
  return rows.length > 0;
}

/** The status a reservation had just before it moved into `toStatus` (used when an outcome event is re-sent). */
async function previousStatusBefore(conn, reservationId, toStatus) {
  const [rows] = await conn.execute(
    'SELECT from_status FROM reservation_status_history WHERE reservation_id = ? AND to_status = ? ORDER BY id DESC LIMIT 1',
    [reservationId, toStatus],
  );
  return rows[0] ? rows[0].from_status : null;
}

// ---------------------------------------------------------------- scheduler (EXPIRED, COMPLETED)

const SCHEDULER_GROUP = 'booking-scheduler-cg';

/** REQUESTED with no host action for `hours`, or whose check-in day has already arrived. */
async function findExpirable(hours, limit = 100) {
  const [rows] = await getMysql().query(
    `SELECT reservation_id FROM reservations
     WHERE status = 'REQUESTED' AND (booking_datetime <= NOW(3) - INTERVAL ? HOUR OR check_in <= CURDATE())
     ORDER BY booking_datetime LIMIT ?`,
    [hours, limit],
  );
  return rows.map((r) => r.reservation_id);
}

/** CONFIRMED stays whose check-out day has arrived. */
async function findCompletable(limit = 100) {
  const [rows] = await getMysql().query(
    "SELECT reservation_id FROM reservations WHERE status = 'CONFIRMED' AND check_out <= CURDATE() ORDER BY check_out LIMIT ?",
    [limit],
  );
  return rows.map((r) => r.reservation_id);
}

/**
 * Reservations the scheduler moved to COMPLETED / EXPIRED whose announcement has
 * no "published" marker yet (the scheduler may have died, or Kafka was down).
 */
async function findUnpublished(lookbackDays, limit = 100) {
  const [rows] = await getMysql().query(
    `SELECT r.* FROM reservations r
     LEFT JOIN processed_events pe ON pe.consumer_group = ? AND pe.idempotency_key = CONCAT('published:', r.status, ':', r.reservation_id)
     WHERE r.status IN ('COMPLETED', 'EXPIRED') AND r.check_out >= CURDATE() - INTERVAL ? DAY AND pe.idempotency_key IS NULL
     ORDER BY r.check_out LIMIT ?`,
    [SCHEDULER_GROUP, lookbackDays, limit],
  );
  return rows;
}

/** Remember that the announcement for this status was published. Safe to repeat. */
async function markPublished(reservation, eventId, topic) {
  await getMysql().execute(
    'INSERT IGNORE INTO processed_events (consumer_group, idempotency_key, event_id, topic) VALUES (?, ?, ?, ?)',
    [SCHEDULER_GROUP, `published:${reservation.status}:${reservation.reservation_id}`, eventId, topic],
  );
}

// ---------------------------------------------------------------- reads (API doc §5)

/** MySQL DATETIME(3) string ("2026-10-27 15:10:02.114") -> ISO 8601 UTC ("2026-10-27T15:10:02.114Z"). */
const toIso = (dt) => (dt ? `${String(dt).replace(' ', 'T')}Z` : null);

async function findReservation(reservationId) {
  const [rows] = await getMysql().execute('SELECT * FROM reservations WHERE reservation_id = ?', [reservationId]);
  return rows[0] || null;
}

async function listStatusHistory(reservationId) {
  const [rows] = await getMysql().execute(
    `SELECT from_status, to_status, actor_id, reason, at FROM reservation_status_history
     WHERE reservation_id = ? ORDER BY at, id`,
    [reservationId],
  );
  return rows.map((h) => ({
    from_status: h.from_status, to_status: h.to_status, actor_id: h.actor_id, reason: h.reason, at: toIso(h.at),
  }));
}

/**
 * Accepted by the API but not yet written by the worker: the reservation only
 * exists in the Idempotency-Key record. Lets /bookings/get answer PENDING.
 */
async function findPendingReservation(reservationId) {
  const [rows] = await getMysql().execute(
    "SELECT response_body FROM idempotency_keys WHERE JSON_UNQUOTE(JSON_EXTRACT(response_body, '$.data.reservation_id')) = ? LIMIT 1",
    [reservationId],
  );
  return rows[0] ? { reservation_id: reservationId, status: 'PENDING' } : null;
}

async function findPropertyOwner(propertyId) {
  const [rows] = await getMysql().execute('SELECT property_id, host_id FROM properties WHERE property_id = ?', [propertyId]);
  return rows[0] || null;
}

/** Shared by byProperty / byGuest: build the WHERE tail, run count + page. */
async function pagedReservations({ column, value, statuses, from, to, page, pageSize, select }) {
  const where = [`${column} = ?`];
  const params = [value];
  if (statuses && statuses.length) {
    where.push('status IN (?)');
    params.push(statuses);
  }
  // Stays that overlap [from, to]: starts on or before `to`, ends after `from`.
  if (to) { where.push('check_in <= ?'); params.push(to); }
  if (from) { where.push('check_out > ?'); params.push(from); }
  const clause = where.join(' AND ');

  const db = getMysql();
  const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM reservations WHERE ${clause}`, params);
  const [rows] = await db.query(
    `SELECT ${select} FROM reservations WHERE ${clause} ORDER BY check_in DESC, reservation_id LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { rows, total: Number(n) };
}

const listByProperty = (o) => pagedReservations({
  ...o,
  column: 'property_id',
  value: o.propertyId,
  select: 'reservation_id, guest_id, check_in, check_out, guest_count, total_price, status, booking_datetime',
});

const listByGuest = (o) => pagedReservations({
  ...o,
  column: 'guest_id',
  value: o.guestId,
  select: 'reservation_id, property_id, check_in, check_out, total_price, status, booking_datetime',
});

/**
 * Which of these completed stays already have a review? Reviews live in MongoDB
 * (Review Service). If Mongo is unreachable the prompt is simply shown again.
 */
async function reviewedReservationIds(reservationIds) {
  if (!reservationIds.length) return new Set();
  try {
    const reviews = (await getMongo()).collection('reviews');
    const docs = await reviews.find({ reservation_id: { $in: reservationIds } }, { projection: { reservation_id: 1 } }).toArray();
    return new Set(docs.map((d) => d.reservation_id));
  } catch {
    return new Set();
  }
}

module.exports = {
  hashBody,
  toIso,
  findPropertyForBooking,
  findIdempotentResponse,
  saveIdempotentResponse,
  insertReservationWithNights,
  insertRejectedReservation,
  recordStatus,
  lockReservation,
  setStatus,
  releaseNights,
  lockPropertyShared,
  hasBlockedDates,
  previousStatusBefore,
  SCHEDULER_GROUP,
  findExpirable,
  findCompletable,
  findUnpublished,
  markPublished,
  findReservation,
  listStatusHistory,
  findPendingReservation,
  findPropertyOwner,
  listByProperty,
  listByGuest,
  reviewedReservationIds,
};
