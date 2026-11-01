// End-to-end smoke test of the walking skeleton.
//   docker compose up -d --build      (or infra:up + the dev:* services)
//   node scripts/smoke.js
// Checks every service's /health, then sends one booking through
// gateway -> Booking API -> Kafka -> Booking Worker -> MySQL and polls for the result.
const { randomUUID } = require('crypto');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-dev-secret';
const HEALTH = {
  gateway: 8080, user: 8001, property: 8002, booking: 8003, messaging: 8004,
  review: 8005, analytics: 8006, ai: 8007, notify: 8009,
};

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); process.exitCode = 1; };

async function main() {
  console.log('Health checks');
  for (const [name, port] of Object.entries(HEALTH)) {
    try {
      const r = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
      r.ok ? ok(`${name} :${port}`) : bad(`${name} :${port} -> ${r.status}`);
    } catch (e) {
      bad(`${name} :${port} not reachable (${e.cause?.code || e.message})`);
    }
  }

  console.log('\nBooking through Kafka');
  const token = jwt.sign({ sub: 'gst_0001', role: 'guest' }, JWT_SECRET, { expiresIn: '10m' });
  const start = new Date(Date.now() + (60 + Math.floor(Math.random() * 300)) * 86400000);
  const checkIn = start.toISOString().slice(0, 10);
  const checkOut = new Date(start.getTime() + 2 * 86400000).toISOString().slice(0, 10);
  const traceId = randomUUID();

  const res = await fetch(`${GATEWAY}/api/v1/booking/bookings/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
      'Idempotency-Key': randomUUID(), 'X-Trace-Id': traceId,
    },
    body: JSON.stringify({ property_id: 'prp_0001', check_in: checkIn, check_out: checkOut, guest_count: 2 }),
  });
  const body = await res.json();
  if (res.status !== 202) return bad(`request -> ${res.status} ${JSON.stringify(body)}`);
  ok(`202 PENDING ${body.data.reservation_id}  trace_id=${traceId}`);

  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || 'localhost', port: Number(process.env.MYSQL_PORT || 3307),
    user: 'airbnb', password: 'airbnb', database: 'airbnb',
  });
  const t0 = Date.now();
  let row;
  while (Date.now() - t0 < 15000) {
    [[row]] = await db.execute('SELECT status, trace_id FROM reservations WHERE reservation_id = ?', [body.data.reservation_id]);
    if (row) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await db.end();
  if (!row) return bad('worker did not write the reservation within 15 s (is booking-worker running?)');
  ok(`worker wrote status ${row.status} in ${Date.now() - t0} ms`);
  row.trace_id === traceId ? ok('trace_id preserved API -> Kafka -> MySQL') : bad('trace_id changed on the way');
}

main().catch((e) => { bad(e.message); });
