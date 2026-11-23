process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { createApp, createEnvelope, logger } = require('@airbnb/common');
const { buildRouter } = require('../src/routes');
const { fillDays, median, toSteps } = require('../src/models/stats');

// ---------------------------------------------------------------- fakes
function fakeStats({ traceEvents = [], down = false, ownProperties = ['prp_1'] } = {}) {
  const calls = [];
  const stored = new Map();
  const rec = (name, result) => async (...args) => {
    calls.push({ name, args });
    if (down) throw new Error('db down');
    return typeof result === 'function' ? result(...args) : result;
  };
  return {
    calls,
    stored,
    platform: rec('platform', { users: { guests: 2, hosts: 1 } }),
    trace: rec('trace', traceEvents),
    host: rec('host', { revenue: 480 }),
    guest: rec('guest', { saved_properties: 3 }),
    funnel: rec('funnel', (hostId, { propertyId }) => {
      const ids = propertyId ? ownProperties.filter((p) => p === propertyId) : ownProperties;
      return { property_ids: ids, steps: toSteps([10, 4, 2, 1, 1]) };
    }),
    top: rec('top', [{ property_id: 'prp_1', value: 5 }]),
    geo: rec('geo', [{ city: 'San Jose', bookings: 3 }]),
    ai: rec('ai', { requests: 2 }),
    storeEvents: rec('storeEvents', (envs) => {
      let n = 0;
      for (const e of envs) if (!stored.has(e.event_id)) { stored.set(e.event_id, e); n++; }
      return n;
    }),
  };
}

async function start(deps) {
  const app = createApp({ name: 'analytics-test', logger });
  app.use(buildRouter({ bus: {}, ...deps }));
  app.finalize();
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const ADMIN = { 'X-User-Id': 'adm_1', 'X-User-Role': 'admin' };
const HOST = { 'X-User-Id': 'hst_1', 'X-User-Role': 'host' };
const GUEST = { 'X-User-Id': 'gst_1', 'X-User-Role': 'guest' };
const OTHER_GUEST = { 'X-User-Id': 'gst_9', 'X-User-Role': 'guest' };

async function get(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: await res.json() };
}
async function post(base, path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function withService(opts, fn) {
  const stats = fakeStats(opts.stats);
  const dlq = [];
  const sendToDlq = opts.dlqDown
    ? async () => { throw new Error('broker down'); }
    : async (topic, env, reason) => { dlq.push({ topic, env, reason }); };
  const { server, base } = await start({ stats, sendToDlq });
  try {
    await fn({ base, stats, dlq });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------- helpers
test('fillDays: every day in the window, zeros for gaps', () => {
  const out = fillDays('2026-11-01', '2026-11-04', [{ day: '2026-11-02', count: 3 }]);
  assert.deepStrictEqual(out, [
    { day: '2026-11-01', count: 0 }, { day: '2026-11-02', count: 3 }, { day: '2026-11-03', count: 0 },
  ]);
});

test('median and funnel steps', () => {
  assert.strictEqual(median([]), null);
  assert.strictEqual(median([5, 1, 3]), 3);
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  const steps = toSteps([10, 4, 2, 1, 0]);
  assert.deepStrictEqual(steps.map((s) => s.step), ['viewed', 'saved', 'requested', 'confirmed', 'completed']);
  assert.strictEqual(steps[2].from_views, 0.2);
  assert.strictEqual(steps[2].from_previous, 0.5);
  assert.strictEqual(steps[0].from_previous, null);
  assert.strictEqual(toSteps([0, 0, 0, 0, 0])[1].from_views, null); // no divide by zero
});

// ---------------------------------------------------------------- windows and roles
test('platform: admin gets data and a 30-day window ending today; others -> 403, no token -> 401', () =>
  withService({}, async ({ base, stats }) => {
    const { status, body } = await get(base, '/analytics/platform', ADMIN);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.users.guests, 2);
    assert.strictEqual(body.data.window.days, 30);
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    assert.strictEqual(body.data.window.until, tomorrow);
    assert.strictEqual((Date.parse(body.data.window.until) - Date.parse(body.data.window.since)) / 86400000, 30);
    assert.deepStrictEqual(stats.calls[0].args[0], body.data.window);

    assert.strictEqual((await get(base, '/analytics/platform', HOST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/platform', GUEST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/platform')).status, 401);
  }));

test('window: ?days is validated; unknown query parameters -> 400', () =>
  withService({}, async ({ base }) => {
    const seven = await get(base, '/analytics/platform?days=7', ADMIN);
    assert.strictEqual(seven.body.data.window.days, 7);
    for (const qs of ['?days=0', '?days=366', '?days=abc', '?foo=1']) {
      const { status, body } = await get(base, `/analytics/platform${qs}`, ADMIN);
      assert.strictEqual(status, 400, qs);
      assert.strictEqual(body.error.code, 'VALIDATION_ERROR');
    }
  }));

test('dashboards: host and guest each get their own, computed for the caller id', () =>
  withService({}, async ({ base, stats }) => {
    const h = await get(base, '/analytics/host/dashboard', HOST);
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.body.data.revenue, 480);
    assert.strictEqual(stats.calls.find((c) => c.name === 'host').args[0], 'hst_1');
    const g = await get(base, '/analytics/guest/dashboard', GUEST);
    assert.strictEqual(g.status, 200);
    assert.strictEqual(g.body.data.saved_properties, 3);
    assert.strictEqual(stats.calls.find((c) => c.name === 'guest').args[0], 'gst_1');

    assert.strictEqual((await get(base, '/analytics/host/dashboard', GUEST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/guest/dashboard', HOST)).status, 403);
  }));

test('funnel: host only; own listing filter works; someone else\'s listing -> 404', () =>
  withService({}, async ({ base }) => {
    const all = await get(base, '/analytics/funnel', HOST);
    assert.strictEqual(all.status, 200);
    assert.strictEqual(all.body.data.steps[0].count, 10);
    assert.strictEqual(all.body.data.property_id, null);
    const one = await get(base, '/analytics/funnel?property_id=prp_1', HOST);
    assert.strictEqual(one.body.data.property_id, 'prp_1');
    assert.strictEqual((await get(base, '/analytics/funnel?property_id=prp_other', HOST)).status, 404);
    assert.strictEqual((await get(base, '/analytics/funnel', GUEST)).status, 403);
  }));

test('top: metric and limit validated; signed-in users only', () =>
  withService({}, async ({ base, stats }) => {
    const { status, body } = await get(base, '/analytics/properties/top?metric=views&limit=5', GUEST);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.metric, 'views');
    assert.strictEqual(stats.calls[0].args[0].limit, 5);
    assert.strictEqual((await get(base, '/analytics/properties/top?metric=likes', GUEST)).status, 400);
    assert.strictEqual((await get(base, '/analytics/properties/top?limit=51', GUEST)).status, 400);
    assert.strictEqual((await get(base, '/analytics/properties/top')).status, 401);
  }));

test('geo and ai: admin only', () =>
  withService({}, async ({ base }) => {
    assert.strictEqual((await get(base, '/analytics/geo', ADMIN)).body.data.items[0].city, 'San Jose');
    assert.strictEqual((await get(base, '/analytics/ai', ADMIN)).body.data.requests, 2);
    assert.strictEqual((await get(base, '/analytics/geo', HOST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/ai', GUEST)).status, 403);
  }));

test('database down -> 503 DEPENDENCY_UNAVAILABLE, retryable', () =>
  withService({ stats: { down: true } }, async ({ base }) => {
    const { status, body } = await get(base, '/analytics/platform', ADMIN);
    assert.strictEqual(status, 503);
    assert.strictEqual(body.error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.strictEqual(body.error.retryable, true);
  }));

// ---------------------------------------------------------------- traces
const TRACE = '7c1e4b2a-0d3f-4f8e-9a11-2b6c5d8e9f01';
const journey = [
  { event_id: 'e1', event_type: 'booking.requested', timestamp: '2026-11-20T10:00:00.000Z', actor_id: 'gst_1', actor_type: 'guest', entity: { entity_type: 'reservation', entity_id: 'res_1' }, payload: { guest_id: 'gst_1', host_id: 'hst_1' }, kafka: { topic: 'booking.requested', partition: 0, offset: '4' } },
  { event_id: 'e2', event_type: 'booking.confirmed', timestamp: '2026-11-20T10:00:00.250Z', actor_id: 'booking-worker', actor_type: 'service', entity: { entity_type: 'reservation', entity_id: 'res_1' }, payload: { guest_id: 'gst_1', host_id: 'hst_1' } },
];

test('trace: admin sees the whole journey in order with timings', () =>
  withService({ stats: { traceEvents: journey } }, async ({ base }) => {
    const { status, body } = await get(base, `/traces/${TRACE}`, ADMIN);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.event_count, 2);
    assert.strictEqual(body.data.duration_ms, 250);
    assert.deepStrictEqual(body.data.topics, ['booking.requested', 'booking.confirmed']);
    assert.strictEqual(body.data.events[1].since_start_ms, 250);
    assert.strictEqual(body.data.events[0].kafka.offset, '4');
  }));

test('trace: the guest and host in it can see it; anyone else gets 404 like an unknown trace', () =>
  withService({ stats: { traceEvents: journey } }, async ({ base }) => {
    assert.strictEqual((await get(base, `/traces/${TRACE}`, GUEST)).status, 200);
    assert.strictEqual((await get(base, `/traces/${TRACE}`, HOST)).status, 200);
    const other = await get(base, `/traces/${TRACE}`, OTHER_GUEST);
    assert.strictEqual(other.status, 404);
    assert.strictEqual(other.body.error.message, 'Trace not found.');
    assert.strictEqual((await get(base, `/traces/${TRACE}`)).status, 401);
  }));

test('trace: unknown -> 404, not a UUID -> 400', () =>
  withService({}, async ({ base }) => {
    assert.strictEqual((await get(base, `/traces/${TRACE}`, ADMIN)).status, 404);
    const bad = await get(base, '/traces/not-a-uuid', ADMIN);
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.error.details[0].field, 'trace_id');
  }));

// ---------------------------------------------------------------- ingest
const envelope = () => createEnvelope({
  eventType: 'property.viewed', traceId: randomUUID(), actorId: 'gst_1', actorType: 'guest',
  entityType: 'property', entityId: 'prp_1', payload: { property_id: 'prp_1' },
});

test('ingest: valid envelopes stored once; invalid -> <event_type>.dlq with the reason; unknown type rejected', () =>
  withService({}, async ({ base, stats, dlq }) => {
    const good = envelope();
    const noTrace = { ...envelope() };
    delete noTrace.trace_id;
    const unknown = { ...envelope(), event_type: 'cats.adopted' };

    const { status, body } = await post(base, '/events/ingest', { events: [good, good, noTrace, unknown] }, ADMIN);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.accepted, 2);
    assert.strictEqual(body.data.stored, 1);
    assert.strictEqual(body.data.duplicates, 1);
    assert.strictEqual(body.data.rejected.length, 2);
    assert.strictEqual(body.data.rejected[0].index, 2);
    assert.strictEqual(body.data.rejected[0].dlq, 'property.viewed.dlq');
    assert.match(body.data.rejected[0].reason, /trace_id/);
    assert.strictEqual(body.data.rejected[1].dlq, null);
    assert.strictEqual(dlq.length, 1);
    assert.strictEqual(dlq[0].topic, 'property.viewed');
    assert.strictEqual(stats.stored.size, 1);

    const again = await post(base, '/events/ingest', { events: [good] }, ADMIN);
    assert.strictEqual(again.body.data.stored, 0);
  }));

test('ingest: admin only; body validated; DLQ down still answers', () =>
  withService({ dlqDown: true }, async ({ base }) => {
    assert.strictEqual((await post(base, '/events/ingest', { events: [envelope()] }, HOST)).status, 403);
    assert.strictEqual((await post(base, '/events/ingest', { events: [] }, ADMIN)).status, 400);
    assert.strictEqual((await post(base, '/events/ingest', { nope: 1 }, ADMIN)).status, 400);
    const bad = { ...envelope(), timestamp: 'yesterday' };
    const { status, body } = await post(base, '/events/ingest', { events: [bad] }, ADMIN);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.rejected[0].dlq, null);
  }));
