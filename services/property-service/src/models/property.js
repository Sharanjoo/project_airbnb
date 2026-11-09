// Data access layer for properties and availability.
// Every query is parameterised; route handlers never build SQL themselves.
const { getMysql } = require('@airbnb/common');

// Columns a host may change through /properties/update, mapped from API field -> DB column.
const EDITABLE = {
  title: 'title',
  description: 'description',
  property_type: 'property_type',
  capacity: 'capacity',
  bedrooms: 'bedrooms',
  bathrooms: 'bathrooms',
  amenities: 'amenities',
  pet_friendly: 'pet_friendly',
  nightly_price: 'nightly_price',
  cleaning_fee: 'cleaning_fee',
  status: 'status',
};
const ADDRESS_COLUMNS = { line1: 'address_line1', city: 'city', state: 'state', zip: 'zip', lat: 'lat', lng: 'lng' };

const num = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => (v ? `${String(v).replace(' ', 'T')}Z` : null); // MySQL DATETIME (UTC) -> ISO 8601

/** DB row -> API shape (API doc §4 / §13.2). */
function toApi(row) {
  if (!row) return null;
  return {
    property_id: row.property_id,
    host_id: row.host_id,
    title: row.title,
    description: row.description,
    property_type: row.property_type,
    address: {
      line1: row.address_line1,
      city: row.city,
      state: row.state,
      zip: row.zip,
      lat: num(row.lat),
      lng: num(row.lng),
    },
    capacity: row.capacity,
    bedrooms: row.bedrooms,
    bathrooms: num(row.bathrooms),
    amenities: typeof row.amenities === 'string' ? JSON.parse(row.amenities) : row.amenities,
    pet_friendly: Boolean(row.pet_friendly),
    nightly_price: num(row.nightly_price),
    cleaning_fee: num(row.cleaning_fee),
    status: row.status,
    rating: num(row.rating),
    review_count: row.review_count,
    availability_version: row.availability_version,
    version: row.version,
    created_datetime: iso(row.created_datetime),
  };
}

/** Includes deleted listings, so callers can tell 404 (never existed) from 410 (deleted). */
async function findByIdAnyStatus(propertyId) {
  const [rows] = await getMysql().execute('SELECT * FROM properties WHERE property_id = ?', [propertyId]);
  return rows[0] || null;
}

async function findById(propertyId) {
  const row = await findByIdAnyStatus(propertyId);
  return row && row.status !== 'deleted' ? row : null;
}

async function insert(p) {
  await getMysql().execute(
    `INSERT INTO properties (property_id, host_id, title, description, property_type,
       address_line1, city, state, zip, lat, lng, capacity, bedrooms, bathrooms, amenities,
       pet_friendly, nightly_price, cleaning_fee)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.property_id, p.host_id, p.title, p.description, p.property_type,
      p.address.line1, p.address.city, p.address.state, p.address.zip, p.address.lat ?? null, p.address.lng ?? null,
      p.capacity, p.bedrooms, p.bathrooms, JSON.stringify(p.amenities),
      p.pet_friendly, p.nightly_price, p.cleaning_fee],
  );
  return findById(p.property_id);
}

/**
 * Optimistic-lock update: only applies if the row is still at `expectedVersion`.
 * Returns { updated: true, row } or { updated: false, row } (row = current state, or null if missing).
 */
async function updateWithVersion(propertyId, expectedVersion, changes) {
  const sets = [];
  const values = [];
  for (const [field, value] of Object.entries(changes)) {
    if (field === 'address') {
      for (const [k, col] of Object.entries(ADDRESS_COLUMNS)) {
        if (value[k] !== undefined) {
          sets.push(`${col} = ?`);
          values.push(value[k]);
        }
      }
    } else if (EDITABLE[field]) {
      sets.push(`${EDITABLE[field]} = ?`);
      values.push(field === 'amenities' ? JSON.stringify(value) : value);
    }
  }
  if (!sets.length) return { updated: false, row: await findByIdAnyStatus(propertyId) };

  const [res] = await getMysql().execute(
    `UPDATE properties SET ${sets.join(', ')}, version = version + 1
     WHERE property_id = ? AND version = ? AND status <> 'deleted'`,
    [...values, propertyId, expectedVersion],
  );
  const row = await findByIdAnyStatus(propertyId);
  return { updated: res.affectedRows === 1, row };
}

/** Upcoming reservations that would be stranded by deleting the listing. */
async function countUpcomingBookings(propertyId) {
  const [rows] = await getMysql().execute(
    `SELECT COUNT(*) AS n FROM reservations
     WHERE property_id = ? AND status IN ('REQUESTED', 'CONFIRMED') AND check_out > CURRENT_DATE()`,
    [propertyId],
  );
  return Number(rows[0].n);
}

async function softDelete(propertyId) {
  await getMysql().execute(
    "UPDATE properties SET status = 'deleted', version = version + 1 WHERE property_id = ?",
    [propertyId],
  );
}

/**
 * Optimistic-lock bump for availability writes (13.3). Returns true if this
 * writer won; false means someone else changed availability first -> 409.
 */
async function bumpAvailabilityVersion(conn, propertyId, expectedVersion) {
  const [res] = await conn.execute(
    'UPDATE properties SET availability_version = availability_version + 1 WHERE property_id = ? AND availability_version = ?',
    [propertyId, expectedVersion],
  );
  return res.affectedRows === 1;
}

// TODO (slice 2): search (indexed MySQL) and a second strategy for 13.8

module.exports = {
  toApi,
  findById,
  findByIdAnyStatus,
  insert,
  updateWithVersion,
  countUpcomingBookings,
  softDelete,
  bumpAvailabilityVersion,
};
