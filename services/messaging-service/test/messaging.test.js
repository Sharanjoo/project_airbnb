process.env.NODE_ENV = 'test';
// The six messaging endpoints with in-memory fakes: participant-only access, thread
// open/reuse, send dedupe, message.sent payload, pagination and read status.
const test = require('node:test');
const assert = require('node:assert');
const { createApp, logger } = require('@airbnb/common');
const { buildRouter } = require('../src/routes');
const { channelsFor } = require('../../notification-gateway/src/index');
const { fakeStore, fakeDirectory, fakeBus } = require('./fakes');

const GUEST = { id: 'gst_1', role: 'guest' };
const HOST = { id: 'hst_1', role: 'host' };
const OUTSIDER = { id: 'gst_2', role: 'guest' };
const OTHER_HOST = { id: 'hst_2', role: 'host' };
const ADMIN = { id: 'hst_admin', role: 'admin' };

async function setup() {
  const store = fakeStore();
  const directory = fakeDirectory();
  const bus = fakeBus();
  const app = createApp({ name: 'msg-test', logger });
  app.use(buildRouter({ bus, store, directory }));
  app.finalize();
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body, user) => {
    const headers = { 'Content-Type': 'application/json' };
    if (user) Object.assign(headers, { 'X-User-Id': user.id, 'X-User-Role': user.role });
    const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const ctx = { store, directory, bus, call, close: () => server.close() };
  ctx.openThread = async () => (await call('/threads/open', { property_id: 'prp_active' }, GUEST)).body.data;
  return ctx;
}

const withCtx = (fn) => async () => {
  const ctx = await setup();
  try { await fn(ctx); } finally { ctx.close(); }
};

// ---------------------------------------------------------------- threads/open
test('open: guest asks about a listing -> 201 with the host as counterpart; again -> 200, same thread', withCtx(async ({ call }) => {
  const first = await call('/threads/open', { property_id: 'prp_active' }, GUEST);
  assert.strictEqual(first.status, 201);
  const t = first.body.data;
  assert.match(t.thread_id, /^thr_/);
  assert.deepStrictEqual([t.guest_id, t.host_id, t.property_id], ['gst_1', 'hst_1', 'prp_active']);
  assert.deepStrictEqual(t.counterpart, { user_id: 'hst_1', name: 'Hana Host' });
  assert.strictEqual(t.property_title, 'Garden studio');
  assert.strictEqual(t.unread_count, 0);
  const again = await call('/threads/open', { property_id: 'prp_active' }, GUEST);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.data.thread_id, t.thread_id);
}));

test('open by listing: host -> 403, paused -> 410, deleted or unknown -> 404, both or neither id -> 400', withCtx(async ({ call }) => {
  assert.strictEqual((await call('/threads/open', { property_id: 'prp_active' }, HOST)).status, 403);
  assert.strictEqual((await call('/threads/open', { property_id: 'prp_paused' }, GUEST)).status, 410);
  assert.strictEqual((await call('/threads/open', { property_id: 'prp_gone' }, GUEST)).status, 404);
  assert.strictEqual((await call('/threads/open', { property_id: 'prp_nope' }, GUEST)).status, 404);
  assert.strictEqual((await call('/threads/open', {}, GUEST)).status, 400);
  assert.strictEqual((await call('/threads/open', { property_id: 'prp_active', reservation_id: 'res_1' }, GUEST)).status, 400);
  assert.strictEqual((await call('/threads/open', { property_id: 'prp_active' })).status, 401);
}));

test('open by reservation: guest and host of the booking share one thread; anyone else -> 404', withCtx(async ({ call }) => {
  const byHost = await call('/threads/open', { reservation_id: 'res_1' }, HOST);
  assert.strictEqual(byHost.status, 201);
  assert.deepStrictEqual(byHost.body.data.reservation_ids, ['res_1']);
  assert.deepStrictEqual(byHost.body.data.counterpart, { user_id: 'gst_1', name: 'Ana G.' });
  const byGuest = await call('/threads/open', { reservation_id: 'res_1' }, GUEST);
  assert.strictEqual(byGuest.body.data.thread_id, byHost.body.data.thread_id);
  // also the same thread the guest gets when asking about that listing
  assert.strictEqual((await call('/threads/open', { property_id: 'prp_active' }, GUEST)).body.data.thread_id, byHost.body.data.thread_id);
  for (const who of [OUTSIDER, OTHER_HOST, ADMIN]) {
    assert.strictEqual((await call('/threads/open', { reservation_id: 'res_1' }, who)).status, 404, who.id);
  }
  assert.strictEqual((await call('/threads/open', { reservation_id: 'res_missing' }, GUEST)).status, 404);
}));

// ---------------------------------------------------------------- threads/get + byUser
test('get: participants only; outsider, other host and admin get 404, the same as an unknown id', withCtx(async (ctx) => {
  const t = await ctx.openThread();
  assert.strictEqual((await ctx.call('/threads/get', { thread_id: t.thread_id }, GUEST)).status, 200);
  const asHost = await ctx.call('/threads/get', { thread_id: t.thread_id }, HOST);
  assert.strictEqual(asHost.body.data.counterpart.user_id, 'gst_1');
  for (const who of [OUTSIDER, OTHER_HOST, ADMIN]) {
    const r = await ctx.call('/threads/get', { thread_id: t.thread_id }, who);
    assert.strictEqual(r.status, 404, who.id);
    assert.strictEqual(r.body.error.code, 'NOT_FOUND');
  }
  assert.strictEqual((await ctx.call('/threads/get', { thread_id: 'thr_doesnotexist' }, GUEST)).status, 404);
  assert.strictEqual((await ctx.call('/threads/get', { thread_id: 'not-an-id' }, GUEST)).status, 400);
  assert.strictEqual((await ctx.call('/threads/get', { thread_id: t.thread_id })).status, 401);
}));

test('byUser: only the caller\'s threads, newest message first, unread counts; another user_id -> 403', withCtx(async (ctx) => {
  const a = await ctx.openThread();
  const b = (await ctx.call('/threads/open', { reservation_id: 'res_1' }, HOST)).body.data; // same triple -> same thread
  assert.strictEqual(a.thread_id, b.thread_id);
  ctx.directory.properties.set('prp_two', { property_id: 'prp_two', host_id: 'hst_2', title: 'Second place', status: 'active' });
  const c = (await ctx.call('/threads/open', { property_id: 'prp_two' }, GUEST)).body.data;
  await ctx.call('/messages/send', { thread_id: a.thread_id, message_text: 'older', client_message_id: 'c1' }, HOST);
  await ctx.call('/messages/send', { thread_id: c.thread_id, message_text: 'newer', client_message_id: 'c2' }, OTHER_HOST);

  const mine = (await ctx.call('/threads/byUser', {}, GUEST)).body.data;
  assert.strictEqual(mine.total, 2);
  assert.deepStrictEqual(mine.items.map((t) => t.thread_id), [c.thread_id, a.thread_id]);
  assert.deepStrictEqual(mine.items.map((t) => t.unread_count), [1, 1]);
  assert.strictEqual(mine.items[0].last_message.preview, 'newer');

  assert.strictEqual((await ctx.call('/threads/byUser', {}, HOST)).body.data.total, 1);
  assert.strictEqual((await ctx.call('/threads/byUser', {}, OUTSIDER)).body.data.total, 0);
  assert.strictEqual((await ctx.call('/threads/byUser', { user_id: 'gst_1' }, GUEST)).status, 200);
  assert.strictEqual((await ctx.call('/threads/byUser', { user_id: 'gst_1' }, OUTSIDER)).status, 403);
  assert.strictEqual((await ctx.call('/threads/byUser', { user_id: 'gst_1' }, ADMIN)).status, 403);
  const paged = (await ctx.call('/threads/byUser', { page: 2, page_size: 1 }, GUEST)).body.data;
  assert.deepStrictEqual([paged.page, paged.page_size, paged.total, paged.items[0].thread_id], [2, 1, 2, a.thread_id]);
}));

// ---------------------------------------------------------------- messages/send
test('send: stored for the other participant, 201, and message.sent carries ids only (no text, no property)', withCtx(async (ctx) => {
  const t = await ctx.openThread();
  const r = await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: '  Is early check-in possible?  ', client_message_id: 'u-1' }, GUEST);
  assert.strictEqual(r.status, 201);
  const m = r.body.data;
  assert.deepStrictEqual(
    { sender: m.sender_id, receiver: m.receiver_id, text: m.message_text, read: m.read_at, ref: m.client_message_id },
    { sender: 'gst_1', receiver: 'hst_1', text: 'Is early check-in possible?', read: null, ref: 'u-1' },
  );
  assert.strictEqual(ctx.bus.sent.length, 1);
  const { topic, env, key } = ctx.bus.sent[0];
  assert.strictEqual(topic, 'message.sent');
  assert.strictEqual(key, t.thread_id, 'keyed by thread so one conversation stays in order');
  assert.deepStrictEqual(Object.keys(env.payload).sort(), ['message_id', 'receiver_id', 'sender_id', 'thread_id', 'timestamp']);
  assert.strictEqual(env.payload.receiver_id, 'hst_1');
  assert.ok(!JSON.stringify(env).includes('early check-in'), 'message text never leaves through Kafka');
  assert.deepStrictEqual([env.actor_id, env.actor_type, env.entity.entity_type, env.idempotency_key], ['gst_1', 'guest', 'message', `message:${m.message_id}`]);
  // Through Timothy's routing: only the receiver's user channel, never a property channel
  assert.deepStrictEqual(channelsFor(env), ['user:hst_1']);
}));

test('send: same client_message_id again -> 200, same message, still one stored and one event', withCtx(async (ctx) => {
  const t = await ctx.openThread();
  const body = { thread_id: t.thread_id, message_text: 'hello', client_message_id: 'retry-me' };
  const first = await ctx.call('/messages/send', body, GUEST);
  const results = await Promise.all([1, 2, 3].map(() => ctx.call('/messages/send', body, GUEST)));
  assert.deepStrictEqual(results.map((x) => x.status), [200, 200, 200]);
  assert.ok(results.every((x) => x.body.data.message_id === first.body.data.message_id));
  assert.strictEqual(ctx.store.messages._all.size, 1);
  assert.strictEqual(ctx.bus.sent.length, 1);
  // reused id with different text -> conflict, nothing stored
  const reused = await ctx.call('/messages/send', { ...body, message_text: 'something else' }, GUEST);
  assert.strictEqual(reused.status, 409);
  assert.strictEqual(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  // the same client id from the other participant is a different message
  assert.strictEqual((await ctx.call('/messages/send', body, HOST)).status, 201);
  assert.strictEqual(ctx.store.messages._all.size, 2);
}));

test('send: without client_message_id every call is a new message', withCtx(async (ctx) => {
  const t = await ctx.openThread();
  await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: 'a' }, GUEST);
  await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: 'a' }, GUEST);
  assert.strictEqual(ctx.store.messages._all.size, 2);
}));

test('send: outsiders, other hosts and admins cannot post into the thread; bad bodies -> 400', withCtx(async (ctx) => {
  const t = await ctx.openThread();
  for (const who of [OUTSIDER, OTHER_HOST, ADMIN]) {
    assert.strictEqual((await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: 'let me in' }, who)).status, 404, who.id);
  }
  assert.strictEqual(ctx.store.messages._all.size, 0);
  assert.strictEqual(ctx.bus.sent.length, 0);
  assert.strictEqual((await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: '   ' }, GUEST)).status, 400);
  assert.strictEqual((await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: 'x'.repeat(2001) }, GUEST)).status, 400);
  assert.strictEqual((await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: 'x', sender_id: 'hst_1' }, GUEST)).status, 400, 'sender comes from the token only');
  assert.strictEqual((await ctx.call('/messages/send', { thread_id: 'thr_unknown', message_text: 'x' }, GUEST)).status, 404);
}));

test('send: Kafka down -> 503 retryable, message kept; the client retry publishes it exactly once', withCtx(async (ctx) => {
  const t = await ctx.openThread();
  const body = { thread_id: t.thread_id, message_text: 'are pets ok?', client_message_id: 'k-1' };
  ctx.bus.down = true;
  const failed = await ctx.call('/messages/send', body, GUEST);
  assert.strictEqual(failed.status, 503);
  assert.strictEqual(failed.body.error.retryable, true);
  assert.strictEqual(ctx.store.messages._all.size, 1);
  ctx.bus.down = false;
  const retry = await ctx.call('/messages/send', body, GUEST);
  assert.strictEqual(retry.status, 200);
  await ctx.call('/messages/send', body, GUEST);
  assert.strictEqual(ctx.bus.sent.length, 1, 'published by the retry, not again after that');
  assert.strictEqual(ctx.store.messages._all.size, 1);
}));

// ---------------------------------------------------------------- messages/list
test('list: cursor pagination returns every message once, oldest to newest within a page', withCtx(async (ctx) => {
  const t = await ctx.openThread();
  for (let i = 1; i <= 7; i++) {
    await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: `m${i}`, client_message_id: `p${i}` }, i % 2 ? GUEST : HOST);
  }
  const p1 = (await ctx.call('/messages/list', { thread_id: t.thread_id, limit: 3 }, HOST)).body.data;
  assert.deepStrictEqual(p1.items.map((m) => m.message_text), ['m5', 'm6', 'm7']);
  assert.strictEqual(p1.has_more, true);
  const p2 = (await ctx.call('/messages/list', { thread_id: t.thread_id, limit: 3, before: p1.next_before }, HOST)).body.data;
  assert.deepStrictEqual(p2.items.map((m) => m.message_text), ['m2', 'm3', 'm4']);
  const p3 = (await ctx.call('/messages/list', { thread_id: t.thread_id, limit: 3, before: p2.next_before }, HOST)).body.data;
  assert.deepStrictEqual(p3.items.map((m) => m.message_text), ['m1']);
  assert.deepStrictEqual([p3.has_more, p3.next_before], [false, null]);
  assert.strictEqual((await ctx.call('/messages/list', { thread_id: t.thread_id, limit: 101 }, HOST)).status, 400);
}));

test('list: outsider -> 404; a cursor from another thread -> 400 (cannot be used to read it)', withCtx(async (ctx) => {
  const t = await ctx.openThread();
  await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: 'private' }, GUEST);
  const r = await ctx.call('/messages/list', { thread_id: t.thread_id }, OUTSIDER);
  assert.strictEqual(r.status, 404);
  assert.ok(!JSON.stringify(r.body).includes('private'));

  ctx.directory.properties.set('prp_x', { property_id: 'prp_x', host_id: 'hst_2', title: 'X', status: 'active' });
  const mine = (await ctx.call('/threads/open', { property_id: 'prp_x' }, OUTSIDER)).body.data;
  const foreignId = [...ctx.store.messages._all.keys()][0];
  const probe = await ctx.call('/messages/list', { thread_id: mine.thread_id, before: foreignId }, OUTSIDER);
  assert.strictEqual(probe.status, 400);
  assert.ok(!JSON.stringify(probe.body).includes('private'));
}));

// ---------------------------------------------------------------- messages/markRead
test('markRead: marks only messages addressed to the caller, optionally up to one message', withCtx(async (ctx) => {
  const t = await ctx.openThread();
  const ids = [];
  for (let i = 1; i <= 3; i++) ids.push((await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: `g${i}` }, GUEST)).body.data.message_id);
  await ctx.call('/messages/send', { thread_id: t.thread_id, message_text: 'h1' }, HOST);

  // the guest reading does not mark their own messages as read
  const g = (await ctx.call('/messages/markRead', { thread_id: t.thread_id }, GUEST)).body.data;
  assert.deepStrictEqual([g.marked_read, g.unread_count], [1, 0]);
  const partial = (await ctx.call('/messages/markRead', { thread_id: t.thread_id, up_to_message_id: ids[1] }, HOST)).body.data;
  assert.deepStrictEqual([partial.marked_read, partial.unread_count], [2, 1]);
  const rest = (await ctx.call('/messages/markRead', { thread_id: t.thread_id }, HOST)).body.data;
  assert.deepStrictEqual([rest.marked_read, rest.unread_count], [1, 0]);
  assert.strictEqual((await ctx.call('/messages/markRead', { thread_id: t.thread_id }, HOST)).body.data.marked_read, 0, 'repeat is harmless');

  const list = (await ctx.call('/messages/list', { thread_id: t.thread_id }, GUEST)).body.data.items;
  assert.ok(list.filter((m) => m.sender_id === 'gst_1').every((m) => m.read_at), 'the guest sees their messages were read');

  assert.strictEqual((await ctx.call('/messages/markRead', { thread_id: t.thread_id }, OUTSIDER)).status, 404);
  assert.strictEqual((await ctx.call('/messages/markRead', { thread_id: t.thread_id, up_to_message_id: 'msg_notinthread' }, HOST)).status, 400);
}));
