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
