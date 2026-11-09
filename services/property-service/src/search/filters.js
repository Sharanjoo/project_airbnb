// Turns a validated search body into query fragments for each strategy.
// Both strategies apply exactly the same filters, so the 13.8 comparison is fair.

const KM_PER_DEGREE = 111.045;

/** Bounding box around a point; good enough for "within N km" on a city scale. */
function boundingBox(lat, lng, radiusKm) {
  const dLat = radiusKm / KM_PER_DEGREE;
  const dLng = radiusKm / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLng: lng - dLng, maxLng: lng + dLng };
}

const SQL_ORDER = {
  price_asc: 'p.nightly_price ASC, p.property_id ASC',
  price_desc: 'p.nightly_price DESC, p.property_id ASC',
  rating_desc: 'p.rating IS NULL, p.rating DESC, p.review_count DESC, p.property_id ASC',
  newest: 'p.created_datetime DESC, p.property_id ASC',
};

/**
 * MySQL: WHERE clause + params. Date availability uses NOT EXISTS against the
 * claimed nights and the host's blocked ranges, so only bookable listings return.
 * `ownerView` = the host is listing their own properties (inactive ones included).
 */
function toSql(f, { ownerView = false } = {}) {
  const where = [];
  const params = [];

  if (f.host_id) {
    where.push('p.host_id = ?');
    params.push(f.host_id);
  }
  where.push(ownerView ? "p.status <> 'deleted'" : "p.status = 'active'");

  if (f.location?.city) {
    where.push('p.city = ?');
    params.push(f.location.city);
  }
  if (f.location?.radius_km && f.location.lat !== undefined && f.location.lng !== undefined) {
    const b = boundingBox(f.location.lat, f.location.lng, f.location.radius_km);
    where.push('p.lat BETWEEN ? AND ? AND p.lng BETWEEN ? AND ?');
    params.push(b.minLat, b.maxLat, b.minLng, b.maxLng);
  }
  if (f.guests) {
    where.push('p.capacity >= ?');
    params.push(f.guests);
  }
  if (f.price_min !== undefined) {
    where.push('p.nightly_price >= ?');
    params.push(f.price_min);
  }
  if (f.price_max !== undefined) {
    where.push('p.nightly_price <= ?');
    params.push(f.price_max);
  }
  if (f.property_types?.length) {
    where.push(`p.property_type IN (${f.property_types.map(() => '?').join(', ')})`);
    params.push(...f.property_types);
  }
  if (f.amenities?.length) {
    where.push('JSON_CONTAINS(p.amenities, CAST(? AS JSON))');
    params.push(JSON.stringify(f.amenities));
  }
  if (f.pet_friendly !== undefined) {
    where.push('p.pet_friendly = ?');
    params.push(f.pet_friendly ? 1 : 0);
  }
  if (f.min_rating !== undefined) {
    where.push('p.rating >= ?');
    params.push(f.min_rating);
  }
  if (f.check_in && f.check_out) {
    where.push(`NOT EXISTS (SELECT 1 FROM reservation_nights n
                 WHERE n.property_id = p.property_id AND n.night >= ? AND n.night < ?)`);
    params.push(f.check_in, f.check_out);
    where.push(`NOT EXISTS (SELECT 1 FROM availability_blocks b
                 WHERE b.property_id = p.property_id AND b.status = 'blocked'
                   AND b.start_date < ? AND b.end_date > ?)`);
    params.push(f.check_out, f.check_in);
  }

  return { where: where.join(' AND '), params, orderBy: SQL_ORDER[f.sort] || SQL_ORDER.price_asc };
}

const MONGO_SORT = {
  price_asc: { nightly_price: 1, _id: 1 },
  price_desc: { nightly_price: -1, _id: 1 },
  rating_desc: { rating: -1, review_count: -1, _id: 1 },
  newest: { created_datetime: -1, _id: 1 },
};

/** MongoDB: the same filters as a query document (dates are checked afterwards in MySQL). */
function toMongo(f, { ownerView = false } = {}) {
  const q = {};
  if (f.host_id) q.host_id = f.host_id;
  q.status = ownerView ? { $ne: 'deleted' } : 'active';
  if (f.location?.city) q.city = f.location.city;
  if (f.location?.radius_km && f.location.lat !== undefined && f.location.lng !== undefined) {
    const b = boundingBox(f.location.lat, f.location.lng, f.location.radius_km);
    q.lat = { $gte: b.minLat, $lte: b.maxLat };
    q.lng = { $gte: b.minLng, $lte: b.maxLng };
  }
  if (f.guests) q.capacity = { $gte: f.guests };
  if (f.price_min !== undefined || f.price_max !== undefined) {
    q.nightly_price = {};
    if (f.price_min !== undefined) q.nightly_price.$gte = f.price_min;
    if (f.price_max !== undefined) q.nightly_price.$lte = f.price_max;
  }
  if (f.property_types?.length) q.property_type = { $in: f.property_types };
  if (f.amenities?.length) q.amenities = { $all: f.amenities };
  if (f.pet_friendly !== undefined) q.pet_friendly = f.pet_friendly;
  if (f.min_rating !== undefined) q.rating = { $gte: f.min_rating };
  return { query: q, sort: MONGO_SORT[f.sort] || MONGO_SORT.price_asc };
}

module.exports = { toSql, toMongo, boundingBox };
