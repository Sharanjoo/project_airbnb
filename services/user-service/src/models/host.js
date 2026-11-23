// Data access layer for hosts. Same rules as models/guest.js.
const { getMysql } = require('@airbnb/common');

const PUBLIC_COLUMNS = `host_id, name, email, phone, profile_photo_url, verification_status,
  response_rate, response_time, host_since, access_level, version`;

const iso = (v) => (v ? `${String(v).replace(' ', 'T')}Z` : null);
const num = (v) => (v === null || v === undefined ? null : Number(v));

/** DB row -> API shape. Never includes password_hash, is_deleted or access_level. */
function toApi(row) {
  if (!row) return null;
  return {
    host_id: row.host_id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? null,
    profile_photo_url: row.profile_photo_url ?? null,
    verification_status: row.verification_status,
    response_rate: num(row.response_rate),
    response_time: row.response_time ?? null,
    host_since: iso(row.host_since),
    version: row.version,
  };
}

/**
 * What any signed-in user may see about a host (e.g. on a listing page): no email,
 * phone or version. The host themself and admins get toApi() instead.
 */
function toPublic(row) {
  if (!row) return null;
  const { email, phone, version, ...rest } = toApi(row); // eslint-disable-line no-unused-vars
  return rest;
}

async function findById(hostId) {
  const [rows] = await getMysql().execute(
    `SELECT ${PUBLIC_COLUMNS} FROM hosts WHERE host_id = ? AND is_deleted = FALSE`,
    [hostId],
  );
  return rows[0] || null;
}

/** Login lookup. Returns the full row, including password_hash and access_level. */
async function findByEmail(email) {
  const [rows] = await getMysql().execute('SELECT * FROM hosts WHERE email = ? AND is_deleted = FALSE', [email]);
  return rows[0] || null;
}

/**
 * Insert a new host. access_level and verification_status are deliberately not
 * accepted: they always take the column defaults ('standard', 'pending'), so a
 * public sign-up can never create a superhost or an admin.
 */
async function insert(h) {
  await getMysql().execute(
    `INSERT INTO hosts (host_id, name, email, password_hash, phone, profile_photo_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [h.host_id, h.name, h.email, h.password_hash, h.phone ?? null, h.profile_photo_url ?? null],
  );
  return findById(h.host_id);
}

async function findByIdAnyStatus(hostId) {
  const [rows] = await getMysql().execute(`SELECT ${PUBLIC_COLUMNS}, is_deleted FROM hosts WHERE host_id = ?`, [hostId]);
  return rows[0] || null;
}

// Fields a host may change through /hosts/update. verification_status, access_level,
// response_rate / response_time (analytics), email and password are deliberately absent.
const EDITABLE = { name: 'name', phone: 'phone', profile_photo_url: 'profile_photo_url' };

/** Optimistic lock, same contract as guests.updateWithVersion. */
async function updateWithVersion(hostId, version, changes) {
  const sets = [];
  const params = [];
  for (const [field, value] of Object.entries(changes)) {
    const column = EDITABLE[field];
    if (!column) throw new Error(`host field ${field} is not editable`);
    sets.push(`${column} = ?`);
    params.push(value);
  }
  const [res] = await getMysql().execute(
    `UPDATE hosts SET ${sets.join(', ')}, version = version + 1
     WHERE host_id = ? AND version = ? AND is_deleted = FALSE`,
    [...params, hostId, version],
  );
  return { updated: res.affectedRows === 1, row: await findByIdAnyStatus(hostId) };
}

module.exports = { toApi, toPublic, findById, findByIdAnyStatus, findByEmail, insert, updateWithVersion, EDITABLE };
