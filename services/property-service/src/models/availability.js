// Availability calendar and host blocks (feature 13.3: concurrent availability updates).
//
// Conflict rule: every write must send the `availability_version` it last read.
// Inside one transaction we first run
//   UPDATE properties SET availability_version = availability_version + 1
//   WHERE property_id = ? AND availability_version = ?
// That row lock serialises concurrent writers: the first commits, the second
// then matches 0 rows and gets 409 VERSION_CONFLICT. First writer wins; the
// loser must re-read the calendar and decide again (no silent merge).
const { getMysql, withTransaction, newId } = require('@airbnb/common');
const { bumpAvailabilityVersion } = require('./property');

class AvailabilityConflict extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind; // 'version' | 'booked' | 'blocked' | 'not_found'
    Object.assign(this, extra);
  }
}

/** Booked stays and host blocks overlapping [from, to). */
async function getCalendar(propertyId, from, to) {
  const db = getMysql();
  const [[prop]] = await db.query('SELECT availability_version FROM properties WHERE property_id = ?', [propertyId]);
  const [bookings] = await db.query(
    `SELECT reservation_id, check_in, check_out, status FROM reservations
     WHERE property_id = ? AND status IN ('REQUESTED', 'CONFIRMED') AND check_in < ? AND check_out > ?
     ORDER BY check_in`,
    [propertyId, to, from],
  );
  const [blocks] = await db.query(
    `SELECT availability_id, start_date, end_date, status, source, updated_datetime FROM availability_blocks
     WHERE property_id = ? AND status = 'blocked' AND start_date < ? AND end_date > ?
     ORDER BY start_date`,
    [propertyId, to, from],
  );
  const unavailable = [
    ...bookings.map((b) => ({
      start_date: b.check_in, end_date: b.check_out, status: 'booked', source: 'booking', reservation_id: b.reservation_id,
    })),
    ...blocks.map((b) => ({
      availability_id: b.availability_id, start_date: b.start_date, end_date: b.end_date, status: 'blocked', source: b.source,
    })),
  ].sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  return { property_id: propertyId, from, to, availability_version: prop ? prop.availability_version : null, unavailable };
}

async function currentVersion(conn, propertyId) {
  const [[row]] = await conn.query('SELECT availability_version FROM properties WHERE property_id = ?', [propertyId]);
  return row ? row.availability_version : null;
}

/** Host blocks [start, end). Throws AvailabilityConflict; otherwise returns the new block. */
async function blockDates(propertyId, expectedVersion, start, end, source = 'host') {
  return withTransaction(async (conn) => {
    if (!(await bumpAvailabilityVersion(conn, propertyId, expectedVersion))) {
      throw new AvailabilityConflict('version', 'Availability changed since you read it.', {
        currentVersion: await currentVersion(conn, propertyId),
      });
    }
    const [booked] = await conn.query(
      `SELECT r.check_in, r.check_out FROM reservation_nights n JOIN reservations r ON r.reservation_id = n.reservation_id
       WHERE n.property_id = ? AND n.night >= ? AND n.night < ? LIMIT 1`,
      [propertyId, start, end],
    );
    if (booked.length) {
      throw new AvailabilityConflict('booked', `${booked[0].check_in} to ${booked[0].check_out} is booked.`);
    }
    const [overlap] = await conn.query(
      `SELECT availability_id, start_date, end_date FROM availability_blocks
       WHERE property_id = ? AND status = 'blocked' AND start_date < ? AND end_date > ? LIMIT 1`,
      [propertyId, end, start],
    );
    if (overlap.length) {
      throw new AvailabilityConflict('blocked', `${overlap[0].start_date} to ${overlap[0].end_date} is already blocked.`, {
        availabilityId: overlap[0].availability_id,
      });
    }
    const availabilityId = newId('avl');
    await conn.query(
      `INSERT INTO availability_blocks (availability_id, property_id, start_date, end_date, status, source)
       VALUES (?, ?, ?, ?, 'blocked', ?)`,
      [availabilityId, propertyId, start, end, source],
    );
    return {
      availability_id: availabilityId, property_id: propertyId, start_date: start, end_date: end,
      status: 'blocked', source, availability_version: expectedVersion + 1,
    };
  });
}

/** Host removes one of their blocks. */
async function unblock(propertyId, availabilityId, expectedVersion) {
  return withTransaction(async (conn) => {
    if (!(await bumpAvailabilityVersion(conn, propertyId, expectedVersion))) {
      throw new AvailabilityConflict('version', 'Availability changed since you read it.', {
        currentVersion: await currentVersion(conn, propertyId),
      });
    }
    const [[block]] = await conn.query(
      "SELECT start_date, end_date FROM availability_blocks WHERE availability_id = ? AND property_id = ? AND status = 'blocked'",
      [availabilityId, propertyId],
    );
    if (!block) throw new AvailabilityConflict('not_found', 'Block not found.');
    await conn.query('DELETE FROM availability_blocks WHERE availability_id = ?', [availabilityId]);
    return {
      availability_id: availabilityId, property_id: propertyId, start_date: block.start_date, end_date: block.end_date,
      status: 'open', source: 'host', availability_version: expectedVersion + 1,
    };
  });
}

module.exports = { getCalendar, blockDates, unblock, AvailabilityConflict };
