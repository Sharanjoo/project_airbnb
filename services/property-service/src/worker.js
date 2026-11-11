// Property worker (consumer group property-cg). Separate process from the API.
//   booking.confirmed / cancelled / completed -> invalidate cached search + calendar
//   review.created                           -> recompute rating and review_count from MongoDB reviews
//   property.created / property.updated      -> refresh the MongoDB read model used by the "mongo" strategy
// Every handler is idempotent (it recomputes from the source of truth), so a
// redelivered event is harmless and no processed_events row is needed.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'property-worker';
const { EventBus, TOPICS, getMysql, getMongo, logger } = require('@airbnb/common');
const cache = require('./cache');
const readModel = require('./readModel');

const GROUP = 'property-cg';
const bus = new EventBus('property-worker');

async function onBookingChanged(env) {
  const propertyId = env.payload.property_id;
  await cache.invalidateProperty(propertyId);
  logger.info('cache invalidated after booking change', { trace_id: env.trace_id, property_id: propertyId, event: env.event_type });
}

/** Average of all reviews for the property, rounded to 2 decimals like the MySQL column. */
async function recomputeRating(propertyId) {
  const reviews = (await getMongo()).collection('reviews');
  const [agg] = await reviews.aggregate([
    { $match: { property_id: propertyId } },
    { $group: { _id: '$property_id', avg: { $avg: '$rating' }, n: { $sum: 1 } } },
  ]).toArray();
  const rating = agg ? Math.round(agg.avg * 100) / 100 : null;
  const count = agg ? agg.n : 0;
  await getMysql().query('UPDATE properties SET rating = ?, review_count = ? WHERE property_id = ?', [rating, count, propertyId]);
  return { rating, review_count: count };
}

async function onReviewCreated(env) {
  const propertyId = env.payload.property_id;
  const result = await recomputeRating(propertyId);
  await readModel.syncProperty(propertyId);
  await cache.invalidateProperty(propertyId); // rating filters and sorts change
  logger.info('rating recomputed', { trace_id: env.trace_id, property_id: propertyId, ...result });
}

async function onPropertyChanged(env) {
  await readModel.syncProperty(env.payload.property_id);
}

const handlers = {
  [TOPICS.BOOKING_CONFIRMED]: onBookingChanged,
  [TOPICS.BOOKING_CANCELLED]: onBookingChanged,
  [TOPICS.BOOKING_COMPLETED]: onBookingChanged,
  [TOPICS.REVIEW_CREATED]: onReviewCreated,
  [TOPICS.PROPERTY_CREATED]: onPropertyChanged,
  [TOPICS.PROPERTY_UPDATED]: onPropertyChanged,
};

async function main() {
  await bus.consume({
    groupId: GROUP,
    topics: Object.keys(handlers),
    handler: (env, meta) => handlers[meta.topic](env, meta),
  });
  logger.info('property-worker consuming', { topics: Object.keys(handlers) });
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('property-worker crashed', { error: err.message });
    process.exit(1);
  });
  const shutdown = () => bus.disconnect().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { handlers, recomputeRating, bus };
