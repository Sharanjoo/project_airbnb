// Data access layer for guests (spec §3.1: entity objects use the DAL to select, insert, update).
const { getMysql } = require('@airbnb/common');

const PUBLIC_COLUMNS = `guest_id, first_name, last_name, email, phone, location, profile_photo_url,
  preferences, saved_properties_count, booking_count, profile_created_datetime, version`;

async function findById(guestId) {
  const [rows] = await getMysql().execute(
    `SELECT ${PUBLIC_COLUMNS} FROM guests WHERE guest_id = ? AND is_deleted = FALSE`,
    [guestId],
  );
  return rows[0] || null;
}

async function findByEmail(email) {
  const [rows] = await getMysql().execute('SELECT * FROM guests WHERE email = ? AND is_deleted = FALSE', [email]);
  return rows[0] || null;
}

// TODO (slice 1): insert, update with optimistic lock (WHERE version = ?), softDelete, search

module.exports = { findById, findByEmail };
