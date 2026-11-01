// Data access layer for properties and availability.
const { getMysql } = require('@airbnb/common');

async function findById(propertyId) {
  const [rows] = await getMysql().execute(
    "SELECT * FROM properties WHERE property_id = ? AND status <> 'deleted'",
    [propertyId],
  );
  return rows[0] || null;
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

// TODO (slice 2): insert, update, softDelete, search (indexed MySQL) and a second strategy for 13.8

module.exports = { findById, bumpAvailabilityVersion };
