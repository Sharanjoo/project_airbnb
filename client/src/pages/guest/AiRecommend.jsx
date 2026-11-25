import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useSession } from '../../api/useSession.js';
import { AMENITIES, CITIES, label } from './Search.jsx';
import { STATUS_TEXT, isDone, toRequest } from './ai/debate.js';
import { useDebates } from './ai/useDebates.js';
import Debate from './ai/Debate.jsx';
import './ai/AiRecommend.css';

// Slice 5: ask the AI agents for a stay, watch the debate live, then approve, edit or reject.
// The open task is in the URL (?task=), so a reload replays the whole debate.

const EMPTY = { text: '', city: '', check_in: '', check_out: '', guests: '', price_max: '', min_rating: '', amenities: [] };
const MAX_RECENT = 5;

const recentKey = (userId) => `staybook.ai.tasks.${userId}`;
function readRecent(userId) {
  try {
    const list = JSON.parse(localStorage.getItem(recentKey(userId)));
    return Array.isArray(list) ? list.filter((t) => typeof t?.task_id === 'string') : [];
  } catch {
    return [];
  }
}

export default function AiRecommend() {
  const session = useSession();
  if (!session) return <p>Please <Link to="/login">log in</Link> to use AI match.</p>;
  return <AiMatch key={session.user_id} session={session} />;
}

function AiMatch({ session }) {
  const [params, setParams] = useSearchParams();
  const [recent, setRecent] = useState(() => readRecent(session.user_id));
  const [form, setForm] = useState(EMPTY);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  const selected = params.get('task');
  const ids = [...new Set([selected, ...recent.map((t) => t.task_id)].filter(Boolean))];
  const debates = useDebates(ids, session.token);

  useEffect(() => {
    try {
      localStorage.setItem(recentKey(session.user_id), JSON.stringify(recent));
    } catch {
      /* private mode: the list just does not survive a reload */
    }
  }, [recent, session.user_id]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const toggle = (a) => setForm({ ...form, amenities: form.amenities.includes(a) ? form.amenities.filter((x) => x !== a) : [...form.amenities, a] });
  const body = toRequest(form);

  async function submit(e) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const task = await api('ai', '/ai/requests', body);
      const name = form.text.trim() || [form.city, form.guests && `${form.guests} guests`].filter(Boolean).join(', ') || 'Filters only';
      setRecent((r) => [{ task_id: task.task_id, name: name.slice(0, 80) }, ...r].slice(0, MAX_RECENT));
      setParams({ task: task.task_id });
    } catch (err) {
      if (err.code === 'RATE_LIMITED') setError('You already have several AI requests running. Wait for one to finish, then try again.');
      else setError(err.details?.length ? err.details.map((d) => `${d.field}: ${d.issue}`).join('; ') : err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="ai-layout">
      <aside className="ai-side">
        <form className="panel filters" onSubmit={submit}>
          <h1>AI match</h1>
          <label>What are you looking for?
            <textarea value={form.text} onChange={set('text')} minLength="5" maxLength="1000"
              placeholder="A stay in San Jose for two people, under $250 per night, with parking and a kitchen, rating at least 4.5" />
          </label>
          <div className="row">
            <label>Check in<input type="date" value={form.check_in} onChange={set('check_in')} /></label>
            <label>Check out<input type="date" value={form.check_out} min={form.check_in} onChange={set('check_out')} /></label>
          </div>
          <details>
            <summary>Exact filters (optional)</summary>
            <div className="filters ai-filters">
              <label>City
                <select value={form.city} onChange={set('city')}>
                  <option value="">Any</option>
                  {CITIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <div className="row">
                <label>Guests<input type="number" min="1" max="16" value={form.guests} onChange={set('guests')} /></label>
                <label>Max $/night<input type="number" min="0" value={form.price_max} onChange={set('price_max')} /></label>
                <label>Min rating<input type="number" min="0" max="5" step="0.1" value={form.min_rating} onChange={set('min_rating')} /></label>
              </div>
              <div>
                {AMENITIES.map((a) => (
                  <label key={a} className="chip"><input type="checkbox" checked={form.amenities.includes(a)} onChange={() => toggle(a)} />{label(a)}</label>
                ))}
              </div>
            </div>
          </details>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={sending || (!body.request_text && !body.structured)}>{sending ? 'Sending…' : 'Ask the agents'}</button>
          <p className="muted ai-small">Agents only recommend. Nothing is booked unless you request it.</p>
        </form>

        {recent.length > 0 && (
          <section className="panel">
            <h3 className="ai-h">Your recent requests</h3>
            <ul className="ai-recent">
              {recent.map((t) => {
                const { debate, link } = debates.get(t.task_id);
                const gone = link.state === 'failed';
                return (
                  <li key={t.task_id}>
                    <button type="button" className={t.task_id === selected ? 'on' : ''} aria-current={t.task_id === selected} onClick={() => setParams({ task: t.task_id })}>
                      <span>{t.name}</span>
                      <small className={gone || isDone(debate.status) ? 'muted' : 'ai-busy'}>{gone ? 'Not available' : STATUS_TEXT[debate.status] || debate.status}</small>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </aside>

      {selected
        ? <Debate key={selected} taskId={selected} session={session} {...debates.get(selected)} onStatus={(s) => debates.setStatus(selected, s)} />
        : <section className="panel muted">Three agents (matching, risk and fairness) rank stays on their own, then the Chair makes them defend their picks and vote. You will see each step here.</section>}
    </div>
  );
}
