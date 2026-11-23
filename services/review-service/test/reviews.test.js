process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const { createApp, logger, validateEnvelope } = require('@airbnb/common');
const { buildRouter } = require('../src/routes');
const { toApi } = require('../src/models/review');

// ---------------------------------------------------------------- fakes
// In-memory repo with the same interface as src/models/review.js.
function fakeRepo({ reservations = [], mongoDown = false } = {}) {
  const resv = new Map(reservations.map((x) => [x.reservation_id, x]));
  const docs = new Map(); // review_id -> doc
  const down = () => { if (mongoDown) throw new Error('mongo down'); };
  return {
    docs,
    toApi,
    async findReservation(id) { return resv.get(id) || null; },
    async insert(doc) {
      down();
      const existing = [...docs.values()].find((d) => d.reservation_id === doc.reservation_id);
      if (existing) return { inserted: false, existing: { ...existing } };
      docs.set(doc.review_id, { ...doc });
      return { inserted: true };
    },
    async markPublished(id, field = 'event_published') { docs.get(id)[field] = true; },
    async findById(id) { down(); return docs.has(id) ? { ...docs.get(id) } : null; },
    async listByProperty(pid, { page, pageSize }) {
      const all = [...docs.values()].filter((d) => d.property_id === pid)
        .sort((a, b) => b.created_datetime.localeCompare(a.created_datetime));
      const avg = all.length ? Math.round((all.reduce((s, d) => s + d.rating, 0) / all.length) * 100) / 100 : null;
      return { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, average_rating: avg };
    },
    async setResponse(id, response) {
      const d = docs.get(id);
      if (!d || d.host_response) return null;
      d.host_response = response;
      return { ...d };
    },
    async guestNames(ids) { return new Map(ids.map((id) => [id, 'Ana G.'])); },
    async propertyExists(pid) { return pid === 'prp_1' ? 'active' : null; },
  };
}

function fakeBus({ fail = false } = {}) {
  const sent = [];
  const bus = {
    sent,
    fail,
    publish: async (topic, env, key) => {
      if (bus.fail) throw new Error('broker down');
      const check = validateEnvelope(env, topic);
      if (!check.valid) throw new Error(check.errors.join('; '));
      sent.push({ topic, env, key });
    },
  };
  return bus;
}

async function start(deps) {
  const app = createApp({ name: 'review-test', logger });
  app.use(buildRouter(deps));
  app.finalize();
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const GUEST = { 'X-User-Id': 'gst_1', 'X-User-Role': 'guest' };
const OTHER_GUEST = { 'X-User-Id': 'gst_2', 'X-User-Role': 'guest' };
const HOST = { 'X-User-Id': 'hst_1', 'X-User-Role': 'host' };
const OTHER_HOST = { 'X-User-Id': 'hst_2', 'X-User-Role': 'host' };

const call = async (base, path, body, headers = {}) => {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const RESERVATIONS = [
  { reservation_id: 'res_done', property_id: 'prp_1', guest_id: 'gst_1', host_id: 'hst_1', status: 'COMPLETED' },
  { reservation_id: 'res_done2', property_id: 'prp_1', guest_id: 'gst_2', host_id: 'hst_1', status: 'COMPLETED' },
  { reservation_id: 'res_upcoming', property_id: 'prp_1', guest_id: 'gst_1', host_id: 'hst_1', status: 'CONFIRMED' },
];

const review = (over = {}) => ({
  reservation_id: 'res_done',
  rating: 4,
  review_text: 'Lovely place, quiet street and a great kitchen.',
  sub_ratings: { cleanliness: 5, accuracy: 4, communication: 5, location: 4, value: 4 },
  ...over,
});

async function withService(opts, fn) {
  const repo = fakeRepo({ reservations: RESERVATIONS, ...opts.repo });
  const bus = fakeBus(opts.bus);
  const { server, base } = await start({ repo, bus });
  try {
    await fn({ base, repo, bus });
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------- create
test('create: guest reviews a completed stay -> 201, stored with property_id + rating, review.created published', () =>
  withService({}, async ({ base, repo, bus }) => {
    const { status, body } = await call(base, '/reviews/create', review(), { ...GUEST, 'X-Trace-Id': '7d3f8a2e-4b1c-4e9a-9f6d-2c8b1a0e5f37' });
    assert.strictEqual(status, 201);
    assert.match(body.data.review_id, /^rev_/);
    assert.strictEqual(body.data.property_id, 'prp_1');
    assert.strictEqual(body.data.rating, 4);
    assert.strictEqual(body.data.host_response, null);
    assert.strictEqual('_id' in body.data, false);

    const stored = repo.docs.get(body.data.review_id);
    assert.strictEqual(stored.property_id, 'prp_1');
    assert.strictEqual(stored.host_id, 'hst_1');
    assert.strictEqual(stored.rating, 4);
    assert.strictEqual(stored.event_published, true);

    assert.strictEqual(bus.sent.length, 1);
    const { topic, env, key } = bus.sent[0];
    assert.strictEqual(topic, 'review.created');
    assert.strictEqual(key, 'prp_1');
    assert.strictEqual(env.trace_id, '7d3f8a2e-4b1c-4e9a-9f6d-2c8b1a0e5f37');
    assert.strictEqual(env.actor_id, 'gst_1');
    assert.deepStrictEqual(env.payload, {
      review_id: body.data.review_id, reservation_id: 'res_done', property_id: 'prp_1', host_id: 'hst_1', guest_id: 'gst_1', rating: 4,
    });
  }));

test('create: second review of the same stay -> 409 ALREADY_REVIEWED, nothing new published', () =>
  withService({}, async ({ base, bus }) => {
    await call(base, '/reviews/create', review(), GUEST);
    const { status, body } = await call(base, '/reviews/create', review({ rating: 1 }), GUEST);
    assert.strictEqual(status, 409);
    assert.strictEqual(body.error.code, 'ALREADY_REVIEWED');
    assert.strictEqual(bus.sent.length, 1);
  }));

test('create: stay not completed yet -> 422', () =>
  withService({}, async ({ base, bus }) => {
    const { status, body } = await call(base, '/reviews/create', review({ reservation_id: 'res_upcoming' }), GUEST);
    assert.strictEqual(status, 422);
    assert.strictEqual(body.error.code, 'BUSINESS_RULE_VIOLATION');
    assert.strictEqual(bus.sent.length, 0);
  }));

test('create: someone else\'s stay or unknown id -> 404 (same answer)', () =>
  withService({}, async ({ base }) => {
    const other = await call(base, '/reviews/create', review(), OTHER_GUEST);
    const unknown = await call(base, '/reviews/create', review({ reservation_id: 'res_nope' }), GUEST);
    assert.strictEqual(other.status, 404);
    assert.strictEqual(unknown.status, 404);
    assert.strictEqual(other.body.error.message, unknown.body.error.message);
  }));

test('create: validation and roles', () =>
  withService({}, async ({ base }) => {
    const short = await call(base, '/reviews/create', review({ review_text: 'too short' }), GUEST);
    assert.strictEqual(short.status, 400);
    assert.strictEqual(short.body.error.details[0].field, 'review_text');
    const badRating = await call(base, '/reviews/create', review({ rating: 6 }), GUEST);
    assert.strictEqual(badRating.status, 400);
    const extra = await call(base, '/reviews/create', review({ property_id: 'prp_9' }), GUEST);
    assert.strictEqual(extra.status, 400);
    const host = await call(base, '/reviews/create', review(), HOST);
    assert.strictEqual(host.status, 403);
    const anon = await call(base, '/reviews/create', review());
    assert.strictEqual(anon.status, 401);
  }));

test('create: Kafka down -> 503 retryable; the retry publishes the saved review without a duplicate', () =>
  withService({ bus: { fail: true } }, async ({ base, repo, bus }) => {
    const first = await call(base, '/reviews/create', review(), GUEST);
    assert.strictEqual(first.status, 503);
    assert.strictEqual(first.body.error.retryable, true);
    assert.strictEqual(repo.docs.size, 1);

    bus.fail = false;
    const retry = await call(base, '/reviews/create', review(), GUEST);
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(repo.docs.size, 1);
    assert.strictEqual(bus.sent.length, 1);
    assert.strictEqual(bus.sent[0].env.payload.review_id, retry.body.data.review_id);

    const again = await call(base, '/reviews/create', review(), GUEST);
    assert.strictEqual(again.status, 409);
  }));

test('create: MongoDB down -> 503 DEPENDENCY_UNAVAILABLE', () =>
  withService({ repo: { mongoDown: true } }, async ({ base }) => {
    const { status, body } = await call(base, '/reviews/create', review(), GUEST);
    assert.strictEqual(status, 503);
    assert.strictEqual(body.error.code, 'DEPENDENCY_UNAVAILABLE');
  }));

// ---------------------------------------------------------------- get / byProperty
test('get: public, hides guest_id and reservation_id; unknown -> 404', () =>
  withService({}, async ({ base }) => {
    const created = await call(base, '/reviews/create', review(), GUEST);
    const { status, body } = await call(base, '/reviews/get', { review_id: created.body.data.review_id });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.rating, 4);
    assert.strictEqual(body.data.guest_name, 'Ana G.');
    assert.strictEqual('guest_id' in body.data, false);
    assert.strictEqual('reservation_id' in body.data, false);
    assert.strictEqual('event_published' in body.data, false);

    const missing = await call(base, '/reviews/get', { review_id: 'rev_nope' });
    assert.strictEqual(missing.status, 404);
  }));

test('byProperty: newest first, paged, with average; unknown property -> 404', () =>
  withService({}, async ({ base }) => {
    await call(base, '/reviews/create', review({ rating: 5 }), GUEST);
    await new Promise((r) => setTimeout(r, 5));
    await call(base, '/reviews/create', review({ reservation_id: 'res_done2', rating: 2 }), OTHER_GUEST);

    const { status, body } = await call(base, '/reviews/byProperty', { property_id: 'prp_1', page_size: 1 });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.total, 2);
    assert.strictEqual(body.data.page, 1);
    assert.strictEqual(body.data.page_size, 1);
    assert.strictEqual(body.data.average_rating, 3.5);
    assert.strictEqual(body.data.items.length, 1);
    assert.strictEqual(body.data.items[0].rating, 2); // newest
    assert.strictEqual('guest_id' in body.data.items[0], false);

    const page2 = await call(base, '/reviews/byProperty', { property_id: 'prp_1', page: 2, page_size: 1 });
    assert.strictEqual(page2.body.data.items[0].rating, 5);

    const unknown = await call(base, '/reviews/byProperty', { property_id: 'prp_nope' });
    assert.strictEqual(unknown.status, 404);
    const tooBig = await call(base, '/reviews/byProperty', { property_id: 'prp_1', page_size: 51 });
    assert.strictEqual(tooBig.status, 400);
  }));

// ---------------------------------------------------------------- respond
test('respond: listing host answers once -> 200, review.responded published', () =>
  withService({}, async ({ base, bus }) => {
    const created = await call(base, '/reviews/create', review(), GUEST);
    const id = created.body.data.review_id;
    const { status, body } = await call(base, '/reviews/respond', { review_id: id, response_text: 'Thanks for staying!' }, HOST);
    assert.strictEqual(status, 200);
    assert.strictEqual(body.data.host_response.response_text, 'Thanks for staying!');
    assert.ok(body.data.host_response.responded_at.endsWith('Z'));
    const ev = bus.sent.find((s) => s.topic === 'review.responded');
    assert.ok(ev);
    assert.strictEqual(ev.env.actor_type, 'host');
    assert.strictEqual(ev.env.payload.guest_id, 'gst_1');

    const twice = await call(base, '/reviews/respond', { review_id: id, response_text: 'Again' }, HOST);
    assert.strictEqual(twice.status, 409);
    assert.strictEqual(twice.body.error.code, 'ALREADY_RESPONDED');
  }));

test('respond: another host -> 403, guest -> 403, unknown review -> 404, empty text -> 400', () =>
  withService({}, async ({ base }) => {
    const created = await call(base, '/reviews/create', review(), GUEST);
    const id = created.body.data.review_id;
    assert.strictEqual((await call(base, '/reviews/respond', { review_id: id, response_text: 'Hi' }, OTHER_HOST)).status, 403);
    assert.strictEqual((await call(base, '/reviews/respond', { review_id: id, response_text: 'Hi' }, GUEST)).status, 403);
    assert.strictEqual((await call(base, '/reviews/respond', { review_id: 'rev_nope', response_text: 'Hi' }, HOST)).status, 404);
    assert.strictEqual((await call(base, '/reviews/respond', { review_id: id, response_text: '   ' }, HOST)).status, 400);
  }));

test('respond: Kafka down still saves the answer -> 200', () =>
  withService({}, async ({ base, bus, repo }) => {
    const created = await call(base, '/reviews/create', review(), GUEST);
    bus.fail = true;
    const { status } = await call(base, '/reviews/respond', { review_id: created.body.data.review_id, response_text: 'Thank you!' }, HOST);
    assert.strictEqual(status, 200);
    assert.strictEqual(repo.docs.get(created.body.data.review_id).host_response.response_text, 'Thank you!');
  }));
