// End-to-end check of Slice 5 (AI debate) through the gateway.
//   docker compose up -d --build && npm run gen:properties, then:  npm run smoke:ai
//   npm run smoke:ai -- --timeout   also stops the risk agent for one debate (needs docker compose; takes about 20 s)
//
// Real sign-ups, real Kafka, MongoDB and WebSocket. Checks: the live stream, replay and access
// rules, three concurrent debates without mixing, the Kafka envelope and key on every AI topic,
// the dead-letter topic, approval without double publishing, and the last availability check
// (a second guest books the winner's dates, the first asks again, and the booking is cancelled).
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const { createKafka, validateEnvelope } = require('@airbnb/common');

const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
const WITH_TIMEOUT = process.argv.includes('--timeout');
const TOPICS = ['ai.requests', 'debate.round.0', 'debate.round.1', 'debate.round.2', 'ai.results', 'ai.approvals', 'debate.round.0.dlq'];

const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); process.exitCode = 1; };
const check = (cond, msg, detail) => (cond ? ok(msg) : bad(detail === undefined ? msg : `${msg}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

async function call(service, path, body, { token, method = 'POST', headers = {} } = {}) {
  const res = await fetch(`${GATEWAY}/api/v1/${service}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json?.data, error: json?.error };
}

/** Follow a task until the server closes the stream. */
function stream(taskId, token, after = 0) {
  return new Promise((resolve) => {
    const frames = [];
    const ws = new WebSocket(`${GATEWAY.replace(/^http/, 'ws')}/api/v1/ai/ai/tasks/${taskId}/stream?token=${encodeURIComponent(token || '')}&after=${after}`);
    const timer = setTimeout(() => ws.close(), 60000);
    ws.onmessage = (e) => frames.push(JSON.parse(e.data));
    ws.onclose = (e) => { clearTimeout(timer); resolve({ frames, code: e.code }); };
    ws.onerror = () => {};
  });
}

async function signUp(name) {
  const email = `smoke-ai-${name}-${Date.now()}@example.com`;
  const password = `Smoke-${randomUUID().slice(0, 8)}`;
  await call('user', '/guests/create', { first_name: 'Smoke', last_name: name, email, password });
  const r = await call('user', '/auth/login', { email, password, role: 'guest' });
  if (!r.data?.token) throw new Error(`login failed: ${JSON.stringify(r)}`);
  return { ...r.data, token: r.data.token };
}

async function debate(user, body) {
  const created = await call('ai', '/ai/requests', body, { token: user.token });
  if (created.status !== 202) throw new Error(`POST /ai/requests: ${JSON.stringify(created)}`);
  const live = await stream(created.data.task_id, user.token);
  const result = live.frames.find((f) => f.type === 'verdict');
  return { ...created.data, ...live, result };
}

async function main() {
  console.log('Health');
  const healthy = await until(() => fetch(`${GATEWAY}/health`).then((r) => r.ok, () => false), 60000);
  check(healthy, 'gateway is up');
  if (!healthy) return;

  // Watch every AI topic from now on.
  const kafka = createKafka('smoke-ai');
  const consumer = kafka.consumer({ groupId: `smoke-ai-${randomUUID()}` });
  const producer = kafka.producer();
  const seen = [];
  await consumer.connect();
  await producer.connect();
  await consumer.subscribe({ topics: TOPICS, fromBeginning: false });
  const joined = new Promise((r) => consumer.on(consumer.events.GROUP_JOIN, r));
  await consumer.run({ eachMessage: async ({ topic, message }) => {
    seen.push({ topic, key: message.key?.toString(), raw: message.value.toString(), headers: message.headers });
  } });
  await joined;
  await sleep(1500);

  try {
    const guest = await signUp('a');
    const other = await signUp('b');

    console.log('\nOne debate');
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const start = 250 + Math.floor(Math.random() * 60);
    const ask = { request_text: 'A stay in San Jose for two people, under $250 per night, with a kitchen', check_in: day(start), check_out: day(start + 2) };
    const one = await debate(guest, ask);
    check(one.code === 1000 && !!one.result, 'stream ends with a verdict', { code: one.code, types: one.frames.map((f) => f.type) });
    if (!one.result) return;
    const types = new Set(one.frames.map((f) => f.type));
    check(['status', 'plan.created', 'parser.completed', 'agent.published', 'challenge.issued', 'vote.cast', 'verdict'].every((t) => types.has(t)), 'every kind of frame arrived');
    check(one.frames.every((f, i) => f.seq === i + 1 && f.trace_id === one.trace_id), 'frames are in order and belong to this trace');
    check(one.result.availability === 'verified', 'the Chair checked the winner with property-service', one.result.limitations);
    const replay = await stream(one.task_id, guest.token, 5);
    check(replay.frames[0]?.seq === 6 && replay.frames.length === one.frames.length - 5, 'reconnect with after=5 gets only what was missed');

    console.log('\nAccess');
    check((await stream(one.task_id, '')).code === 4401, 'stream without a token -> 4401');
    check((await stream(one.task_id, other.token)).code === 4403, "another user's task -> 4403");
    check((await stream('tsk_none', guest.token)).code === 4404, 'unknown task -> 4404');
    check((await call('ai', `/ai/results/${one.task_id}`, null, { token: other.token, method: 'GET' })).status === 403, "another user's result -> 403");

    console.log('\nThree debates at once');
    const cities = ['Napa', 'Oakland', 'Monterey'];
    const three = await Promise.all(cities.map((c) => debate(other, { request_text: `A stay in ${c} for two people` })));
    check(new Set(three.map((t) => t.trace_id)).size === 3, 'three separate traces');
    three.forEach((t, i) => check(t.result?.parsed_request.city === cities[i] && t.frames.every((f) => f.trace_id === t.trace_id), `${cities[i]}: own request, own frames only`));

    console.log('\nKafka');
    const mine = (topic) => seen.filter((m) => m.topic === topic && m.raw.includes(one.trace_id));
    await until(() => mine('ai.results').length);
    for (const topic of ['ai.requests', 'debate.round.0', 'debate.round.1', 'debate.round.2', 'ai.results']) {
      const list = mine(topic);
      const problems = list.flatMap((m) => {
        const env = JSON.parse(m.raw);
        const v = validateEnvelope(env, topic);
        return [...(v.valid ? [] : [v.errors || v]), ...(m.key === one.trace_id && env.trace_id === one.trace_id ? [] : ['wrong key or trace'])];
      });
      check(list.length && !problems.length, `${topic}: ${list.length} message(s), valid envelope, key = trace_id`, problems);
    }
    const junk = `not json ${randomUUID()}`;
    await producer.send({ topic: 'debate.round.0', messages: [{ key: 'smoke', value: junk }] });
    const dead = await until(() => seen.find((m) => m.topic === 'debate.round.0.dlq' && m.raw === junk));
    check(dead?.headers.failure_reason?.toString() === 'malformed JSON', 'a malformed message goes to debate.round.0.dlq unchanged, with the reason');

    console.log('\nApproval');
    const key = randomUUID();
    const approve = (body, k = key) => call('ai', `/ai/tasks/${one.task_id}/approve`, body, { token: guest.token, headers: { 'Idempotency-Key': k } });
    const first = await approve({ decision: 'approved' });
    const again = await approve({ decision: 'approved' });
    check(first.status === 200 && first.data.status === 'APPROVED' && again.status === 200, 'approve, and the same call again, both answer 200', first);
    check((await approve({ decision: 'rejected' }, randomUUID())).status === 409, 'a second decision -> 409');
    await until(() => mine('ai.approvals').length);
    await sleep(1000);
    check(mine('ai.approvals').length === 1, 'exactly one ai.approvals event', String(mine('ai.approvals').length));
    check((await call('ai', '/ai/feedback', { task_id: one.task_id, label: 'correct' }, { token: guest.token })).status === 201, 'feedback saved');

    console.log('\nAvailability');
    await takenWinner(guest, other, ask, one.result.recommended.property_id);

    if (WITH_TIMEOUT) await agentTimeout(guest);
  } finally {
    await consumer.disconnect();
    await producer.disconnect();
  }
}

async function takenWinner(guest, other, ask, winner) {
  const book = (path, body) => call('booking', path, body, { token: other.token, headers: { 'Idempotency-Key': randomUUID() } });
  const booked = await book('/bookings/request', { property_id: winner, check_in: ask.check_in, check_out: ask.check_out, guest_count: 2 });
  const id = booked.data?.reservation_id;
  const written = id && await until(async () => (await call('booking', '/bookings/get', { reservation_id: id }, { token: other.token })).data?.status === 'REQUESTED');
  check(written, `another guest booked ${winner} (run npm run gen:properties if this fails)`, booked);
  if (!written) return;
  try {
    const second = await debate(guest, ask);
    check(second.result && second.result.recommended.property_id !== winner && second.result.limitations.some((l) => l.includes(`${winner} won the vote but is not free`)),
      'a taken winner is replaced by the next best free stay, and the result says so', second.result?.limitations);
  } finally {
    const undo = await book('/bookings/cancel', { reservation_id: id, cancellation_reason: 'AI smoke test' });
    check(undo.status === 202, 'test booking cancelled', undo);
  }
}

async function agentTimeout(guest) {
  console.log('\nAgent timeout');
  const compose = (...args) => execFileSync('docker', ['compose', ...args], { stdio: 'pipe' });
  compose('stop', 'ai-risk');
  try {
    const t = await debate(guest, { request_text: 'A stay in Oakland for two people' });
    check(t.frames.some((f) => f.type === 'agent.timeout' && f.agent === 'risk' && f.deadline_ms === 20000), 'agent.timeout frame for risk after 20 s');
    check(t.result?.decision.votes.abstain === 0 && t.result.opinions.length === 2 && t.result.limitations.some((l) => l.startsWith('risk gave no valid')), 'the other two still decided, and the result says risk is missing', t.result?.limitations);
  } finally {
    compose('start', 'ai-risk');
  }
}

main().catch((e) => bad(e.stack || e.message)).finally(() => {
  console.log(process.exitCode ? '\nAI smoke test FAILED' : '\nAI smoke test passed');
  process.exit(process.exitCode || 0);
});
