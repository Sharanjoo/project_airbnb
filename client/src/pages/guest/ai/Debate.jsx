import { useState } from 'react';
import { api } from '../../../api/client.js';
import { label } from '../Search.jsx';
import { AGENTS, FAILED, STATUS_TEXT, agentState, isDone, planProgress } from './debate.js';
import { property, title } from './pool.js';
import Verdict from './Verdict.jsx';

const pct = (n) => `${Math.round(n * 100)}%`;
const MARK = { done: '✓', running: '●', stopped: '✕', skipped: '–', pending: '○' };

/** Agents write property ids; show names where the id is a property in the pool. */
export function WithNames({ text }) {
  return String(text).split(/(prp_[A-Za-z0-9_]+)/).map((part, i) => (i % 2 ? <b key={i} title={part}>{title(part)}</b> : part));
}

export default function Debate({ taskId, session, debate, link, onStatus }) {
  if (link.state === 'failed') return <section className="panel"><p className="error" role="alert">{link.message}</p></section>;
  const failed = FAILED.includes(debate.status);
  return (
    <section className="ai-main">
      <div className="panel">
        <div className="row spread">
          <h2 className="ai-h" aria-live="polite">{STATUS_TEXT[debate.status] || debate.status}</h2>
          <span className={`badge ai-link-${link.state}`}>{{ live: 'Live', connecting: 'Connecting', waiting: 'Reconnecting', closed: 'Finished' }[link.state]}</span>
        </div>
        {link.state === 'waiting' && <p className="notice">{link.message}</p>}
        <p className="muted ai-small">Task {taskId}</p>
        {failed && <p className="error" role="alert">{debate.error?.message || 'The task ended without a result.'} Please send a new request.</p>}
        {debate.otherNotes.map((n) => <p key={n} className="notice">{n}</p>)}
        <Plan debate={debate} />
        <Understood debate={debate} />
      </div>

      {debate.result && <Verdict taskId={taskId} session={session} debate={debate} onStatus={onStatus} />}

      <div className="ai-agents">{AGENTS.map((a) => <AgentCard key={a} name={a} debate={debate} />)}</div>
      <Challenges debate={debate} />
      <Record taskId={taskId} debate={debate} />
    </section>
  );
}

function Plan({ debate }) {
  const steps = planProgress(debate);
  if (!steps.length) return <p className="muted">The Chair has not written the plan yet.</p>;
  return (
    <ol className="ai-plan">
      {steps.map((s) => (
        <li key={s.step_no} className={s.state}>
          <span aria-hidden="true">{MARK[s.state]}</span> {s.name} <small className="muted">{s.agent} · {s.state}</small>
        </li>
      ))}
    </ol>
  );
}

function Understood({ debate }) {
  if (!debate.requirements) return null;
  const items = Object.entries(debate.requirements).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length));
  return (
    <div>
      <p className="ai-small"><b>Understood as:</b> {items.map(([k, v]) => `${label(k)}: ${Array.isArray(v) ? v.map(label).join(', ') : v}`).join(' · ') || 'no specific requirements'}
        {' '}<span className="muted">(parser: {debate.provider})</span></p>
      {debate.warnings.map((w) => <p key={w} className="notice ai-small">{w}</p>)}
    </div>
  );
}

function AgentCard({ name, debate }) {
  const a = debate.agents[name];
  const state = agentState(debate, name);
  return (
    <article className="panel ai-agent">
      <h3 className="ai-h">{label(name)} agent</h3>
      <p className={`ai-state ${state.tone}`}>{state.text}</p>
      {a.opinion && (
        <>
          <p className="ai-small muted">First ranking, {pct(a.opinion.confidence)} confident</p>
          <ol className="ai-top">{a.opinion.top3.map((id) => <li key={id} title={id}>{title(id)} {property(id) && <small className="muted">${property(id).nightly_price}</small>}</li>)}</ol>
        </>
      )}
      {a.rejected.map((r) => <p key={r.reason + r.round} className="error ai-small">Message rejected (round {r.round}): {r.reason}</p>)}
      {a.vote && <p className="ai-small"><b>Vote: {a.vote.choice}{a.vote.property_id ? ', ' : ''}</b>{a.vote.property_id && title(a.vote.property_id)}. <WithNames text={a.vote.reason} /></p>}
    </article>
  );
}

function Challenges({ debate }) {
  if (debate.disagreement === null) return null;
  const answers = Object.fromEntries(AGENTS.flatMap((a) => (debate.agents[a].responses || []).map((r) => [r.challenge_id, r.answer])));
  return (
    <div className="panel">
      <div className="row spread"><h3 className="ai-h">Challenges</h3><span className="badge">disagreement {debate.disagreement.toFixed(2)}</span></div>
      {debate.challenges.length === 0 && <p className="muted">No challenges were needed.</p>}
      {debate.challenges.map((c) => (
        <div key={c.challenge_id} className="ai-challenge">
          <p><b>Chair to {c.to_agent}:</b> <WithNames text={c.question} /></p>
          <p className={answers[c.challenge_id] ? '' : 'muted'}>
            {answers[c.challenge_id] ? <><b>{c.to_agent}:</b> <WithNames text={answers[c.challenge_id]} /></> : isDone(debate.status) ? 'No answer.' : 'Waiting for the answer.'}
          </p>
        </div>
      ))}
    </div>
  );
}

/** The raw evidence: every frame received, and the messages stored in MongoDB. */
function Record({ taskId, debate }) {
  const [stored, setStored] = useState(null);
  const [error, setError] = useState(null);
  async function load() {
    setError(null);
    try {
      setStored(await api('ai', `/ai/tasks/${encodeURIComponent(taskId)}/debate`, null, { method: 'GET' }));
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <details className="panel">
      <summary>Full record ({debate.log.length} live events)</summary>
      <ol className="ai-log">
        {debate.log.map((f, i) => <li key={f.seq ?? `x${i}`}><code>{f.timestamp?.slice(11, 23)} {f.type}</code> {[f.agent || f.to_agent, f.status, f.vote].filter(Boolean).join(' · ')}</li>)}
      </ol>
      <button type="button" onClick={load}>Load stored debate messages</button>
      {error && <p className="error">{error}</p>}
      {stored && <pre className="ai-json">{JSON.stringify(stored, null, 2)}</pre>}
    </details>
  );
}
