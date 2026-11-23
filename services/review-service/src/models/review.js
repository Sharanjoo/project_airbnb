// Review data access. Reviews live in MongoDB `reviews` (unique on reservation_id);
// reservations and guest names are read from MySQL (owned by slices 3 and 1, read only here).
const { getMysql, getMongo } = require('@airbnb/common');

const col = async () => (await getMongo()).collection('reviews');

/** Strip Mongo internals and bookkeeping before a review leaves the service. */
function toApi(doc) {
  if (!doc) return null;
  const { _id, event_published, response_event_published, ...rest } = doc; // eslint-disable-line no-unused-vars
  return rest;
}

async function findReservation(reservationId) {
  const [rows] = await getMysql().query(
    'SELECT reservation_id, property_id, guest_id, host_id, status, check_in, check_out FROM reservations WHERE reservation_id = ?',
    [reservationId],
  );
  return rows[0] || null;
}

/** Insert a new review. Returns { inserted: true } or { inserted: false, existing } if this reservation has one. */
async function insert(doc) {
  const reviews = await col();
  try {
    await reviews.insertOne({ ...doc });
    return { inserted: true };
  } catch (err) {
    if (err.code === 11000) return { inserted: false, existing: await reviews.findOne({ reservation_id: doc.reservation_id }) };
    throw err;
  }
}

async function markPublished(reviewId, field = 'event_published') {
  await (await col()).updateOne({ review_id: reviewId }, { $set: { [field]: true } });
}

async function findById(reviewId) {
  return (await col()).findOne({ review_id: reviewId });
}

/** Newest first. Also returns the average over all of the property's reviews. */
async function listByProperty(propertyId, { page, pageSize }) {
  const reviews = await col();
  const [items, stats] = await Promise.all([
    reviews.find({ property_id: propertyId }).sort({ created_datetime: -1, review_id: -1 })
      .skip((page - 1) * pageSize).limit(pageSize).toArray(),
    reviews.aggregate([
      { $match: { property_id: propertyId } },
      { $group: { _id: null, total: { $sum: 1 }, avg: { $avg: '$rating' } } },
    ]).toArray(),
  ]);
  const s = stats[0];
  return { items, total: s ? s.total : 0, average_rating: s ? Math.round(s.avg * 100) / 100 : null };
}

/** Set the host's answer only if there is none yet. Returns the updated doc, or null if already answered. */
async function setResponse(reviewId, response) {
  // driver v6: returns the document, or null when nothing matched
  return (await col()).findOneAndUpdate(
    { review_id: reviewId, host_response: null },
    { $set: { host_response: response, response_event_published: false } },
    { returnDocument: 'after' },
  );
}

/** "First L." for each guest id. Best effort: no names if MySQL is unavailable. */
async function guestNames(guestIds) {
  const ids = [...new Set(guestIds)].filter(Boolean);
  if (!ids.length) return new Map();
  try {
    const [rows] = await getMysql().query('SELECT guest_id, first_name, last_name FROM guests WHERE guest_id IN (?)', [ids]);
    return new Map(rows.map((r) => [r.guest_id, `${r.first_name} ${String(r.last_name).charAt(0)}.`]));
  } catch {
    return new Map();
  }
}

async function propertyExists(propertyId) {
  const [rows] = await getMysql().query("SELECT status FROM properties WHERE property_id = ?", [propertyId]);
  return rows[0] ? rows[0].status : null;
}

module.exports = {
  toApi, findReservation, insert, markPublished, findById, listByProperty, setResponse, guestNames, propertyExists,
};
