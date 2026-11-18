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

async function findIdempotentResponse(key) {
  const [rows] = await getMysql().execute(
    'SELECT response_status, response_body FROM idempotency_keys WHERE idempotency_key = ?',
    [key],
  );
  return rows[0] || null;
}

async function saveIdempotentResponse(key, requestBody, status, responseBody) {
  await getMysql().execute(
    'INSERT IGNORE INTO idempotency_keys (idempotency_key, request_hash, response_status, response_body) VALUES (?, ?, ?, ?)',
    [key, hashBody(requestBody), status, JSON.stringify(responseBody)],
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
  toIso,
  findPropertyForBooking,
  findIdempotentResponse,
  saveIdempotentResponse,
  insertReservationWithNights,
  insertRejectedReservation,
  recordStatus,
  findReservation,
  listStatusHistory,
  findPendingReservation,
  findPropertyOwner,
  listByProperty,
  listByGuest,
  reviewedReservationIds,
};
