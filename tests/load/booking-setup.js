// Test data for the booking load test (experiment 2) and the Kafka scaling test (4).
//
//   node tests/load/booking-setup.js --guests 100     create load-test guests, tokens and a property list
//   node tests/load/booking-setup.js --cleanup        delete everything the booking load tests created
//
// Guests are gst_lt_001... with the same password hash as the seed guest, so the
// gateway's account check and the booking rules treat them like real users.
// Writes (git-ignored): results/booking-tokens.tsv (one JWT per line, valid 3 h)
// and results/booking-properties.tsv (active listings to book).
// Local/dev databases only.
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { getMysql, getMongo } = require('@airbnb/common');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const GUESTS = Number(arg('guests', 100));
const PROPERTIES = Number(arg('properties', 2000));
const PREFIX = 'gst_lt_';
const OUT = path.join(__dirname, 'results');

async function cleanup(sql) {
  const like = `${PREFIX}%`;
  const [res] = await sql.query('SELECT COUNT(*) AS n FROM reservations WHERE guest_id LIKE ?', [like]);
  // the worker's processed_events rows: keyed by the request's Idempotency-Key, reservation id = res_<key without dashes>
  await sql.query(
    `DELETE p FROM processed_events p JOIN reservations r ON r.reservation_id = CONCAT('res_', REPLACE(LEFT(p.idempotency_key, 36), '-', ''))
     WHERE r.guest_id LIKE ?`, [like]);
  await sql.query('DELETE h FROM reservation_status_history h JOIN reservations r ON r.reservation_id = h.reservation_id WHERE r.guest_id LIKE ?', [like]);
  await sql.query('DELETE FROM reservations WHERE guest_id LIKE ?', [like]); // reservation_nights cascade
  await sql.query('DELETE FROM idempotency_keys WHERE actor_id LIKE ?', [like]);
  await sql.query('DELETE FROM saved_properties WHERE guest_id LIKE ?', [like]);
  const [g] = await sql.query('DELETE FROM guests WHERE guest_id LIKE ?', [like]);
  const db = await getMongo();
  const re = new RegExp(`^${PREFIX}`);
  const threads = await db.collection('threads').find({ guest_id: re }, { projection: { _id: 1 } }).toArray();
  const msgs = await db.collection('messages').deleteMany({ thread_id: { $in: threads.map((t) => t._id) } });
  const th = await db.collection('threads').deleteMany({ guest_id: re });
  // AI tasks from the AI timing test (ai-timings.js) and their debate records
  const tasks = await db.collection('ai_tasks').find({ user_id: re }, { projection: { trace_id: 1 } }).toArray();
  const traces = tasks.map((t) => t.trace_id);
  await db.collection('debate_messages').deleteMany({ trace_id: { $in: traces } });
  await db.collection('feedback').deleteMany({ trace_id: { $in: traces } });
  const ai = await db.collection('ai_tasks').deleteMany({ user_id: re });
  const ev = await db.collection('events').deleteMany({ $or: [{ actor_id: re }, { 'payload.guest_id': re }, { 'payload.user_id': re }, { trace_id: { $in: traces } }] });
  console.log(`cleanup: ${res[0].n} reservations, ${g.affectedRows} guests, ${th.deletedCount} threads, ${msgs.deletedCount} messages, ${ev.deletedCount} events, ${ai.deletedCount} AI tasks`);
}

async function setup(sql) {
  await cleanup(sql);
  const [[seed]] = await sql.query("SELECT password_hash FROM guests WHERE guest_id = 'gst_0001'");
  if (!seed) throw new Error('seed guest gst_0001 not found');
  const ids = Array.from({ length: GUESTS }, (_, i) => `${PREFIX}${String(i + 1).padStart(3, '0')}`);
  await sql.query('INSERT INTO guests (guest_id, first_name, last_name, email, password_hash) VALUES ?',
    [ids.map((id, i) => [id, 'Load', `Guest${i + 1}`, `${id}@loadtest.invalid`, seed.password_hash])]);

  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set (source .env first)');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'booking-tokens.tsv'),
    `${ids.map((id) => jwt.sign({ sub: id, role: 'guest' }, secret, { algorithm: 'HS256', expiresIn: '3h' })).join('\n')}\n`);

  const [props] = await sql.query("SELECT property_id FROM properties WHERE status = 'active' ORDER BY RAND(42) LIMIT ?", [PROPERTIES]);
  fs.writeFileSync(path.join(OUT, 'booking-properties.tsv'), `${props.map((p) => p.property_id).join('\n')}\n`);
  console.log(`setup: ${ids.length} guests with tokens, ${props.length} properties`);
}

(async () => {
  const sql = getMysql();
  try {
    if (args.includes('--cleanup')) await cleanup(sql);
    else await setup(sql);
  } finally {
    await sql.end();
    await getMongo().then((db) => db.client.close()).catch(() => {});
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
