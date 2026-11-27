// Who may hear what (13.4 security): third users must not see other people's pushes.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { createNotifier, channelsFor, canSubscribe, PUSHED_TOPICS, MAX_CHANNELS } = require('../src/index');

const SECRET = 'test-secret';
const token = (sub, role = 'guest') => jwt.sign({ sub, role }, SECRET);

const ACTIVE = async () => 'active';

async function setup({ checkAccount = ACTIVE } = {}) {
  const n = createNotifier({ checkAccount });
  await new Promise((r) => n.server.listen(0, r));
  const port = n.server.address().port;
  const clients = [];

  /** Connect as a user, subscribe, and collect every frame that arrives. */
  async function connect(tok, subscribe = []) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tok}`);
    ws.frames = [];
    ws.on('message', (m) => ws.frames.push(JSON.parse(m)));
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    if (subscribe.length) ws.send(JSON.stringify({ subscribe }));
    await new Promise((r) => setTimeout(r, 30));
    clients.push(ws);
    return ws;
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));
  async function close() {
    for (const ws of clients) ws.close();
    n.wss.close();
    await new Promise((r) => n.server.close(r));
  }
  return { n, connect, settle, close };
}

const confirmed = {
  event_type: 'booking.confirmed',
  trace_id: 't-confirm',
  payload: {
    reservation_id: 'res_1', property_id: 'prp_1', guest_id: 'gst_A', host_id: 'hst_B',
    check_in: '2026-12-01', check_out: '2026-12-04', status: 'CONFIRMED', reason: 'private note', total_price: 480,
  },
};

test('canSubscribe: own user channel only; property and task allowed; junk refused', () => {
  const me = { sub: 'gst_A', role: 'guest' };
  assert.strictEqual(canSubscribe(me, 'user:gst_A'), true);
  assert.strictEqual(canSubscribe(me, 'user:gst_C'), false);
  assert.strictEqual(canSubscribe({ sub: 'adm_1', role: 'admin' }, 'user:gst_A'), false); // admins are not let in either
  assert.strictEqual(canSubscribe(me, 'property:prp_1'), true);
  assert.strictEqual(canSubscribe(me, 'task:tsk_1'), true);
  assert.strictEqual(canSubscribe(me, 'admin:all'), false);
  assert.strictEqual(canSubscribe(me, 'user:*'), false);
  assert.strictEqual(canSubscribe(me, { evil: true }), false);
});

test('third user cannot join another user\'s channel and receives nothing', async () => {
  const { n, connect, settle, close } = await setup();
  const guest = await connect(token('gst_A'));
  const snoop = await connect(token('gst_C'), ['user:gst_A', 'user:hst_B']);

  n.push(confirmed);
  n.push({ event_type: 'message.sent', trace_id: 't-msg', payload: { message_id: 'msg_1', thread_id: 'thr_1', sender_id: 'hst_B', receiver_id: 'gst_A' } });
  await settle();

  assert.deepStrictEqual(guest.frames.map((f) => f.type), ['booking.confirmed', 'message.sent']);
  assert.deepStrictEqual(snoop.frames, []);
  await close();
});

test('property watchers get dates and status, never who booked or why', async () => {
  const { n, connect, settle, close } = await setup();
  const guest = await connect(token('gst_A'), ['property:prp_1']); // also watching their own listing page
  const watcher = await connect(token('gst_C'), ['property:prp_1']);

  n.push(confirmed);
  await settle();

  assert.strictEqual(watcher.frames.length, 1);
  assert.deepStrictEqual(watcher.frames[0].payload, {
    property_id: 'prp_1', check_in: '2026-12-01', check_out: '2026-12-04', status: 'CONFIRMED',
  });
  // The guest involved gets the full payload exactly once, even though they are on both channels.
  assert.strictEqual(guest.frames.length, 1);
  assert.strictEqual(guest.frames[0].payload.guest_id, 'gst_A');
  assert.strictEqual(guest.frames[0].payload.reason, 'private note');
  await close();
});

test('booking.requested reaches the host and guest only, not listing watchers', async () => {
  assert.ok(PUSHED_TOPICS.includes('booking.requested'));
  const { n, connect, settle, close } = await setup();
  const host = await connect(token('hst_B', 'host'));
  const watcher = await connect(token('gst_C'), ['property:prp_1']);

  n.push({
    event_type: 'booking.requested', trace_id: 't-req',
    payload: { reservation_id: 'res_2', property_id: 'prp_1', guest_id: 'gst_A', host_id: 'hst_B', check_in: '2026-12-10', check_out: '2026-12-12', guest_message: 'hi' },
  });
  await settle();

  assert.strictEqual(host.frames.length, 1);
  assert.strictEqual(host.frames[0].type, 'booking.requested');
  assert.strictEqual(host.frames[0].payload.guest_message, 'hi');
  assert.deepStrictEqual(watcher.frames, []);
  await close();
});

test('message.sent goes only to the receiver, never to a listing channel', async () => {
  const ch = channelsFor({ event_type: 'message.sent', payload: { receiver_id: 'gst_A', sender_id: 'hst_B', property_id: 'prp_1', guest_id: 'gst_A', host_id: 'hst_B' } });
  assert.deepStrictEqual(ch, ['user:gst_A']);
});

test('ai.results on a task channel reach only the task owner or an admin', async () => {
  const { n, connect, settle, close } = await setup();
  const owner = await connect(token('gst_A'), ['task:tsk_1']);
  const other = await connect(token('gst_C'), ['task:tsk_1']);
  const admin = await connect(token('adm_1', 'admin'), ['task:tsk_1']);

  n.push({ event_type: 'ai.results', trace_id: 't-ai', payload: { task_id: 'tsk_1', user_id: 'gst_A', recommendations: [] } });
  await settle();

  assert.strictEqual(owner.frames.length, 1);
  assert.strictEqual(admin.frames.length, 1);
  assert.deepStrictEqual(other.frames, []);
  await close();
});

test('a user cannot unsubscribe from (or lose) their own channel', async () => {
  const { n, connect, settle, close } = await setup();
  const guest = await connect(token('gst_A'));
  guest.send(JSON.stringify({ unsubscribe: ['user:gst_A'] }));
  await settle();
  n.push(confirmed);
  await settle();
  assert.strictEqual(guest.frames.length, 1);
  await close();
});

test('tokens signed with another algorithm or without sub are refused', async () => {
  const { n, close } = await setup();
  const port = n.server.address().port;
  const none = jwt.sign({ sub: 'gst_A', role: 'guest' }, '', { algorithm: 'none' });
  const noSub = jwt.sign({ role: 'guest' }, SECRET);
  for (const tok of [none, noSub]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tok}`);
    const code = await new Promise((r) => {
      ws.on('close', (c) => r(c));
      setTimeout(() => { ws.terminate(); r('still open'); }, 500);
    });
    assert.strictEqual(code, 4401);
  }
  await close();
});

test('one connection holds at most MAX_CHANNELS channels; the rest are ignored', async () => {
  const { n, connect, settle, close } = await setup();
  const many = Array.from({ length: MAX_CHANNELS + 20 }, (_, i) => `property:prp_${i}`);
  const guest = await connect(token('gst_A'), many);
  const ws = [...n.wss.clients][0];
  assert.strictEqual(ws.channels.size, MAX_CHANNELS);
  assert.ok(ws.channels.has('user:gst_A')); // own channel kept
  guest.send(JSON.stringify({ subscribe: ['property:prp_late'] }));
  await settle();
  assert.strictEqual(ws.channels.size, MAX_CHANNELS);
  assert.ok(!ws.channels.has('property:prp_late'));
  n.push({ ...confirmed, payload: { ...confirmed.payload, property_id: 'prp_0', guest_id: 'gst_X', host_id: 'hst_X' } });
  await settle();
  assert.strictEqual(guest.frames.length, 1); // channels within the cap still work
  await close();
});

test('an oversized client frame closes the connection', async () => {
  const { n, connect, settle, close } = await setup();
  const guest = await connect(token('gst_A'));
  const code = new Promise((r) => guest.on('close', (c) => r(c)));
  guest.send(JSON.stringify({ subscribe: ['x'.repeat(32 * 1024)] }));
  assert.strictEqual(await code, 1009); // message too big; the gateway itself keeps running
  await settle();
  assert.strictEqual(n.wss.clients.size, 0);
  const other = await connect(token('gst_B'));
  n.push({ ...confirmed, payload: { ...confirmed.payload, guest_id: 'gst_B' } });
  await settle();
  assert.strictEqual(other.frames.length, 1); // still serving other users
  await close();
});

// ---------------------------------------------------------------- account status on connect (review on #6)
const closeCode = (port, tok) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${tok}`);
  const frames = [];
  ws.on('message', (m) => frames.push(JSON.parse(m)));
  ws.on('open', () => ws.send(JSON.stringify({ subscribe: ['property:prp_1'] })));
  ws.on('close', (code) => resolve({ code, frames }));
  setTimeout(() => { ws.terminate(); resolve({ code: 'still open', frames }); }, 1000);
});

test('a deleted account\'s token is refused with 4401 and hears nothing, not even its own channel', async () => {
  const { n, close } = await setup({ checkAccount: async (id) => (id === 'gst_gone' ? 'revoked' : 'active') });
  const port = n.server.address().port;
  const pending = closeCode(port, token('gst_gone'));
  await new Promise((r) => setTimeout(r, 50));
  n.push({ ...confirmed, payload: { ...confirmed.payload, guest_id: 'gst_gone' } });
  const { code, frames } = await pending;
  assert.strictEqual(code, 4401);
  assert.strictEqual(frames.length, 0);
  await close();
});

test('if the account check cannot run, the socket is refused (4503), not let through', async () => {
  for (const checkAccount of [async () => 'unavailable', async () => { throw new Error('mysql down'); }]) {
    const { n, close } = await setup({ checkAccount });
    const { code } = await closeCode(n.server.address().port, token('gst_A'));
    assert.strictEqual(code, 4503);
    await close();
  }
});

test('an active account is checked once by its id and works as before', async () => {
  const seen = [];
  const { n, connect, settle, close } = await setup({ checkAccount: async (id) => { seen.push(id); return 'active'; } });
  const guest = await connect(token('gst_A'));
  n.push(confirmed);
  await settle();
  assert.deepStrictEqual(seen, ['gst_A']);
  assert.strictEqual(guest.frames.length, 1);
  await close();
});
