// Database access for reservations, nights, status history and idempotency keys.
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

// Keys are kept for 24 hours (API doc section 1).
/** Title and city for a set of properties, as a Map keyed by property id. Lets trips show names without counting as a listing view. */
async function propertySummaries(propertyIds) {
  if (!propertyIds.length) return new Map();
  const [rows] = await getMysql().query('SELECT property_id, title, city FROM properties WHERE property_id IN (?)', [propertyIds]);
  return new Map(rows.map((r) => [r.property_id, { title: r.title, city: r.city }]));
}

/** An active (requested or confirmed) booking by the same guest for the same property and dates. */
async function findActiveDuplicate(guestId, propertyId, checkIn, checkOut) {
  const [rows] = await getMysql().execute(
    `SELECT reservation_id FROM reservations
     WHERE guest_id = ? AND property_id = ? AND check_in = ? AND check_out = ? AND status IN ('REQUESTED', 'CONFIRMED') LIMIT 1`,
    [guestId, propertyId, checkIn, checkOut],
  );
  return rows[0] || null;
}

async function findIdempotentResponse(key) {
  const [rows] = await getMysql().execute(
    `SELECT request_hash, response_status, response_body, actor_id FROM idempotency_keys
     WHERE idempotency_key = ? AND created_at > NOW(3) - INTERVAL 24 HOUR`,
    [key],
  );
  return rows[0] || null;
}

// idempotency_keys.actor_id was added after the first schema. New databases get it from
// 001_schema.sql, and an older one is upgraded here the first time it is needed.
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getMysql();
      const [cols] = await db.execute(
        `SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'idempotency_keys' AND COLUMN_NAME = 'actor_id'`,
      );
      if (!cols.length) {
        try {
          await db.execute('ALTER TABLE idempotency_keys ADD COLUMN actor_id VARCHAR(40) NULL');
        } catch (err) {
          if (err.code !== 'ER_DUP_FIELDNAME') throw err; // another service already added it
        }
      }
    })().catch((err) => { schemaReady = null; throw err; });
  }
  return schemaReady;
}

/**
 * The fingerprint identifies the request (route and body). It is hashed so a reused key
 * with a different request can be caught. actorId is who made the request, and only that
 * person can look at a booking that is still pending.
 */
async function saveIdempotentResponse(key, fingerprint, status, responseBody, actorId = null) {
  await ensureSchema();
  const db = getMysql();
  // An expired key still holds the primary key, so remove it before saving again.
  await db.execute('DELETE FROM idempotency_keys WHERE idempotency_key = ? AND created_at <= NOW(3) - INTERVAL 24 HOUR', [key]);
  await db.execute(
    'INSERT IGNORE INTO idempotency_keys (idempotency_key, request_hash, response_status, response_body, actor_id) VALUES (?, ?, ?, ?, ?)',
    [key, hashBody(fingerprint), status, JSON.stringify(responseBody), actorId],
  );
}

/**
 * Inserts the reservation and one row per night in the caller's transaction.
 * Throws ER_DUP_ENTRY if any night is already taken.
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

// Helpers for the worker: changing a booking's status

/** Locks the row so two changes to the same reservation run one after the other. */
async function lockReservation(conn, reservationId) {
  const [rows] = await conn.execute('SELECT * FROM reservations WHERE reservation_id = ? FOR UPDATE', [reservationId]);
  return rows[0] || null;
}

/**
 * Changes the status from one value to another. The status = from check means a
 * change can only happen once. Returns true if a row changed.
 */
async function setStatus(conn, { reservationId, from, to, reason }) {
  const [res] = await conn.execute(
    `UPDATE reservations SET status = ?, cancellation_reason = COALESCE(?, cancellation_reason), version = version + 1
     WHERE reservation_id = ? AND status = ?`,
    [to, reason || null, reservationId, from],
  );
  return res.affectedRows === 1;
}

/** Frees the nights so others can book them and search shows them again. */
async function releaseNights(conn, reservationId) {
  await conn.execute('DELETE FROM reservation_nights WHERE reservation_id = ?', [reservationId]);
}

/**
 * Takes a shared lock on the property row. A host blocking dates takes the exclusive
 * lock on the same row, so a booking and a block on one property can never both pass
 * their checks at the same time.
 */
async function lockPropertyShared(conn, propertyId) {
  await conn.execute('SELECT property_id FROM properties WHERE property_id = ? FOR SHARE', [propertyId]);
}

/**
 * Reads the guest's row with a shared lock. A delete takes the exclusive lock on the same row,
 * so the delete and a new booking for that guest cannot slip past each other.
 */
async function lockGuestShared(conn, guestId) {
  const [rows] = await conn.execute('SELECT guest_id, is_deleted FROM guests WHERE guest_id = ? FOR SHARE', [guestId]);
  return rows[0] || null;
}

/** Does a host block overlap the stay from checkIn up to checkOut? */
async function hasBlockedDates(conn, propertyId, checkIn, checkOut) {
  const [rows] = await conn.execute(
    `SELECT 1 FROM availability_blocks
     WHERE property_id = ? AND status = 'blocked' AND start_date < ? AND end_date > ? LIMIT 1`,
    [propertyId, checkOut, checkIn],
  );
  return rows.length > 0;
}

/** The status a booking had just before it moved to toStatus. Used when an outcome event is sent again. */
async function previousStatusBefore(conn, reservationId, toStatus) {
  const [rows] = await conn.execute(
    'SELECT from_status FROM reservation_status_history WHERE reservation_id = ? AND to_status = ? ORDER BY id DESC LIMIT 1',
    [reservationId, toStatus],
  );
  return rows[0] ? rows[0].from_status : null;
}

// Helpers for the scheduler: expiring and completing bookings

const SCHEDULER_GROUP = 'booking-scheduler-cg';

/**
 * Bookings that might need to expire: pending with no host action for the given hours,
 * or with a check-in date that has arrived (local date). The scheduler makes the exact
 * call under the row lock, including the check-in time.
 */
async function findExpirable(hours, localToday, limit = 100) {
  const [rows] = await getMysql().query(
    `SELECT reservation_id FROM reservations
     WHERE status = 'REQUESTED' AND (booking_datetime <= NOW(3) - INTERVAL ? HOUR OR check_in <= ?)
     ORDER BY booking_datetime LIMIT ?`,
    [hours, localToday, limit],
  );
  return rows.map((r) => r.reservation_id);
}

/** Bookings that might be complete: confirmed, with a check-out date (local) that has arrived. */
async function findCompletable(localToday, limit = 100) {
  const [rows] = await getMysql().query(
    "SELECT reservation_id FROM reservations WHERE status = 'CONFIRMED' AND check_out <= ? ORDER BY check_out LIMIT ?",
    [localToday, limit],
  );
  return rows.map((r) => r.reservation_id);
}

/**
 * Expired or completed bookings that have no published marker yet, because the
 * scheduler died or Kafka was down.
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

/** Saves that the announcement for this status was sent. Safe to repeat. */
async function markPublished(reservation, eventId, topic) {
  await getMysql().execute(
    'INSERT IGNORE INTO processed_events (consumer_group, idempotency_key, event_id, topic) VALUES (?, ?, ?, ?)',
    [SCHEDULER_GROUP, `published:${reservation.status}:${reservation.reservation_id}`, eventId, topic],
  );
}

// Read queries (API doc section 5)

/** Turns a MySQL datetime string like 2026-10-27 15:10:02.114 into ISO UTC like 2026-10-27T15:10:02.114Z. */
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
 * Accepted by the API but not written by the worker yet, so it only exists in the
 * Idempotency-Key record. This lets /bookings/get answer PENDING.
 */
async function findPendingReservation(reservationId) {
  // The reservation id is res_ plus the Idempotency-Key without dashes, so the key is
  // rebuilt from the id and read by primary key. No scan of the table is needed.
  const hex = /^res_([0-9a-f]{32})$/i.exec(reservationId || '')?.[1];
  if (!hex) return null;
  const key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  await ensureSchema();
  const [rows] = await getMysql().execute(
    `SELECT actor_id, response_body FROM idempotency_keys
     WHERE idempotency_key = ? AND created_at > NOW(3) - INTERVAL 24 HOUR`,
    [key],
  );
  const data = rows[0] && (typeof rows[0].response_body === 'string' ? JSON.parse(rows[0].response_body) : rows[0].response_body)?.data;
  if (!data || data.reservation_id !== reservationId || data.status !== 'PENDING') return null;
  return { reservation_id: reservationId, status: 'PENDING', owner_id: rows[0].actor_id };
}

async function findPropertyOwner(propertyId) {
  const [rows] = await getMysql().execute('SELECT property_id, host_id FROM properties WHERE property_id = ?', [propertyId]);
  return rows[0] || null;
}

/** Shared by byProperty and byGuest. Builds the WHERE clause, then runs the count and the page. */
async function pagedReservations({ column, value, statuses, from, to, page, pageSize, select }) {
  const where = [`${column} = ?`];
  const params = [value];
  if (statuses && statuses.length) {
    where.push('status IN (?)');
    params.push(statuses);
  }
  // Stays that overlap from and to: they start on or before to and end after from.
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
 * (review service). If Mongo is down we just show the prompt again.
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
  findActiveDuplicate,
  propertySummaries,
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
  lockGuestShared,
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
