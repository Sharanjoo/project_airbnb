process.env.NODE_ENV = 'test';
// Which booking events make the property worker clear cached search results.
const test = require('node:test');
const assert = require('node:assert');
const { handlers } = require('../src/worker');

test('every event that changes which nights are taken invalidates the cache', () => {
  for (const topic of ['booking.confirmed', 'booking.cancelled', 'booking.completed', 'booking.rejected']) {
    assert.strictEqual(typeof handlers[topic], 'function', `${topic} is not handled`);
  }
});

test('booking.rejected: a host decline clears the cache; a request that lost the race does not', async () => {
  const cache = require('../src/cache');
  const original = cache.invalidateProperty;
  const cleared = [];
  cache.invalidateProperty = async (id) => { cleared.push(id); };
  try {
    const rejected = (newStatus) => ({ event_type: 'booking.rejected', trace_id: 't', payload: { property_id: 'prp_1', new_status: newStatus } });
    await handlers['booking.rejected'](rejected('REJECTED'), { topic: 'booking.rejected' });
    assert.deepStrictEqual(cleared, []);
    await handlers['booking.rejected'](rejected('DECLINED'), { topic: 'booking.rejected' });
    assert.deepStrictEqual(cleared, ['prp_1']);
  } finally {
    cache.invalidateProperty = original;
  }
});
