process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { createNotifier, channelsFor } = require('../src/index');

test('channelsFor maps payload ids to channels', () => {
  const ch = channelsFor({ event_type: 'booking.confirmed', payload: { guest_id: 'gst_1', property_id: 'prp_1' } });
  assert.deepStrictEqual(ch.sort(), ['property:prp_1', 'user:gst_1']);
});

test('subscriber to a property receives availability.changed', async () => {
  const n = createNotifier();
  await new Promise((r) => n.server.listen(0, r));
  const token = jwt.sign({ sub: 'gst_2', role: 'guest' }, 'test-secret');
  const ws = new WebSocket(`ws://127.0.0.1:${n.server.address().port}/ws?token=${token}`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ subscribe: ['property:prp_1'] }));
  await new Promise((r) => setTimeout(r, 50));

  const got = new Promise((r) => ws.on('message', (m) => r(JSON.parse(m))));
  const delivered = n.push({ event_type: 'availability.changed', trace_id: 't1', payload: { property_id: 'prp_1', status: 'booked' } });
  assert.strictEqual(delivered, 1);
  const frame = await got;
  assert.strictEqual(frame.type, 'availability.changed');
  assert.strictEqual(frame.trace_id, 't1');
  ws.close();
  n.wss.close();
  n.server.close();
});

test('bad token is closed with 4401', async () => {
  const n = createNotifier();
  await new Promise((r) => n.server.listen(0, r));
  const ws = new WebSocket(`ws://127.0.0.1:${n.server.address().port}/ws?token=bad`);
  const code = await new Promise((r) => ws.on('close', (c) => r(c)));
  assert.strictEqual(code, 4401);
  n.wss.close();
  n.server.close();
});
