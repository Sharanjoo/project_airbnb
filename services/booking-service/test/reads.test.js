process.env.NODE_ENV = 'test';
// /bookings/get, /bookings/byProperty, /bookings/byGuest (API doc §5, §13.3).
const test = require('node:test');
const assert = require('node:assert');
const { createApp, logger } = require('@airbnb/common');
const { buildRouter } = require('../src/routes');

const RESERVATION = {
  reservation_id: 'res_51a', property_id: 'prp_0001', guest_id: 'gst_0001', host_id: 'hst_0001',
  check_in: '2026-11-14', check_out: '2026-11-16', guest_count: 2,
  price_breakdown: { nights: 2, total: 509.96, currency: 'USD' },
  total_price: '509.96', booking_datetime: '2026-10-27 15:10:02.000', status: 'CONFIRMED',
  cancellation_reason: null, guest_message: 'Arriving around 6pm.',
};

function fakeRepo(overrides = {}) {
  const calls = {};
  return {
    calls,
    toIso: (dt) => (dt ? `${String(dt).replace(' ', 'T')}Z` : null),
    findReservation: async (id) => (id === 'res_51a' ? RESERVATION : null),
    listStatusHistory: async () => [
      { from_status: null, to_status: 'REQUESTED', actor_id: 'svc:booking-worker', reason: null, at: '2026-10-27T15:10:02.000Z' },
      { from_status: 'REQUESTED', to_status: 'CONFIRMED', actor_id: 'hst_0001', reason: null, at: '2026-10-27T17:45:10.000Z' },
    ],
    findPendingReservation: async (id) => (id === 'res_pending' ? { reservation_id: id, status: 'PENDING' } : null),
    findPropertyOwner: async (id) => (id === 'prp_0001' ? { property_id: id, host_id: 'hst_0001' } : null),
    listByProperty: async (o) => {
      calls.listByProperty = o;
      return {
        total: 1,
        rows: [{ reservation_id: 'res_51a', guest_id: 'gst_0001', check_in: '2026-11-14', check_out: '2026-11-16', guest_count: 2, total_price: '509.96', status: 'REQUESTED', booking_datetime: '2026-10-27 15:10:02.000' }],
      };
    },
    listByGuest: async (o) => {
      calls.listByGuest = o;
      return {
        total: 2,
        rows: [
          { reservation_id: 'res_51a', property_id: 'prp_0001', check_in: '2026-11-14', check_out: '2026-11-16', total_price: '509.96', status: 'CONFIRMED', booking_datetime: '2026-10-27 15:10:02.000' },
          { reservation_id: 'res_0c7', property_id: 'prp_0002', check_in: '2026-09-05', check_out: '2026-09-07', total_price: '615.24', status: 'COMPLETED', booking_datetime: '2026-08-01 10:00:00.000' },
        ],
      };
    },
    reviewedReservationIds: async () => new Set(),
    ...overrides,
  };
}

async function start(repo) {
  const app = createApp({ name: 'booking-test', logger });
  app.use(buildRouter({ bus: { publish: async () => {} }, repo }));
  app.finalize();
  const server = app.listen(0);
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const call = (base, path, body, user = { id: 'gst_0001', role: 'guest' }) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': user.id, 'X-User-Role': user.role },
    body: JSON.stringify(body),
  });

const HOST = { id: 'hst_0001', role: 'host' };

// ------------------------------------------------------------------ /bookings/get

test('get: the guest on the booking sees the reservation with status_history', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    const res = await call(base, '/bookings/get', { reservation_id: 'res_51a' });
    assert.strictEqual(res.status, 200);
    const { data, trace_id } = await res.json();
    assert.ok(trace_id);
    assert.strictEqual(data.status, 'CONFIRMED');
    assert.strictEqual(data.booking_datetime, '2026-10-27T15:10:02.000Z');
    assert.strictEqual(data.price_breakdown.total, 509.96);
    assert.strictEqual(data.status_history.length, 2);
    assert.strictEqual(data.status_history[1].to_status, 'CONFIRMED');
  } finally { server.close(); }
});

test('get: the host of the booking can read it', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    assert.strictEqual((await call(base, '/bookings/get', { reservation_id: 'res_51a' }, HOST)).status, 200);
  } finally { server.close(); }
});

test('get: another guest -> 403', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    const res = await call(base, '/bookings/get', { reservation_id: 'res_51a' }, { id: 'gst_0002', role: 'guest' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).error.code, 'FORBIDDEN');
  } finally { server.close(); }
});

test('get: a host who does not own the booking -> 403', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    assert.strictEqual((await call(base, '/bookings/get', { reservation_id: 'res_51a' }, { id: 'hst_0002', role: 'host' })).status, 403);
  } finally { server.close(); }
});

test('get: unknown reservation -> 404', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    const res = await call(base, '/bookings/get', { reservation_id: 'res_nope' });
    assert.strictEqual(res.status, 404);
    assert.strictEqual((await res.json()).error.code, 'NOT_FOUND');
  } finally { server.close(); }
});

test('get: accepted but not yet written by the worker -> 200 PENDING', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    const res = await call(base, '/bookings/get', { reservation_id: 'res_pending' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual((await res.json()).data, { reservation_id: 'res_pending', status: 'PENDING' });
  } finally { server.close(); }
});

test('get: missing reservation_id and unknown fields -> 400', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    assert.strictEqual((await call(base, '/bookings/get', {})).status, 400);
    assert.strictEqual((await call(base, '/bookings/get', { reservation_id: 'res_51a', extra: 1 })).status, 400);
  } finally { server.close(); }
});

// ------------------------------------------------------------------ /bookings/byProperty

test('byProperty: owning host gets a page with defaults page=1 page_size=20', async () => {
  const repo = fakeRepo();
  const { server, base } = await start(repo);
  try {
    const res = await call(base, '/bookings/byProperty', { property_id: 'prp_0001', status: ['REQUESTED'], from: '2026-11-01', to: '2026-12-31' }, HOST);
    assert.strictEqual(res.status, 200);
    const { data } = await res.json();
    assert.deepStrictEqual({ page: data.page, page_size: data.page_size, total: data.total }, { page: 1, page_size: 20, total: 1 });
    assert.strictEqual(data.items[0].total, 509.96);
    assert.strictEqual(data.items[0].booking_datetime, '2026-10-27T15:10:02.000Z');
    assert.deepStrictEqual(repo.calls.listByProperty.statuses, ['REQUESTED']);
    assert.strictEqual(repo.calls.listByProperty.from, '2026-11-01');
  } finally { server.close(); }
});

test('byProperty: a host who does not own the property -> 403', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    assert.strictEqual((await call(base, '/bookings/byProperty', { property_id: 'prp_0001' }, { id: 'hst_0002', role: 'host' })).status, 403);
  } finally { server.close(); }
});

test('byProperty: unknown property -> 404; guest role -> 403', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    assert.strictEqual((await call(base, '/bookings/byProperty', { property_id: 'prp_nope' }, HOST)).status, 404);
    assert.strictEqual((await call(base, '/bookings/byProperty', { property_id: 'prp_0001' })).status, 403);
  } finally { server.close(); }
});

test('byProperty: bad status, page_size over 100, and to before from -> 400', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    assert.strictEqual((await call(base, '/bookings/byProperty', { property_id: 'prp_0001', status: ['NOPE'] }, HOST)).status, 400);
    assert.strictEqual((await call(base, '/bookings/byProperty', { property_id: 'prp_0001', page_size: 101 }, HOST)).status, 400);
    assert.strictEqual((await call(base, '/bookings/byProperty', { property_id: 'prp_0001', from: '2026-12-01', to: '2026-11-01' }, HOST)).status, 400);
  } finally { server.close(); }
});

// ------------------------------------------------------------------ /bookings/byGuest

test('byGuest: self sees own stays; review_due only on COMPLETED stays without a review', async () => {
  const repo = fakeRepo();
  const { server, base } = await start(repo);
  try {
    const res = await call(base, '/bookings/byGuest', { guest_id: 'gst_0001', status: ['CONFIRMED', 'COMPLETED'] });
    assert.strictEqual(res.status, 200);
    const { data } = await res.json();
    assert.strictEqual(data.total, 2);
    assert.strictEqual('review_due' in data.items[0], false);
    assert.strictEqual(data.items[1].review_due, true);
    assert.strictEqual(repo.calls.listByGuest.guestId, 'gst_0001');
  } finally { server.close(); }
});

test('byGuest: a completed stay that already has a review is not due', async () => {
  const { server, base } = await start(fakeRepo({ reviewedReservationIds: async () => new Set(['res_0c7']) }));
  try {
    const { data } = await (await call(base, '/bookings/byGuest', { guest_id: 'gst_0001' })).json();
    assert.strictEqual(data.items[1].review_due, false);
  } finally { server.close(); }
});

test('byGuest: asking for another guest -> 403; host role -> 403', async () => {
  const { server, base } = await start(fakeRepo());
  try {
    assert.strictEqual((await call(base, '/bookings/byGuest', { guest_id: 'gst_0002' })).status, 403);
    assert.strictEqual((await call(base, '/bookings/byGuest', { guest_id: 'gst_0001' }, HOST)).status, 403);
  } finally { server.close(); }
});
