// Data access layer for reservations, nights, status history and idempotency keys.
const { createHash } = require('crypto');
const { getMysql } = require('@airbnb/common');
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

module.exports = {
  findPropertyForBooking,
  findIdempotentResponse,
  saveIdempotentResponse,
  insertReservationWithNights,
  insertRejectedReservation,
  recordStatus,
};
