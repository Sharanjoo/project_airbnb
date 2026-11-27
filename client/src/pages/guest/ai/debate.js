// Turns the AI task's stream frames (API doc §9) into what the page shows.
// Pure functions: no React and no network, so they run under `node --test`.

export const AGENTS = ['matching', 'risk', 'fairness'];
export const DECIDED = ['APPROVED', 'EDITED', 'REJECTED'];
export const FAILED = ['FAILED', 'TIMED_OUT'];
/** The agents are finished: either a person must decide, or the task is over. */
export const isDone = (status) => status === 'AWAITING_APPROVAL' || DECIDED.includes(status) || FAILED.includes(status);

// status -> how many plan steps are complete (same table as agents/debate.py)
const STEPS_DONE = { QUEUED: 0, PLANNING: 0, ROUND_0: 2, ROUND_1: 3, ROUND_2: 4, DECIDING: 5 };

export function emptyDebate() {
  return {
    status: 'QUEUED', lastActive: 'QUEUED', lastSeq: 0, steps: [], requirements: null, provider: null, warnings: [],
    agents: Object.fromEntries(AGENTS.map((a) => [a, { opinion: null, responses: null, vote: null, timeouts: [], rejected: [] }])),
    challenges: [], disagreement: null, otherNotes: [], result: null, error: null, log: [],
  };
}

/** Which parser really did the work: a configured model may have failed or added nothing. */
export function parserName(f) {
  if (f.provider === 'deterministic') return 'rules';
  if (f.fallback) return `rules, ${f.provider} was not available`;
  return f.llm_fields?.length ? `rules and ${f.provider} (${f.llm_fields.join(', ')})` : `rules, checked with ${f.provider}`;
}

const updateAgent = (s, name, change) => ({ ...s, agents: { ...s.agents, [name]: { ...s.agents[name], ...change } } });

/** Apply one frame. A frame that was already applied (replay after a reconnect) changes nothing. */
export function applyFrame(s, f) {
  if (f.seq && f.seq <= s.lastSeq) return s;
  let next = { ...s, lastSeq: f.seq || s.lastSeq, log: [...s.log, f] };
  const known = Object.hasOwn(next.agents, f.agent ?? '');
  switch (f.type) {
    case 'status':
      next.status = f.status;
      if (f.status in STEPS_DONE) next.lastActive = f.status;
      return next;
    case 'plan.created':
      return { ...next, steps: f.steps };
    case 'parser.completed':
      return { ...next, requirements: f.requirements, provider: parserName(f), warnings: f.warnings || [] };
    case 'agent.published':
      if (!known) return next;
      return updateAgent(next, f.agent, f.round === 0 ? { opinion: { top3: f.top3, confidence: f.confidence } } : { responses: f.responses });
    case 'challenge.issued':
      return { ...next, disagreement: f.disagreement_score, challenges: [...next.challenges, f] };
    case 'vote.cast':
      return known ? updateAgent(next, f.agent, { vote: { choice: f.vote, property_id: f.property_id, reason: f.reason } }) : next;
    case 'agent.timeout':
      if (known) return updateAgent(next, f.agent, { timeouts: [...next.agents[f.agent].timeouts, { round: f.round, deadline_ms: f.deadline_ms }] });
      return { ...next, otherNotes: [...next.otherNotes, `${f.agent} did not answer within ${f.deadline_ms / 1000} s`] };
    case 'harness.rejected':
      if (known) return updateAgent(next, f.agent, { rejected: [...next.agents[f.agent].rejected, { round: f.round, reason: f.reason }] });
      return { ...next, otherNotes: [...next.otherNotes, `A message from ${f.agent} was rejected: ${f.reason}`] };
    case 'verdict': {
      const { type, seq, timestamp, payload, ...result } = f;
      return { ...next, result, disagreement: result.disagreement_score ?? next.disagreement };
    }
    case 'error':
      return { ...next, error: { code: f.code, message: f.message } };
    default:
      return next; // a newer server may send frame types this page does not know
  }
}

/** Plan steps with done / running / stopped / pending, from the task's status. */
export function planProgress(s) {
  if (isDone(s.status) && !FAILED.includes(s.status)) {
    // The result says when the availability step (6) could not really be carried out.
    const skipped = ['no_dates', 'unverified'].includes(s.result?.availability);
    return s.steps.map((p) => ({ ...p, state: skipped && p.step_no === 6 ? 'skipped' : 'done' }));
  }
  const done = STEPS_DONE[s.lastActive];
  return s.steps.map((p, i) => ({
    ...p, state: i < done ? 'done' : i > done ? 'pending' : FAILED.includes(s.status) ? 'stopped' : 'running',
  }));
}

/** One line on what an agent is doing now. */
export function agentState(s, name) {
  const a = s.agents[name];
  const late = a.timeouts.at(-1);
  if (late) return { tone: 'bad', text: `Timed out in round ${late.round} (${late.deadline_ms / 1000} s limit)` };
  if (a.vote) return { tone: 'good', text: `Voted: ${a.vote.choice}` };
  if (FAILED.includes(s.status)) return { tone: 'muted', text: 'Stopped' };
  if (isDone(s.status)) return { tone: 'muted', text: a.opinion ? 'No vote counted' : 'Took no part' };
  if (a.opinion) {
    if (['ROUND_1', 'ROUND_2'].includes(s.status)) return { tone: 'busy', text: 'Answering challenges and voting' };
    return { tone: 'good', text: 'First ranking published' };
  }
  return s.status === 'ROUND_0' ? { tone: 'busy', text: 'Ranking on its own' } : { tone: 'muted', text: 'Waiting for the parsed request' };
}

export const STATUS_TEXT = {
  QUEUED: 'Queued: waiting for the Chair', PLANNING: 'Reading your request', ROUND_0: 'Round 0: agents rank independently',
  ROUND_1: 'Round 1: the Chair compares and challenges', ROUND_2: 'Round 2: agents answer and vote', DECIDING: 'The Chair is deciding',
  AWAITING_APPROVAL: 'Ready for your decision', APPROVED: 'You approved this', EDITED: 'You chose another stay', REJECTED: 'You rejected this',
  FAILED: 'Ended without a result', TIMED_OUT: 'Timed out',
};

/** Form -> POST /ai/requests body, dropping empty fields. */
export function toRequest(form) {
  const structured = {};
  if (form.city) structured.city = form.city;
  if (form.guests) structured.guests = Number(form.guests);
  if (form.price_max) structured.price_max = Number(form.price_max);
  if (form.min_rating) structured.min_rating = Number(form.min_rating);
  if (form.amenities.length) structured.amenities = form.amenities;
  const body = {};
  if (form.text.trim()) body.request_text = form.text.trim();
  if (Object.keys(structured).length) body.structured = structured;
  if (form.check_in) body.check_in = form.check_in;
  if (form.check_out) body.check_out = form.check_out;
  return body;
}

/** The same body always gets the same Idempotency-Key, so a retry can never act twice. */
export function keyring(newKey = () => crypto.randomUUID()) {
  const keys = new Map();
  return (body) => {
    const id = JSON.stringify(body);
    if (!keys.has(id)) keys.set(id, newKey());
    return keys.get(id);
  };
}
