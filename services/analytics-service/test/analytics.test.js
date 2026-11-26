process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('crypto');
const { createApp, createEnvelope, logger } = require('@airbnb/common');
const { buildRouter, rangeWindow, daysWindow } = require('../src/routes');
const { fillDays, median, conversion, producerOf } = require('../src/models/stats');

// ---------------------------------------------------------------- fakes
// Same interface as src/models/stats.js and src/models/kafkaStats.js.
function fakeStats({ trace = { steps: [], participants: new Set() }, down = false, owners = { prp_1: 'hst_1', prp_2: 'hst_2' } } = {}) {
  const calls = [];
  const stored = new Map();
  const rejected = [];
  const rec = (name, result) => async (...args) => {
    calls.push({ name, args });
    if (down) throw new Error('db down');
    return typeof result === 'function' ? result(...args) : result;
  };
  const steps = { viewed: 10, saved: 4, requested: 2, confirmed: 1, completed: 1 };
  return {
    calls,
    stored,
    rejected,
    propertyOwner: rec('propertyOwner', (id) => owners[id] || null),
    funnel: rec('funnel', () => ({ steps, conversion: conversion(steps) })),
    hostDashboard: rec('hostDashboard', { occupancy_rate: 0.5, revenue_total: 480 }),
    guestDashboard: rec('guestDashboard', { avg_match_score: 0.81 }),
    top: rec('top', [{ property_id: 'prp_1', title: 'Loft', value: 5 }]),
    geo: rec('geo', [{ region: 'San Jose', searches: 12, bookings: 3, avg_price: 168.4 }]),
    platform: rec('platform', {
      events_by_topic: { 'booking.requested': 2 }, throughput_per_min: 0.1, errors: 0, retries: 0,
      rejected_envelopes: 1, avg_workflow_latency_ms: { booking: 236, ai_recommendation: null },
    }),
    ai: rec('ai', { tasks: 2, votes: { keep: 1, switch: 1, abstain: 0 } }),
    trace: rec('trace', trace),
    storeRejected: rec('storeRejected', (items) => { rejected.push(...items); }),
    storeEvents: rec('storeEvents', (envs) => {
      let n = 0;
      for (const e of envs) if (!stored.has(e.event_id)) { stored.set(e.event_id, e); n++; }
      return n;
    }),
  };
}

const fakeKafka = (snap = { consumer_lag: { 'analytics-cg': 0 }, dlq_messages: 2 }) => ({ snapshot: async () => snap });

async function withService(opts, fn) {
  const stats = fakeStats(opts.stats);
  const app = createApp({ name: 'analytics-test', logger });
  app.use(buildRouter({ bus: {}, stats, kafka: fakeKafka(opts.kafka) }));
  app.finalize();
  const server = app.listen(0);
  try {
    await fn({ base: `http://127.0.0.1:${server.address().port}`, stats });
  } finally {
    server.close();
  }
}

const ADMIN = { 'X-User-Id': 'adm_1', 'X-User-Role': 'admin' };
const HOST = { 'X-User-Id': 'hst_1', 'X-User-Role': 'host' };
const GUEST = { 'X-User-Id': 'gst_1', 'X-User-Role': 'guest' };
const OTHER_GUEST = { 'X-User-Id': 'gst_9', 'X-User-Role': 'guest' };
const SERVICE = { 'X-User-Id': 'svc:booking-worker', 'X-User-Role': 'service' };

async function get(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, body: await res.json() };
}
async function post(base, path, body, headers = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const callOf = (stats, name) => stats.calls.find((c) => c.name === name);

// ---------------------------------------------------------------- helpers
test('windows: date-only `to` covers that whole day; default is the last 30 days; limits enforced', () => {
  const w = rangeWindow({ from: '2026-10-01', to: '2026-10-31' });
  assert.strictEqual(w.from, '2026-10-01T00:00:00.000Z');
  assert.strictEqual(w.to, '2026-11-01T00:00:00.000Z');
  assert.strictEqual(w.fromSql, '2026-10-01 00:00:00.000');
  assert.strictEqual(w.fromDay, '2026-10-01');
  assert.strictEqual(w.toDay, '2026-11-01');
  const exact = rangeWindow({ from: '2026-10-27T15:00:00Z', to: '2026-10-27T16:00:00Z' });
  assert.strictEqual(exact.minutes, 60);
  assert.strictEqual(exact.toDay, '2026-10-28');
  const def = rangeWindow({});
  assert.strictEqual(Math.round((Date.parse(def.to) - Date.parse(def.from)) / 86400000), 30);
  assert.throws(() => rangeWindow({ from: '2026-10-31', to: '2026-10-01' }), /invalid/i);
  assert.throws(() => rangeWindow({ from: '2025-01-01', to: '2026-10-01' }), /invalid/i);
  const g = daysWindow(30);
  assert.strictEqual((Date.parse(g.to) - Date.parse(g.from)) / 86400000, 30);
  assert.strictEqual(g.to.slice(11), '00:00:00.000Z');
});

test('windows through HTTP: a date-only `to` still includes that whole day', () =>
  withService({}, async ({ base, stats }) => {
    const { body } = await get(base, '/analytics/host/dashboard?from=2026-10-26&to=2026-11-24', HOST);
    assert.strictEqual(body.data.from, '2026-10-26T00:00:00.000Z');
    assert.strictEqual(body.data.to, '2026-11-25T00:00:00.000Z'); // 30 whole days
    const w = callOf(stats, 'hostDashboard').args[1];
    assert.strictEqual(w.toDay, '2026-11-25');
  }));

test('fillDays, median, conversion and producer mapping', () => {
  assert.deepStrictEqual(
    fillDays('2026-11-01', '2026-11-04', new Map([['2026-11-02', { count: 3 }]]), () => ({ count: 0 })),
    [{ date: '2026-11-01', count: 0 }, { date: '2026-11-02', count: 3 }, { date: '2026-11-03', count: 0 }],
  );
  assert.strictEqual(median([]), null);
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  assert.deepStrictEqual(conversion({ viewed: 412, saved: 63, requested: 19, confirmed: 14, completed: 9 }), {
    viewed_to_saved: 0.153, saved_to_requested: 0.302, requested_to_confirmed: 0.737, confirmed_to_completed: 0.643,
  }); // the API doc §13.6 example numbers
  assert.strictEqual(conversion({ viewed: 0, saved: 0, requested: 0, confirmed: 0, completed: 0 }).viewed_to_saved, null);
  assert.strictEqual(producerOf('booking.requested'), 'booking-service');
  assert.strictEqual(producerOf('booking.confirmed'), 'booking-worker');
  assert.strictEqual(producerOf('debate.round.1'), 'ai-service');
});

// ---------------------------------------------------------------- top
test('top: metric, city, limit and from/to passed through; doc shape; validation', () =>
  withService({}, async ({ base, stats }) => {
    const { status, body } = await get(base, '/analytics/properties/top?metric=saves&from=2026-10-01&to=2026-10-31&city=San%20Jose&limit=3', GUEST);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.metric, 'saves');
    assert.strictEqual(body.data.city, 'San Jose');
    assert.strictEqual(body.data.from, '2026-10-01T00:00:00.000Z');
    assert.deepStrictEqual(body.data.items[0], { property_id: 'prp_1', title: 'Loft', value: 5 });
    assert.deepStrictEqual(callOf(stats, 'top').args[0], { metric: 'saves', city: 'San Jose', limit: 3 });
    for (const qs of ['metric=rating', 'limit=51', 'from=yesterday', 'days=30', 'from=2026-10-31&to=2026-10-01']) {
      assert.strictEqual((await get(base, `/analytics/properties/top?${qs}`, GUEST)).status, 400, qs);
    }
    assert.strictEqual((await get(base, '/analytics/properties/top')).status, 401);
  }));

// ---------------------------------------------------------------- funnel
test('funnel: host sees own listings as steps + conversion (API doc shape)', () =>
  withService({}, async ({ base, stats }) => {
    const { status, body } = await get(base, '/analytics/funnel?property_id=prp_1&from=2026-10-01&to=2026-10-31', HOST);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.data.steps, { viewed: 10, saved: 4, requested: 2, confirmed: 1, completed: 1 });
    assert.strictEqual(body.data.conversion.viewed_to_saved, 0.4);
    assert.strictEqual(body.data.property_id, 'prp_1');
    assert.deepStrictEqual(callOf(stats, 'funnel').args[0], { hostId: 'hst_1', propertyId: 'prp_1' });
  }));

test('funnel: another host\'s listing or host_id -> 403, unknown listing -> 404, guest -> 403; admin may pick any', () =>
  withService({}, async ({ base, stats }) => {
    assert.strictEqual((await get(base, '/analytics/funnel?property_id=prp_2', HOST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/funnel?host_id=hst_2', HOST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/funnel?property_id=prp_nope', HOST)).status, 404);
    assert.strictEqual((await get(base, '/analytics/funnel', GUEST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/funnel?host_id=hst_2', ADMIN)).status, 200);
    assert.deepStrictEqual(stats.calls.filter((c) => c.name === 'funnel').at(-1).args[0], { hostId: 'hst_2', propertyId: undefined });
  }));

// ---------------------------------------------------------------- dashboards
test('host dashboard: self by default; another host -> 403 (API doc example); admin needs host_id', () =>
  withService({}, async ({ base, stats }) => {
    const own = await get(base, '/analytics/host/dashboard?from=2026-10-01&to=2026-10-31', HOST);
    assert.strictEqual(own.status, 200);
    assert.strictEqual(own.body.data.host_id, 'hst_1');
    assert.strictEqual(own.body.data.revenue_total, 480);
    assert.strictEqual(callOf(stats, 'hostDashboard').args[0], 'hst_1');
    const other = await get(base, '/analytics/host/dashboard?host_id=hst_2', HOST);
    assert.strictEqual(other.status, 403);
    assert.strictEqual(other.body.error.code, 'FORBIDDEN');
    assert.strictEqual((await get(base, '/analytics/host/dashboard', ADMIN)).status, 400);
    assert.strictEqual((await get(base, '/analytics/host/dashboard?host_id=hst_2', ADMIN)).status, 200);
    assert.strictEqual((await get(base, '/analytics/host/dashboard', GUEST)).status, 403);
  }));

test('guest dashboard: self, days default 30; another guest -> 403; days validated', () =>
  withService({}, async ({ base, stats }) => {
    const { status, body } = await get(base, '/analytics/guest/dashboard', GUEST);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.guest_id, 'gst_1');
    assert.strictEqual(body.data.days, 30);
    assert.strictEqual(body.data.avg_match_score, 0.81);
    const [guestId, w] = callOf(stats, 'guestDashboard').args;
    assert.strictEqual(guestId, 'gst_1');
    assert.strictEqual((Date.parse(w.to) - Date.parse(w.from)) / 86400000, 30);
    assert.strictEqual((await get(base, '/analytics/guest/dashboard?guest_id=gst_9', GUEST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/guest/dashboard?days=0', GUEST)).status, 400);
    assert.strictEqual((await get(base, '/analytics/guest/dashboard', HOST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/guest/dashboard?guest_id=gst_1&days=7', ADMIN)).body.data.days, 7);
  }));

// ---------------------------------------------------------------- platform / geo / ai
test('platform: admin only; Kafka lag and DLQ count merged into the doc shape', () =>
  withService({}, async ({ base }) => {
    const { status, body } = await get(base, '/analytics/platform?from=2026-10-27T15:00:00Z&to=2026-10-27T16:00:00Z', ADMIN);
    assert.strictEqual(status, 200);
    for (const k of ['events_by_topic', 'consumer_lag', 'throughput_per_min', 'errors', 'retries', 'dlq_messages', 'rejected_envelopes', 'avg_workflow_latency_ms']) {
      assert.ok(k in body.data, k);
    }
    assert.strictEqual(body.data.dlq_messages, 2);
    assert.deepStrictEqual(body.data.consumer_lag, { 'analytics-cg': 0 });
    assert.strictEqual('kafka_error' in body.data, false);
    assert.strictEqual((await get(base, '/analytics/platform', HOST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/platform')).status, 401);
  }));

test('platform: Kafka unreachable still answers, with nulls and the reason', () =>
  withService({ kafka: { consumer_lag: null, dlq_messages: null, kafka_error: 'Kafka admin timed out' } }, async ({ base }) => {
    const { status, body } = await get(base, '/analytics/platform', ADMIN);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.consumer_lag, null);
    assert.strictEqual(body.data.kafka_error, 'Kafka admin timed out');
  }));

test('geo and ai: admin only, parameters validated', () =>
  withService({}, async ({ base, stats }) => {
    const g = await get(base, '/analytics/geo?group_by=state', ADMIN);
    assert.strictEqual(g.body.data.group_by, 'state');
    assert.strictEqual(g.body.data.items[0].region, 'San Jose');
    assert.deepStrictEqual(callOf(stats, 'geo').args[0], { groupBy: 'state' });
    assert.strictEqual((await get(base, '/analytics/geo?group_by=zip', ADMIN)).status, 400);
    const a = await get(base, '/analytics/ai?version=matcher-v2', ADMIN);
    assert.strictEqual(a.body.data.tasks, 2);
    assert.deepStrictEqual(callOf(stats, 'ai').args[0], { version: 'matcher-v2' });
    assert.strictEqual((await get(base, '/analytics/geo', HOST)).status, 403);
    assert.strictEqual((await get(base, '/analytics/ai', GUEST)).status, 403);
  }));

test('database down -> 503 DEPENDENCY_UNAVAILABLE, retryable', () =>
  withService({ stats: { down: true } }, async ({ base }) => {
    const { status, body } = await get(base, '/analytics/host/dashboard', HOST);
    assert.strictEqual(status, 503);
    assert.strictEqual(body.error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.strictEqual(body.error.retryable, true);
  }));

// ---------------------------------------------------------------- traces
const TRACE = '7c1e4b2a-0d3f-4f8e-9a11-2b6c5d8e9f01';
const journey = {
  steps: [
    { service: 'booking-service', event_type: 'booking.requested', timestamp: '2026-10-27T15:10:01.876Z', latency_ms: 21, status: 'ok', error: null },
    { service: 'booking-worker', event_type: 'booking.requested', timestamp: '2026-10-27T15:10:02.114Z', latency_ms: 38, status: 'ok', error: null },
  ],
  participants: new Set(['gst_1', 'hst_1']),
};

test('trace: doc shape with total_latency_ms; participants and admin see it; others get 404 like unknown', () =>
  withService({ stats: { trace: journey } }, async ({ base }) => {
    const { status, body } = await get(base, `/traces/${TRACE}`, ADMIN);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.total_latency_ms, 238);
    assert.strictEqual(body.data.steps[1].service, 'booking-worker');
    assert.strictEqual((await get(base, `/traces/${TRACE}`, GUEST)).status, 200);
    assert.strictEqual((await get(base, `/traces/${TRACE}`, HOST)).status, 200);
    const other = await get(base, `/traces/${TRACE}`, OTHER_GUEST);
    assert.strictEqual(other.status, 404);
    assert.strictEqual(other.body.error.message, 'Trace not found.');
  }));

test('trace: unknown -> 404, not a UUID -> 400, no token -> 401', () =>
  withService({}, async ({ base }) => {
    assert.strictEqual((await get(base, `/traces/${TRACE}`, ADMIN)).status, 404);
    assert.strictEqual((await get(base, '/traces/not-a-uuid', ADMIN)).status, 400);
    assert.strictEqual((await get(base, `/traces/${TRACE}`)).status, 401);
  }));

// ---------------------------------------------------------------- ingest
const envelope = (actorId = 'gst_1') => createEnvelope({
  eventType: 'property.viewed', traceId: randomUUID(), actorId, actorType: 'guest',
  entityType: 'property', entityId: 'prp_1', payload: { property_id: 'prp_1', viewer_id: actorId, source: 'search' },
});

test('ingest: API doc example (one valid, one malformed) -> 202 {accepted:1, rejected:1, errors}; rejected kept', () =>
  withService({}, async ({ base, stats }) => {
    const { status, body } = await post(base, '/events/ingest', { events: [envelope('svc'), { event_type: 'property.viewed', payload: {} }] }, SERVICE);
    assert.strictEqual(status, 202);
    assert.strictEqual(body.data.accepted, 1);
    assert.strictEqual(body.data.rejected, 1);
    assert.strictEqual(body.data.errors[0].index, 1);
    assert.match(body.data.errors[0].issue, /event_id/);
    assert.strictEqual(stats.stored.size, 1);
    assert.strictEqual(stats.rejected.length, 1);
  }));

test('ingest: a single envelope works; duplicates stored once; unknown topic rejected', () =>
  withService({}, async ({ base, stats }) => {
    const env = envelope();
    const one = await post(base, '/events/ingest', env, SERVICE);
    assert.strictEqual(one.status, 202);
    assert.strictEqual(one.body.data.accepted, 1);
    const again = await post(base, '/events/ingest', { events: [env] }, SERVICE);
    assert.strictEqual(again.body.data.duplicates, 1);
    assert.strictEqual(stats.stored.size, 1);
    const unknown = await post(base, '/events/ingest', { ...envelope(), event_type: 'cats.adopted' }, SERVICE);
    assert.strictEqual(unknown.body.data.rejected, 1);
  }));

test('ingest: services and admins only; guests and hosts get 403 and nothing is stored', () =>
  withService({}, async ({ base, stats }) => {
    for (const who of [GUEST, HOST]) {
      const r = await post(base, '/events/ingest', envelope('gst_1'), who);
      assert.strictEqual(r.status, 403);
    }
    assert.strictEqual(stats.stored.size, 0);
    assert.strictEqual(stats.rejected.length, 0);
    const svc = await post(base, '/events/ingest', envelope('gst_9'), SERVICE);
    assert.strictEqual(svc.body.data.accepted, 1);
    const admin = await post(base, '/events/ingest', envelope('gst_8'), ADMIN);
    assert.strictEqual(admin.body.data.accepted, 1);
  }));

test('ingest: body validated; signed-in callers only', () =>
  withService({}, async ({ base }) => {
    assert.strictEqual((await post(base, '/events/ingest', { events: [] }, SERVICE)).status, 400);
    assert.strictEqual((await post(base, '/events/ingest', { events: 'nope' }, SERVICE)).status, 400);
    assert.strictEqual((await post(base, '/events/ingest', [envelope()], SERVICE)).status, 400);
    assert.strictEqual((await post(base, '/events/ingest', {}, SERVICE)).status, 400); // neither an envelope nor { events }
    assert.strictEqual((await post(base, '/events/ingest', { events: Array(501).fill({}) }, SERVICE)).status, 400);
    assert.strictEqual((await post(base, '/events/ingest', envelope())).status, 401);
  }));

// ---------------------------------------------------------------- AI summary (real event shapes from ai-service)
const { summarizeAi } = require('../src/models/stats');
const at = (ms) => new Date(Date.parse('2026-11-25T10:00:00.000Z') + ms).toISOString();
const evt = (type, trace, ms, payload, key) => ({ event_type: type, trace_id: trace, timestamp: at(ms), payload, idempotency_key: key || `${type}:${trace}:${ms}` });

test('AI summary: the parser\'s second ai.requests does not double the task count or shift the clock', () => {
  const requests = [
    evt('ai.requests', 'tr1', 0, { task_id: 'tsk_1' }, 'api-1'),
    evt('ai.requests', 'tr1', 900, { task_id: 'tsk_1' }, 'tsk_1:parsed'), // parser republish, later
    evt('ai.requests', 'tr2', 0, { task_id: 'tsk_2' }, 'api-2'),
  ];
  const debate = [
    evt('debate.round.0', 'tr1', 3800, { agent: 'matching' }),
    evt('ai.results', 'tr1', 21450, { dissent: [{ agent: 'matching' }] }, 'tsk_1:result'),
  ];
  const s = summarizeAi(requests, debate);
  assert.strictEqual(s.tasks, 2); // unique task_ids, not 3 events
  assert.strictEqual(s.publication_timeline_ms.matching, 3800); // from the FIRST ai.requests, not 2900
  assert.strictEqual(s.publication_timeline_ms.verdict, 21450);
});

test('AI summary: round-1 retries are skipped and redelivered events count once', () => {
  const requests = [evt('ai.requests', 'tr1', 0, { task_id: 'tsk_1' }, 'api-1')];
  const round1 = evt('debate.round.1', 'tr1', 9000, { challenges: [{}, {}, {}], disagreement_score: 0.42 }, 'r1');
  const debate = [
    evt('debate.round.1', 'tr1', 8000, { retry: { agent: 'risk' }, challenges: [], disagreement_score: null }, 'retry-1'),
    round1, { ...round1 }, // the same message delivered twice
    evt('debate.round.2', 'tr1', 14000, { agent: 'matching', vote: { choice: 'switch' } }, 'v1'),
    evt('debate.round.2', 'tr1', 14000, { agent: 'matching', vote: { choice: 'switch' } }, 'v1'), // redelivery
    evt('debate.round.2', 'tr1', 14500, { agent: 'risk', vote: { choice: 'keep' } }, 'v2'),
    evt('ai.results', 'tr1', 20000, { dissent: [] }, 'res'),
    evt('ai.results', 'tr1', 20000, { dissent: [] }, 'res'), // redelivery
    evt('ai.approvals', 'tr1', 60000, { decision: 'edited' }, 'ap'),
    evt('ai.approvals', 'tr1', 60000, { decision: 'edited' }, 'ap'), // redelivery
  ];
  const s = summarizeAi(requests, debate);
  assert.strictEqual(s.challenges, 3);
  assert.strictEqual(s.avg_disagreement, 0.42);
  assert.deepStrictEqual(s.votes, { keep: 1, switch: 1, abstain: 0 });
  assert.deepStrictEqual(s.approvals, { approved: 0, edited: 1, rejected: 0 });
  assert.strictEqual(s.dissent_rate, 0);
});

test('AI summary: no requests in the window gives zeros and nulls, not errors', () => {
  const s = summarizeAi([], [evt('ai.results', 'other', 0, {})]);
  assert.strictEqual(s.tasks, 0);
  assert.strictEqual(s.avg_disagreement, null);
  assert.strictEqual(s.dissent_rate, null);
  assert.strictEqual(s.publication_timeline_ms.verdict, null);
});

test('geo: searches per city, and per state through each city\'s state; "anywhere" searches have no region', () => {
  const { searchesByRegion } = require('../src/models/stats');
  const perCity = [{ _id: 'San Jose', n: 5 }, { _id: 'Oakland', n: 2 }, { _id: null, n: 9 }, { _id: 'Nowhere', n: 1 }];
  const byCity = searchesByRegion(perCity, 'city', new Map());
  assert.deepStrictEqual([...byCity], [['San Jose', 5], ['Oakland', 2], ['Nowhere', 1]]);
  const byState = searchesByRegion(perCity, 'state', new Map([['San Jose', 'CA'], ['Oakland', 'CA']]));
  assert.deepStrictEqual([...byState], [['CA', 7]]); // a city with no listings has no known state
});
