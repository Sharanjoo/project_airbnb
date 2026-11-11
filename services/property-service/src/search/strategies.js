// The two search strategies compared in feature 13.8. Both return the same shape:
//   { items: [...], total, page, page_size }
// Strategy "mysql": one indexed SQL query (filters + date availability) + COUNT.
// Strategy "mongo": filter the MongoDB read model `property_search`, then remove
//   candidates that are booked or blocked on the requested dates with one MySQL query.
const { getMysql, getMongo } = require('@airbnb/common');
const { toSql, toMongo } = require('./filters');

const COLLECTION = 'property_search';
const MAX_MONGO_CANDIDATES = 5000; // dated searches filter in memory after the date check

const num = (v) => (v === null || v === undefined ? null : Number(v));

function itemFromRow(r, dated) {
  return {
    property_id: r.property_id,
    host_id: r.host_id,
    title: r.title,
    property_type: r.property_type,
    city: r.city,
    nightly_price: num(r.nightly_price),
    cleaning_fee: num(r.cleaning_fee),
    rating: num(r.rating),
    review_count: r.review_count,
    capacity: r.capacity,
    bedrooms: r.bedrooms,
    amenities: typeof r.amenities === 'string' ? JSON.parse(r.amenities) : r.amenities,
    pet_friendly: Boolean(r.pet_friendly),
    status: r.status,
    available: dated ? true : null, // only bookable listings are returned when dates are given
  };
}

async function mysqlSearch(f, opts) {
  const { where, params, orderBy } = toSql(f, opts);
  const db = getMysql();
  const offset = (f.page - 1) * f.page_size;
  // query() (client-side escaping) rather than execute(): MySQL 8 rejects LIMIT placeholders in prepared statements.
  const [rows] = await db.query(
    `SELECT p.property_id, p.host_id, p.title, p.property_type, p.city, p.nightly_price, p.cleaning_fee,
            p.rating, p.review_count, p.capacity, p.bedrooms, p.amenities, p.pet_friendly, p.status
     FROM properties p WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, f.page_size, offset],
  );
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM properties p WHERE ${where}`, params);
  const dated = Boolean(f.check_in);
  return { items: rows.map((r) => itemFromRow(r, dated)), total: Number(total), page: f.page, page_size: f.page_size };
}

/** IDs among `ids` that are booked or blocked between checkIn and checkOut. */
async function unavailableIds(ids, checkIn, checkOut) {
  if (!ids.length) return new Set();
  const [rows] = await getMysql().query(
    `SELECT DISTINCT property_id FROM reservation_nights
       WHERE property_id IN (?) AND night >= ? AND night < ?
     UNION
     SELECT DISTINCT property_id FROM availability_blocks
       WHERE property_id IN (?) AND status = 'blocked' AND start_date < ? AND end_date > ?`,
    [ids, checkIn, checkOut, ids, checkOut, checkIn],
  );
  return new Set(rows.map((r) => r.property_id));
}

function itemFromDoc(d, dated) {
  return itemFromRow({ ...d, property_id: d._id }, dated);
}

async function mongoSearch(f, opts) {
  const col = (await getMongo()).collection(COLLECTION);
  const { query, sort } = toMongo(f, opts);
  const skip = (f.page - 1) * f.page_size;

  if (!f.check_in) {
    const [docs, total] = await Promise.all([
      col.find(query).sort(sort).skip(skip).limit(f.page_size).toArray(),
      col.countDocuments(query),
    ]);
    return { items: docs.map((d) => itemFromDoc(d, false)), total, page: f.page, page_size: f.page_size };
  }

  // Dated search: Mongo narrows by attributes, MySQL (the source of truth for bookings) removes unavailable ones.
  const candidates = await col.find(query).sort(sort).limit(MAX_MONGO_CANDIDATES).toArray();
  const blocked = await unavailableIds(candidates.map((d) => d._id), f.check_in, f.check_out);
  const available = candidates.filter((d) => !blocked.has(d._id));
  return {
    items: available.slice(skip, skip + f.page_size).map((d) => itemFromDoc(d, true)),
    total: available.length,
    page: f.page,
    page_size: f.page_size,
  };
}

const STRATEGIES = { mysql: mysqlSearch, mongo: mongoSearch };

module.exports = { STRATEGIES, mysqlSearch, mongoSearch, unavailableIds, COLLECTION };
