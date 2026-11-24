// Read-only lookups in the shared MySQL database (owned by slices 1, 2 and 3), the
// same way booking-service reads `properties`. Messaging never writes to MySQL.
const { getMysql } = require('@airbnb/common');

/** Listing a guest wants to ask about: who hosts it and whether it is bookable. */
async function findProperty(propertyId) {
  const [rows] = await getMysql().execute(
    'SELECT property_id, host_id, title, status FROM properties WHERE property_id = ?',
    [propertyId],
  );
  return rows[0] || null;
}

/** A reservation written by booking-worker: links a guest, a host and a listing. */
async function findReservation(reservationId) {
  const [rows] = await getMysql().execute(
    'SELECT reservation_id, guest_id, host_id, property_id, status FROM reservations WHERE reservation_id = ?',
    [reservationId],
  );
  return rows[0] || null;
}

const placeholders = (n) => Array(n).fill('?').join(', ');

/**
 * Display names for the conversation list: guests as "First L.", hosts by name,
 * listings by title. Only what the other participant would see on Airbnb anyway;
 * no emails or phone numbers. Missing ids are simply absent from the result.
 */
async function describe({ userIds = [], propertyIds = [] }) {
  const db = getMysql();
  const guests = userIds.filter((id) => id.startsWith('gst_'));
  const hosts = userIds.filter((id) => id.startsWith('hst_'));
  const [g, h, p] = await Promise.all([
    guests.length
      ? db.execute(`SELECT guest_id AS id, CONCAT(first_name, ' ', LEFT(last_name, 1), '.') AS name FROM guests WHERE guest_id IN (${placeholders(guests.length)})`, guests)
      : [[]],
    hosts.length
      ? db.execute(`SELECT host_id AS id, name FROM hosts WHERE host_id IN (${placeholders(hosts.length)})`, hosts)
      : [[]],
    propertyIds.length
      ? db.execute(`SELECT property_id AS id, title FROM properties WHERE property_id IN (${placeholders(propertyIds.length)})`, propertyIds)
      : [[]],
  ]);
  return {
    names: Object.fromEntries([...g[0], ...h[0]].map((r) => [r.id, r.name])),
    titles: Object.fromEntries(p[0].map((r) => [r.id, r.title])),
  };
}

module.exports = { findProperty, findReservation, describe };
