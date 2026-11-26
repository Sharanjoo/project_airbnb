// Live Kafka numbers for /analytics/platform, read with the Kafka admin API
// (API doc §8: consumer lag = latest offset − committed offset).
//
//   consumer_lag  { groupId: messages not yet processed, summed over its partitions }
//   dlq_messages  messages currently held in all <topic>.dlq topics
//
// Kafka being down must not break the dashboard: after `timeoutMs` the answer
// is { consumer_lag: null, dlq_messages: null, kafka_error } instead.
const { createKafka } = require('@airbnb/common');

const INTERNAL = /^__/; // __consumer_offsets and friends

async function snapshot({ timeoutMs = Number(process.env.KAFKA_ADMIN_TIMEOUT_MS || 3000) } = {}) {
  const admin = createKafka('analytics-admin').admin();
  let timer;
  const work = (async () => {
    await admin.connect();
    const topics = (await admin.listTopics()).filter((t) => !INTERNAL.test(t));

    // latest (high) and earliest (low) offset of every partition
    const ends = new Map(); // topic -> Map(partition -> { high, low })
    for (const topic of topics) {
      const parts = await admin.fetchTopicOffsets(topic);
      ends.set(topic, new Map(parts.map((p) => [p.partition, { high: Number(p.high ?? p.offset), low: Number(p.low) }])));
    }
    let dlq = 0;
    for (const [topic, parts] of ends) {
      if (topic.endsWith('.dlq')) for (const { high, low } of parts.values()) dlq += Math.max(0, high - low);
    }

    const { groups } = await admin.listGroups();
    const lag = {};
    for (const { groupId } of groups) {
      const committed = await admin.fetchOffsets({ groupId });
      let total = 0;
      for (const { topic, partitions } of committed) {
        const topicEnds = ends.get(topic);
        if (!topicEnds) continue;
        for (const { partition, offset } of partitions) {
          const end = topicEnds.get(partition);
          if (!end) continue;
          const done = Number(offset) >= 0 ? Number(offset) : end.low; // -1 = nothing committed yet
          total += Math.max(0, end.high - done);
        }
      }
      lag[groupId] = total;
    }
    return { consumer_lag: lag, dlq_messages: dlq };
  })();
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ consumer_lag: null, dlq_messages: null, kafka_error: 'Kafka admin timed out' }), timeoutMs);
  });
  try {
    return await Promise.race([work.catch((err) => ({ consumer_lag: null, dlq_messages: null, kafka_error: err.message })), timeout]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {}).finally(() => admin.disconnect().catch(() => {}));
  }
}

module.exports = { snapshot };
