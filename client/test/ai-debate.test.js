import test from 'node:test';
import assert from 'node:assert/strict';
import { agentState, applyFrame, emptyDebate, keyring, parserName, planProgress, toRequest } from '../src/pages/guest/ai/debate.js';

const steps = Array.from({ length: 7 }, (_, i) => ({ step_no: i + 1, name: `s${i}` }));
const run = (frames, from = emptyDebate()) => frames.reduce((s, f, i) => applyFrame(s, { seq: from.lastSeq + i + 1, ...f }), from);
const opened = [{ type: 'status', status: 'PLANNING' }, { type: 'plan.created', steps }, { type: 'status', status: 'ROUND_0' }];

test('a full debate ends with opinions, answers, votes and the verdict', () => {
  const s = run([...opened,
    { type: 'parser.completed', requirements: { city: 'Napa' }, provider: 'rules', warnings: [] },
    { type: 'agent.published', agent: 'risk', round: 0, top3: ['a'], confidence: 0.8 },
    { type: 'challenge.issued', challenge_id: 'c1', to_agent: 'risk', question: 'why', disagreement_score: 0.5 },
    { type: 'agent.published', agent: 'risk', round: 2, responses: [{ challenge_id: 'c1', answer: 'x' }] },
    { type: 'vote.cast', agent: 'risk', vote: 'keep', property_id: 'a', reason: 'r' },
    { type: 'verdict', task_id: 't', trace_id: 'r', recommended: { property_id: 'a' }, payload: {}, disagreement_score: 0.5 },
    { type: 'status', status: 'AWAITING_APPROVAL' }]);
  assert.equal(s.agents.risk.opinion.confidence, 0.8);
  assert.equal(s.agents.risk.responses[0].answer, 'x');
  assert.deepEqual(agentState(s, 'risk'), { tone: 'good', text: 'Voted: keep' });
  assert.equal(s.result.recommended.property_id, 'a');
  assert.equal('payload' in s.result, false);
  assert.ok(planProgress(s).every((p) => p.state === 'done'));
});

test('an availability step that was not carried out is shown as skipped', () => {
  const s = run([...opened, { type: 'verdict', availability: 'no_dates' }, { type: 'status', status: 'AWAITING_APPROVAL' }]);
  assert.equal(planProgress(s)[5].state, 'skipped');
  assert.equal(planProgress(s)[6].state, 'done');
});

test('the parser label never credits a model that did not answer', () => {
  assert.equal(parserName({ provider: 'deterministic' }), 'rules');
  assert.equal(parserName({ provider: 'ollama', fallback: 'llm_error' }), 'rules, ollama was not available');
  assert.equal(parserName({ provider: 'ollama', llm_fields: ['guests'] }), 'rules and ollama (guests)');
});

test('replayed frames change nothing', () => {
  const s = run(opened);
  assert.equal(applyFrame(s, { seq: 2, type: 'plan.created', steps: [] }), s);
});

test('a status without seq (decision over HTTP) is applied', () => {
  assert.equal(applyFrame(run(opened), { type: 'status', status: 'APPROVED' }).status, 'APPROVED');
});

test('plan progress follows the status, and a failure stops the running step', () => {
  assert.deepEqual(planProgress(run(opened)).map((p) => p.state), ['done', 'done', 'running', 'pending', 'pending', 'pending', 'pending']);
  const failed = run([{ type: 'status', status: 'TIMED_OUT' }, { type: 'error', code: 'X', message: 'm' }], run(opened));
  assert.equal(planProgress(failed)[2].state, 'stopped');
  assert.equal(failed.error.message, 'm');
});

test('timeouts and rejections show on the agent; unknown agents never crash the page', () => {
  const s = run([...opened, { type: 'agent.timeout', agent: 'fairness', round: 0, deadline_ms: 20000 },
    { type: 'harness.rejected', agent: 'risk', round: 0, reason: 'bad' },
    { type: 'harness.rejected', agent: '__proto__', round: 0, reason: 'odd' },
    { type: 'agent.timeout', agent: 'parser', round: null, deadline_ms: 30000 }, { type: 'something.new' }]);
  assert.match(agentState(s, 'fairness').text, /Timed out in round 0 \(20 s/);
  assert.equal(s.agents.risk.rejected[0].reason, 'bad');
  assert.equal(s.otherNotes.length, 2);
});

test('empty form fields are dropped from the request', () => {
  const form = { text: '  ', city: '', guests: '2', price_max: '', min_rating: '', amenities: [], check_in: '', check_out: '' };
  assert.deepEqual(toRequest(form), { structured: { guests: 2 } });
  assert.deepEqual(toRequest({ ...form, guests: '' }), {});
});

test('the same body keeps its key, a different body gets another', () => {
  let n = 0;
  const key = keyring(() => `k${++n}`);
  assert.equal(key({ a: 1 }), key({ a: 1 }));
  assert.notEqual(key({ a: 1 }), key({ a: 2 }));
});
