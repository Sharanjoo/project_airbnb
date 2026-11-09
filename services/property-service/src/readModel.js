// MongoDB read model `property_search`, used by the "mongo" search strategy (13.8).
// MySQL stays the source of truth; this collection is a denormalised copy kept in
// sync by the property worker (property.created / property.updated / review.created)
// and rebuilt in full by scripts/generate-properties.js --mongo.
const { getMysql, getMongo } = require('@airbnb/common');
const { COLLECTION } = require('./search/strategies');

let indexesReady = false;

async function collection() {
  const col = (await getMongo()).collection(COLLECTION);
  if (!indexesReady) {
    // Same shape as the MySQL search index, so the comparison is like-for-like.
    await col.createIndex({ status: 1, city: 1, nightly_price: 1 });
    await col.createIndex({ status: 1, rating: -1 });
    await col.createIndex({ host_id: 1 });
    indexesReady = true;
  }
  return col;
}

function toDoc(row) {
  return {
    _id: row.property_id,
    host_id: row.host_id,
    title: row.title,
    property_type: row.property_type,
    city: row.city,
    state: row.state,
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    capacity: row.capacity,
    bedrooms: row.bedrooms,
    amenities: typeof row.amenities === 'string' ? JSON.parse(row.amenities) : row.amenities,
    pet_friendly: Boolean(row.pet_friendly),
    nightly_price: Number(row.nightly_price),
    cleaning_fee: Number(row.cleaning_fee),
    rating: row.rating === null ? null : Number(row.rating),
    review_count: row.review_count,
    status: row.status,
    created_datetime: row.created_datetime,
    synced_at: new Date(),
  };
}

/** Copy one property from MySQL into Mongo (or mark it deleted). Idempotent. */
async function syncProperty(propertyId) {
  const [[row]] = await getMysql().query('SELECT * FROM properties WHERE property_id = ?', [propertyId]);
  const col = await collection();
  if (!row) {
    await col.deleteOne({ _id: propertyId });
    return null;
  }
  const doc = toDoc(row);
  await col.replaceOne({ _id: propertyId }, doc, { upsert: true });
  return doc;
}

/** Rebuild the whole collection from MySQL (used after bulk loads). */
async function syncAll() {
  const [rows] = await getMysql().query('SELECT * FROM properties');
  const col = await collection();
  if (!rows.length) return 0;
  await col.bulkWrite(rows.map((r) => ({ replaceOne: { filter: { _id: r.property_id }, replacement: toDoc(r), upsert: true } })));
  return rows.length;
}

module.exports = { syncProperty, syncAll, toDoc };
