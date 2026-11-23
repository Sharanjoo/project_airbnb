// End-to-end check of Slice 1 auth through the gateway.
//   npm run infra:up, then run gateway, user, user-worker, property, booking and booking-worker
//   (npm run dev:<name>, or docker compose up), then:  npm run smoke:auth
//
// Sign up a host and a guest, log in with real tokens (no hand-signed JWTs),
// create a listing in property-service, request a booking, and check that the
// booking worker wrote a reservation for the new guest. Also checks that a stale
// token does not block login but is still refused on protected routes.
// Phase 2: profile get/update with versioning, and the guest counters kept by
// user-worker from property.saved and (once slice 3 is merged) booking.confirmed.
const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-dev-secret';
const HEALTH = {
  gateway: `${GATEWAY}/health`,
  user: `http://localhost:${process.env.USER_SERVICE_PORT || 8001}/health`,
  property: `http://localhost:${process.env.PROPERTY_SERVICE_PORT || 8002}/health`,
  booking: `http://localhost:${process.env.BOOKING_SERVICE_PORT || 8003}/health`,
};
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS || 60000);

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); process.exitCode = 1; };
const check = (cond, msg, detail) => (cond ? ok(msg) : bad(detail ? `${msg}: ${detail}` : msg));

async function waitFor(url, deadline) {
  let last = 'not checked';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return null;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.cause?.code || e.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last;
}

async function call(service, path, body, { token, headers = {} } = {}) {
  const res = await fetch(`${GATEWAY}/api/v1/${service}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const describe = (r) => `${r.status} ${JSON.stringify(r.body?.error || r.body?.data || r.body)}`;

async function main() {
  console.log('Health checks');
  const deadline = Date.now() + WAIT_MS;
  for (const [name, url] of Object.entries(HEALTH)) {
    const problem = await waitFor(url, deadline);
    check(!problem, `${name} ${url}`, problem);
  }
  if (process.exitCode) return;

  const run = Date.now();
  const password = `Smoke-${randomUUID().slice(0, 8)}`;
  const hostEmail = `smoke-host-${run}@example.com`;
  const guestEmail = `smoke-guest-${run}@example.com`;

  console.log('\nSign-up and login');
  const host = await call('user', '/hosts/create', { name: 'Smoke Host', email: hostEmail, password });
  check(host.status === 201 && /^hst_/.test(host.body?.data?.host_id), `host signed up ${host.body?.data?.host_id}`, describe(host));
  const dup = await call('user', '/hosts/create', { name: 'Again', email: hostEmail.toUpperCase(), password });
  check(dup.status === 409 && dup.body?.error?.code === 'EMAIL_TAKEN', 'duplicate email (different case) -> 409 EMAIL_TAKEN', describe(dup));
  const admin = await call('user', '/hosts/create', { name: 'Sneaky', email: `sneaky-${run}@example.com`, password, access_level: 'admin' });
  check(admin.status === 400, 'sign-up with access_level=admin -> 400', describe(admin));

  const hostLogin = await call('user', '/auth/login', { email: hostEmail, password, role: 'host' });
  const hs = hostLogin.body?.data;
  check(hostLogin.status === 200 && hs?.token && hs.role === 'host' && hs.user_id === host.body?.data?.host_id && hs.expires_at,
    'host login -> { token, expires_at, user_id, role }', describe(hostLogin));

  const guest = await call('user', '/guests/create', { first_name: 'Smoke', last_name: 'Guest', email: guestEmail, password });
  check(guest.status === 201, `guest signed up ${guest.body?.data?.guest_id}`, describe(guest));
  const guestLogin = await call('user', '/auth/login', { email: guestEmail, password });
  const gs = guestLogin.body?.data;
  check(guestLogin.status === 200 && gs?.role === 'guest' && gs.user_id === guest.body?.data?.guest_id, 'guest login', describe(guestLogin));
  const wrong = await call('user', '/auth/login', { email: guestEmail, password: 'not-the-password' });
  check(wrong.status === 401, 'wrong password -> 401', describe(wrong));
  if (process.exitCode) return;

  console.log('\nStale tokens at the gateway');
  const stale = jwt.sign({ sub: gs.user_id, role: 'guest', exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET);
  const relogin = await call('user', '/auth/login', { email: guestEmail, password }, { token: stale });
  check(relogin.status === 200, 'expired token does not block login', describe(relogin));
  const search = await call('property', '/properties/search', { location: { city: 'San Jose' } }, { token: stale });
  check(search.status === 200, 'expired token does not block public search', describe(search));
  const guarded = await call('booking', '/bookings/request', {}, { token: stale, headers: { 'Idempotency-Key': randomUUID() } });
  check(guarded.status === 401, 'expired token is still 401 on a protected route', describe(guarded));

  console.log('\nTokens from login work with the property and booking services');
  const listing = await call('property', '/properties/create', {
    title: 'Smoke test studio', description: 'Created by scripts/smoke-auth.js', property_type: 'apartment',
    address: { line1: '1 Smoke St', city: 'San Jose', state: 'CA', zip: '95113' },
    capacity: 2, bedrooms: 1, bathrooms: 1, amenities: ['wifi'], nightly_price: 99, cleaning_fee: 10,
  }, { token: hs.token });
  const propertyId = listing.body?.data?.property_id;
  check(listing.status === 201 && listing.body.data.host_id === hs.user_id, `new host created listing ${propertyId}`, describe(listing));
  const guestCreates = await call('property', '/properties/create', {}, { token: gs.token });
  check(guestCreates.status === 403, 'guest token cannot create a listing -> 403', describe(guestCreates));
  if (!propertyId) return;

  const start = new Date(Date.now() + (30 + Math.floor(Math.random() * 300)) * 86400000);
  const checkIn = start.toISOString().slice(0, 10);
  const checkOut = new Date(start.getTime() + 2 * 86400000).toISOString().slice(0, 10);
  const booking = await call('booking', '/bookings/request',
    { property_id: propertyId, check_in: checkIn, check_out: checkOut, guest_count: 2, guest_message: 'Hi from the auth smoke test' },
    { token: gs.token, headers: { 'Idempotency-Key': randomUUID() } });
  const reservationId = booking.body?.data?.reservation_id;
  check(booking.status === 202 && reservationId, `new guest requested a booking ${reservationId}`, describe(booking));
  if (!reservationId) return;

  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3307),
    user: process.env.MYSQL_USER || 'airbnb', password: process.env.MYSQL_PASSWORD || 'airbnb', database: process.env.MYSQL_DATABASE || 'airbnb',
  });
  try {
    let row;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      [[row]] = await db.execute('SELECT status, guest_id, host_id FROM reservations WHERE reservation_id = ?', [reservationId]);
      if (row) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    check(row, 'booking worker wrote the reservation', 'not written within 15 s (is booking-worker running?)');
    if (row) {
      check(row.guest_id === gs.user_id && row.host_id === hs.user_id, `reservation ${row.status} links the new guest and host`, JSON.stringify(row));
    }
    const [[g]] = await db.execute('SELECT password_hash FROM guests WHERE guest_id = ?', [gs.user_id]);
    check(g && g.password_hash.startsWith('$2') && !g.password_hash.includes(password), 'password stored as a bcrypt hash');
  } finally {
    await db.end();
  }

  // ---- Profiles (phase 2)
  console.log('\nProfiles');
  const me = await call('user', '/guests/get', { guest_id: gs.user_id }, { token: gs.token });
  check(me.status === 200 && me.body.data.version === 1, 'guest reads own profile', describe(me));
  const other = await call('user', '/guests/get', { guest_id: 'gst_0001' }, { token: gs.token });
  check(other.status === 403, "guest cannot read another guest's profile -> 403", describe(other));
  const upd = await call('user', '/guests/update', { guest_id: gs.user_id, version: 1, location: 'San Jose, CA' }, { token: gs.token });
  check(upd.status === 200 && upd.body.data.version === 2, 'guest updates profile, version 1 -> 2', describe(upd));
  const staleUpdate = await call('user', '/guests/update', { guest_id: gs.user_id, version: 1, location: 'Oakland, CA' }, { token: gs.token });
  check(staleUpdate.status === 409 && staleUpdate.body.error.code === 'VERSION_CONFLICT', 'stale version -> 409 VERSION_CONFLICT', describe(staleUpdate));
  const hostPublic = await call('user', '/hosts/get', { host_id: hs.user_id }, { token: gs.token });
  check(hostPublic.status === 200 && hostPublic.body.data.email === undefined, 'guest sees the public host profile (no email)', describe(hostPublic));

  // ---- Counters through Kafka (needs user-worker: npm run dev:user-worker)
  console.log('\nCounters through Kafka (user-worker)');
  const waitForCount = async (field, want) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < 15000) {
      last = (await call('user', '/guests/get', { guest_id: gs.user_id }, { token: gs.token })).body?.data?.[field];
      if (last === want) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return `still ${last} after 15 s (is user-worker running?)`;
  };
  const save = await call('property', '/properties/save', { property_id: propertyId, saved: true }, { token: gs.token });
  check(save.status === 200 && save.body.data.changed === true, 'guest saved the listing (property.saved published)', describe(save));
  let waited = await waitForCount('saved_properties_count', 1);
  check(waited === true, 'saved_properties_count -> 1', waited);
  await call('property', '/properties/save', { property_id: propertyId, saved: false }, { token: gs.token });
  waited = await waitForCount('saved_properties_count', 0);
  check(waited === true, 'unsave -> saved_properties_count back to 0', waited);

  // approve exists only once slice 3 (booking approve / decline / cancel) is merged
  const approve = await call('booking', '/bookings/approve', { reservation_id: reservationId }, { token: hs.token, headers: { 'Idempotency-Key': randomUUID() } });
  if (approve.status === 501) {
    console.log('  skip  booking_count: /bookings/approve is not implemented on this branch (slice 3 not merged yet)');
  } else {
    check(approve.status === 202 || approve.status === 200, 'host approved the booking (booking.confirmed published)', describe(approve));
    waited = await waitForCount('booking_count', 1);
    check(waited === true, 'booking_count -> 1', waited);

    // booking_count is a lifetime count of confirmed reservations: cancelling must not lower it.
    const cancel = await call('booking', '/bookings/cancel', { reservation_id: reservationId, cancellation_reason: 'Smoke test cleanup' },
      { token: hs.token, headers: { 'Idempotency-Key': randomUUID() } });
    check(cancel.status === 202 || cancel.status === 200, 'host cancelled the confirmed booking (booking.cancelled published)', describe(cancel));
    let status;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      status = (await call('booking', '/bookings/get', { reservation_id: reservationId }, { token: hs.token })).body?.data?.status;
      if (status === 'CANCELLED') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    check(status === 'CANCELLED', 'reservation is CANCELLED', `still ${status}`);
    await new Promise((r) => setTimeout(r, 3000)); // give user-worker time to (wrongly) react, if it ever did
    const after = (await call('user', '/guests/get', { guest_id: gs.user_id }, { token: gs.token })).body?.data?.booking_count;
    check(after === 1, 'booking_count still 1 after the cancellation (lifetime count)', `now ${after}`);
  }

  // Tidy up: pause the test listing so it does not show up in demo searches (13.8 / 13.9).
  const pause = await call('property', '/properties/update',
    { property_id: propertyId, version: listing.body.data.version, status: 'inactive' }, { token: hs.token });
  check(pause.status === 200 && pause.body.data.status === 'inactive', 'test listing set to inactive', describe(pause));
}

main().catch((e) => bad(e.stack || e.message));
