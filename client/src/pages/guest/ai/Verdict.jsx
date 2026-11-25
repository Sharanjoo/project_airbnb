import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';
import { label } from '../Search.jsx';
import { DECIDED, keyring } from './debate.js';
import { property, title } from './pool.js';
import { WithNames } from './Debate.jsx';

const pct = (n) => `${Math.round(n * 100)}%`;
const messageOf = (e) => (e.details?.length ? e.details.map((d) => `${d.field}: ${d.issue}`).join('; ') : e.message);

export default function Verdict({ taskId, session, debate, onStatus }) {
  const r = debate.result;
  const p = property(r.recommended.property_id);
  const { keep, switch: switched, abstain } = r.decision.votes;
  return (
    <div className="panel ai-verdict">
      <p className="muted ai-small">Recommendation</p>
      <h2 className="ai-h">{title(r.recommended.property_id)}</h2>
      {p && <p>{label(p.property_type)} in {p.city} · ${p.nightly_price} per night · sleeps {p.capacity} · {p.rating ? `★ ${p.rating} (${p.review_count})` : 'no reviews yet'}</p>}
      <p>{r.explanation}</p>
      <p className="ai-small">
        <span className="badge ai-first">score {r.recommended.score}</span>
        <span className="badge">confidence {pct(r.confidence)}</span>
        <span className="badge">{r.decision.mode}: {keep} keep, {switched} switch, {abstain} abstain</span>
        <span className="badge">{r.config_version}</span>
      </p>
      <List name="Risks" items={r.risks} />
      <List name="Limits of this result" items={r.limitations} />
      <List name="Dissent" items={r.dissent.map((d) => `${d.agent} preferred ${d.position}: ${d.reason}`.replace('chair preferred', 'Chair chose'))} />
      <p><Link to={`/properties/${r.recommended.property_id}${dateQuery(r.parsed_request)}`}>See the full listing</Link></p>
      <Decision taskId={taskId} session={session} debate={debate} onStatus={onStatus} />
      <Feedback taskId={taskId} />
    </div>
  );
}

const dateQuery = (req) => (req?.check_in && req?.check_out ? `?check_in=${req.check_in}&check_out=${req.check_out}` : '');

function List({ name, items }) {
  if (!items?.length) return null;
  return <div className="ai-small"><b>{name}</b><ul>{items.map((t) => <li key={t}><WithNames text={t} /></li>)}</ul></div>;
}

/** Human checkpoint: approve, pick another stay, or reject. */
function Decision({ taskId, session, debate, onStatus }) {
  const r = debate.result;
  const others = r.ranked.filter((id) => id !== r.recommended.property_id);
  const [edited, setEdited] = useState(others[0] || '');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [human, setHuman] = useState(null);
  const keyFor = useRef(keyring()).current;
  const decided = DECIDED.includes(debate.status);

  // The verdict frame was sent before the decision; after a reload, read the decided result.
  useEffect(() => {
    if (!decided || human) return undefined;
    let live = true;
    api('ai', `/ai/results/${encodeURIComponent(taskId)}`, null, { method: 'GET' })
      .then((d) => live && setHuman(d.human_decision), (e) => live && setError(e.message));
    return () => { live = false; };
  }, [decided, human, taskId]);

  async function decide(decision) {
    const body = { decision };
    if (decision === 'edited') body.edited_property_id = edited;
    if (reason.trim()) body.reason = reason.trim();
    setBusy(true);
    setError(null);
    try {
      const d = await api('ai', `/ai/tasks/${encodeURIComponent(taskId)}/approve`, body, { idempotencyKey: keyFor(body) });
      setHuman({ decision, chosen: d.chosen, reason: body.reason || null });
      onStatus(d.status);
    } catch (e) {
      setError(e.retryable ? `${messageOf(e)} Press the same button again to finish.` : messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (decided) {
    return (
      <div className="ai-decision">
        {error && <p className="error" role="alert">{error}</p>}
        {human && (human.chosen
          ? <><p><b>Your choice: {title(human.chosen)}</b>{human.reason && ` (${human.reason})`}</p>
            <Book session={session} propertyId={human.chosen} req={r.parsed_request} /></>
          : <p><b>You rejected this recommendation.</b> Nothing was booked.{human.reason && ` Reason: ${human.reason}`}</p>)}
      </div>
    );
  }
  if (debate.status !== 'AWAITING_APPROVAL') return null;
  if (r.user_id !== session.user_id) return <p className="muted ai-decision">Only the guest who asked can decide.</p>;
  return (
    <div className="ai-decision">
      <h3 className="ai-h">Your decision</h3>
      <label>Reason (optional)<input value={reason} maxLength="500" onChange={(e) => setReason(e.target.value)} /></label>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => decide('approved')}>Approve</button>
        <button type="button" disabled={busy} onClick={() => decide('rejected')}>Reject</button>
      </div>
      {others.length > 0 && (
        <div className="row">
          <label>Or choose another stay the agents ranked
            <select value={edited} onChange={(e) => setEdited(e.target.value)}>
              {others.map((id) => <option key={id} value={id}>{title(id)}{property(id) ? ` ($${property(id).nightly_price}, ${property(id).city})` : ''}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy} onClick={() => decide('edited')}>Choose this one</button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

/** A separate, explicit step after approval. Uses the normal booking API (Slice 3). */
function Book({ session, propertyId, req }) {
  const [stay, setStay] = useState({ check_in: req?.check_in || '', check_out: req?.check_out || '', guest_count: req?.guests || 2 });
  const [state, setState] = useState(null);
  const keyFor = useRef(keyring()).current;
  if (session.role !== 'guest') return null;
  const ready = stay.check_in && stay.check_out > stay.check_in && Number(stay.guest_count) >= 1;
  const set = (k) => (e) => { setStay({ ...stay, [k]: e.target.value }); setState(null); };

  async function book(e) {
    e.preventDefault();
    setState({ sending: true });
    const body = { property_id: propertyId, check_in: stay.check_in, check_out: stay.check_out, guest_count: Number(stay.guest_count) };
    try {
      const d = await api('booking', '/bookings/request', body, { idempotencyKey: keyFor(body) });
      setState({ sent: d.reservation_id });
    } catch (err) {
      setState({ error: messageOf(err) });
    }
  }

  return (
    <form onSubmit={book}>
      <div className="row">
        <label>Check in<input type="date" required value={stay.check_in} onChange={set('check_in')} /></label>
        <label>Check out<input type="date" required min={stay.check_in} value={stay.check_out} onChange={set('check_out')} /></label>
        <label>Guests<input type="number" required min="1" max="16" value={stay.guest_count} onChange={set('guest_count')} /></label>
        <button className="primary" disabled={!ready || state?.sending || !!state?.sent}>Request to book</button>
      </div>
      {state?.sent && <p>Request sent ({state.sent}). The host answers in <Link to="/bookings">My trips</Link>.</p>}
      {state?.error && <p className="error" role="alert">{state.error}</p>}
    </form>
  );
}

function Feedback({ taskId }) {
  const [note, setNote] = useState('');
  const [state, setState] = useState(null);
  async function send(value) {
    setState({ sending: true });
    try {
      await api('ai', '/ai/feedback', { task_id: taskId, label: value, ...(note.trim() && { note: note.trim() }) });
      setState({ sent: true });
    } catch (e) {
      setState({ error: messageOf(e) });
    }
  }
  if (state?.sent) return <p className="muted ai-small">Thanks, your feedback was saved.</p>;
  return (
    <div className="row ai-small ai-feedback">
      <label>Was this a good recommendation? Add a note (optional)<input value={note} maxLength="1000" onChange={(e) => setNote(e.target.value)} /></label>
      <button type="button" disabled={state?.sending} onClick={() => send('correct')}>Yes</button>
      <button type="button" disabled={state?.sending} onClick={() => send('incorrect')}>No</button>
      {state?.error && <p className="error" role="alert">{state.error}</p>}
    </div>
  );
}
