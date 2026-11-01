// Analytics consumer: stores every domain event in Mongo `events` (one doc per
// event, deduped on event_id). Dashboards and the platform metrics read from it.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'analytics-worker';
const { EventBus, TOPICS, getMongo, logger } = require('@airbnb/common');

const GROUP = 'analytics-cg';
const bus = new EventBus('analytics-worker');

async function storeEvent(env, { topic, partition, offset }) {
  const db = await getMongo();
  await db.collection('events').updateOne(
    { event_id: env.event_id },
    { $setOnInsert: { ...env, kafka: { topic, partition, offset }, received_at: new Date() } },
    { upsert: true },
  );
}

async function main() {
  await bus.consume({ groupId: GROUP, topics: Object.values(TOPICS), handler: storeEvent });
  logger.info('analytics-worker consuming all domain topics');
}

if (require.main === module) {
  main().catch((err) => { logger.error('analytics-worker crashed', { error: err.message }); process.exit(1); });
}

module.exports = { storeEvent };
