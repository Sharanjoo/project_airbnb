// Data access layer for guests (spec §3.1: entity objects use the DAL to select, insert, update).
// Every query is parameterised; route handlers never build SQL themselves.
const { getMysql } = require('@airbnb/common');

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

// TODO (slice 1, phase 2): update with optimistic lock (WHERE version = ?), softDelete, search

module.exports = { toApi, findById, findByEmail, insert };
