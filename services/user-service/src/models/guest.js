// Data access layer for guests (spec §3.1: entity objects use the DAL to select, insert, update).
// Every query is parameterised; route handlers never build SQL themselves.
const { getMysql, withTransaction } = require('@airbnb/common');

const PUBLIC_COLUMNS = `guest_id, first_name, last_name, email, phone, location, profile_photo_url,
  preferences, saved_properties_count, booking_count, profile_created_datetime, version`;

const iso = (v) => (v ? `${String(v).replace(' ', 'T')}Z` : null); // MySQL DATETIME (UTC) -> ISO 8601

/** DB row -> API shape. Never includes password_hash or is_deleted. */
function toApi(row) {
  if (!row) return null;
  return {
    guest_id: row.guest_id,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone ?? null,
    location: row.location ?? null,
    profile_photo_url: row.profile_photo_url ?? null,
    preferences: typeof row.preferences === 'string' ? JSON.parse(row.preferences) : (row.preferences ?? null),
    saved_properties_count: row.saved_properties_count,
    booking_count: row.booking_count,
    profile_created_datetime: iso(row.profile_created_datetime),
    version: row.version,
  };
}

async function findById(guestId) {
  const [rows] = await getMysql().execute(
    `SELECT ${PUBLIC_COLUMNS} FROM guests WHERE guest_id = ? AND is_deleted = FALSE`,
    [guestId],
  );
  return rows[0] || null;
}

/** Login lookup. Returns the full row, including password_hash; never send it to a client. */
async function findByEmail(email) {
  const [rows] = await getMysql().execute('SELECT * FROM guests WHERE email = ? AND is_deleted = FALSE', [email]);
  return rows[0] || null;
}

/**
 * Insert a new guest. The UNIQUE key on email is the only duplicate check, so two
 * concurrent sign-ups with the same email cannot both succeed: the loser gets
 * ER_DUP_ENTRY, which the route turns into 409. Counters, version and timestamps
 * use the column defaults.
 */
async function insert(g) {
  await getMysql().execute(
    `INSERT INTO guests (guest_id, first_name, last_name, email, password_hash, phone, location, profile_photo_url, preferences)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      g.guest_id, g.first_name, g.last_name, g.email, g.password_hash,
      g.phone ?? null, g.location ?? null, g.profile_photo_url ?? null,
      g.preferences ? JSON.stringify(g.preferences) : null,
    ],
  );
  return findById(g.guest_id);
}

/** Includes soft-deleted guests, so callers can tell 404 (never existed) from "already deleted". */
async function findByIdAnyStatus(guestId) {
  const [rows] = await getMysql().execute(`SELECT ${PUBLIC_COLUMNS}, is_deleted FROM guests WHERE guest_id = ?`, [guestId]);
  return rows[0] || null;
}

// Fields a guest may change through /guests/update: API field -> column.
// Email, password, counters, version and is_deleted are deliberately absent.
const EDITABLE = {
  first_name: 'first_name',
  last_name: 'last_name',
  phone: 'phone',
  location: 'location',
  profile_photo_url: 'profile_photo_url',
  preferences: 'preferences',
};

/**
 * Optimistic lock: the UPDATE only matches when the caller's version is current.
 * Returns { updated: true, row } or { updated: false, row } with the current row
 * (null if the guest does not exist) so the caller can answer 404 / 409.
 */
async function updateWithVersion(guestId, version, changes) {
  const sets = [];
  const params = [];
  for (const [field, value] of Object.entries(changes)) {
    const column = EDITABLE[field];
    if (!column) throw new Error(`guest field ${field} is not editable`); // routes validate first; this is a backstop
    sets.push(`${column} = ?`);
    params.push(field === 'preferences' && value !== null ? JSON.stringify(value) : value);
  }
  // UPDATE and read-back in one transaction: on success the row stays locked until
  // commit, so the returned row (and the version in user.updated) is exactly this
  // edit's result, never a concurrent edit that landed in between.
  return withTransaction(async (conn) => {
    const [res] = await conn.execute(
      `UPDATE guests SET ${sets.join(', ')}, version = version + 1
       WHERE guest_id = ? AND version = ? AND is_deleted = FALSE`,
      [...params, guestId, version],
    );
    const [rows] = await conn.execute(`SELECT ${PUBLIC_COLUMNS}, is_deleted FROM guests WHERE guest_id = ?`, [guestId]);
    return { updated: res.affectedRows === 1, row: rows[0] || null };
  });
}

/** Soft delete. Returns true if this call deleted the guest, false if it was already deleted or missing. */
async function softDelete(guestId) {
  const [res] = await getMysql().execute(
    'UPDATE guests SET is_deleted = TRUE, version = version + 1 WHERE guest_id = ? AND is_deleted = FALSE',
    [guestId],
  );
  return res.affectedRows === 1;
}

const ACTIVE_RESERVATIONS = `SELECT COUNT(*) AS n FROM reservations
     WHERE guest_id = ? AND status IN ('REQUESTED', 'CONFIRMED') AND check_out > CURRENT_DATE()`;

/**
 * Soft delete, unless the guest has an active reservation. One transaction:
 *  - the guest row is locked FOR UPDATE first, so two deletes cannot interleave, and a
 *    reservation insert (booking-worker) cannot run alongside: its foreign key check needs
 *    a shared lock on this same guest row. A booking transaction that is already writing
 *    makes this lock wait until it commits; one that starts later waits for this delete.
 *  - reservations are then counted with a plain read. Its snapshot starts at that read
 *    (after the lock was granted), so it sees every booking committed before the delete.
 *    Deliberately not FOR SHARE: a locking range read takes gap locks on the reservations
 *    index and can deadlock with other guests' inserts (seen in testing).
 * Returns { outcome: 'deleted', version } | { outcome: 'already' } | { outcome: 'missing' }
 *       | { outcome: 'active', active }.
 */
async function softDeleteIfNoActiveReservations(guestId) {
  return withTransaction(async (conn) => {
    const [[g]] = await conn.execute('SELECT is_deleted, version FROM guests WHERE guest_id = ? FOR UPDATE', [guestId]);
    if (!g) return { outcome: 'missing' };
    if (g.is_deleted) return { outcome: 'already' };
    const [[{ n }]] = await conn.execute(ACTIVE_RESERVATIONS, [guestId]);
    if (Number(n) > 0) return { outcome: 'active', active: Number(n) };
    await conn.execute('UPDATE guests SET is_deleted = TRUE, version = version + 1 WHERE guest_id = ?', [guestId]);
    return { outcome: 'deleted', version: g.version + 1 };
  });
}

/** Same rule as property delete (slice 2): a request or confirmed stay that has not ended yet. */
async function countActiveReservations(guestId) {
  const [rows] = await getMysql().execute(
    `SELECT COUNT(*) AS n FROM reservations
     WHERE guest_id = ? AND status IN ('REQUESTED', 'CONFIRMED') AND check_out > CURRENT_DATE()`,
    [guestId],
  );
  return Number(rows[0].n);
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Admin search. q matches part of the full name or the start of the email. Newest first. */
async function search({ q, location, includeDeleted = false, page = 1, pageSize = 20 }) {
  const where = [];
  const params = [];
  if (!includeDeleted) where.push('is_deleted = FALSE');
  if (q) {
    where.push("(CONCAT(first_name, ' ', last_name) LIKE ? OR email LIKE ?)");
    params.push(`%${escapeLike(q)}%`, `${escapeLike(q.toLowerCase())}%`);
  }
  if (location) {
    where.push('location LIKE ?');
    params.push(`${escapeLike(location)}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getMysql();
  const [[{ total }]] = await db.execute(`SELECT COUNT(*) AS total FROM guests ${clause}`, params);
  // LIMIT/OFFSET are validated integers; inlined because mysql2 prepared statements reject them as strings
  const [rows] = await db.execute(
    `SELECT ${PUBLIC_COLUMNS}, is_deleted FROM guests ${clause}
     ORDER BY profile_created_datetime DESC, guest_id LIMIT ${Number(pageSize)} OFFSET ${(Number(page) - 1) * Number(pageSize)}`,
    params,
  );
  return { rows, total: Number(total) };
}

// ---------------------------------------------------------------- counters (user worker)
// Counters are derived data: they never bump `version`, so a guest editing their
// profile does not get a VERSION_CONFLICT because they just saved a listing.

/** +1 booking for this guest. Call inside the transaction that claimed the event. */
async function incrementBookingCount(conn, guestId) {
  const [res] = await conn.execute('UPDATE guests SET booking_count = booking_count + 1 WHERE guest_id = ?', [guestId]);
  return res.affectedRows === 1;
}

/**
 * Set saved_properties_count from saved_properties, the table property-service
 * writes. Recomputing (instead of +1 / -1) makes the handler idempotent and order
 * independent, and it heals any drift from a property.saved event that was lost
 * because Kafka was down when the guest saved. Same approach as the property worker.
 */
async function recomputeSavedCount(guestId) {
  const [res] = await getMysql().execute(
    `UPDATE guests SET saved_properties_count = (SELECT COUNT(*) FROM saved_properties WHERE guest_id = ?)
     WHERE guest_id = ?`,
    [guestId, guestId],
  );
  if (res.affectedRows !== 1) return null;
  const [[row]] = await getMysql().execute('SELECT saved_properties_count FROM guests WHERE guest_id = ?', [guestId]);
  return row.saved_properties_count;
}

module.exports = {
  toApi, findById, findByIdAnyStatus, findByEmail, insert, updateWithVersion, softDelete,
  softDeleteIfNoActiveReservations, countActiveReservations, search, incrementBookingCount, recomputeSavedCount, EDITABLE,
};
