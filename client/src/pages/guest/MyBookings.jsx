import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getSession } from '../../api/client.js';
import { useLiveUpdates } from '../../api/useLiveUpdates.js';
import {
  StatusBadge, PriceBreakdown, History, useIdempotencyKeys, dateRange, nightsBetween, money, errorText,
} from '../shared/bookingUi.jsx';

// Slice 3: the guest's trips. Upcoming, past and cancelled stays, cancelling,
// and the review prompt after a completed stay. When the host answers, the
// page updates by itself through the live updates, no refresh needed.

const TABS = {
  upcoming: { label: 'Upcoming', status: ['REQUESTED', 'CONFIRMED'] },
  past: { label: 'Past', status: ['COMPLETED'] },
  cancelled: { label: 'Cancelled', status: ['CANCELLED', 'DECLINED', 'EXPIRED', 'REJECTED'] },
};

const LIVE_EVENTS = ['booking.confirmed', 'booking.rejected', 'booking.cancelled', 'booking.completed'];

function liveMessage(frame) {
  const status = frame.payload?.new_status;
  if (frame.type === 'booking.confirmed') return 'Good news, the host confirmed your stay.';
  if (frame.type === 'booking.completed') return 'Your stay is complete. You can leave a review.';
  if (frame.type === 'booking.rejected') return status === 'DECLINED' ? 'The host declined your request.' : 'Those dates were not available.';
  return status === 'EXPIRED' ? 'A request expired because the host did not reply.' : 'A booking was cancelled.';
}

const RATINGS = ['cleanliness', 'accuracy', 'communication', 'location', 'value'];

function ReviewForm({ item, onDone }) {
  const [rating, setRating] = useState(5);
  const [subs, setSubs] = useState(Object.fromEntries(RATINGS.map((r) => [r, 5])));
  const [text, setText] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api('review', '/reviews/create', {
        reservation_id: item.reservation_id,
        rating: Number(rating),
        review_text: text,
        sub_ratings: Object.fromEntries(RATINGS.map((r) => [r, Number(subs[r])])),
      });
      onDone();
    } catch (err) {
      if (err.code === 'ALREADY_REVIEWED') return onDone();
      setMsg(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const scale = [5, 4, 3, 2, 1];
  return (
    <form className="panel filters" onSubmit={submit}>
      <strong>How was your stay?</strong>
      <label>Overall
        <select value={rating} onChange={(e) => setRating(e.target.value)}>{scale.map((n) => <option key={n}>{n}</option>)}</select>
      </label>
      <div className="row">
        {RATINGS.map((r) => (
          <label key={r}>{r}
            <select value={subs[r]} onChange={(e) => setSubs({ ...subs, [r]: e.target.value })}>{scale.map((n) => <option key={n}>{n}</option>)}</select>
          </label>
        ))}
      </div>
      <label>Your review (at least 20 characters)
        <textarea required minLength="20" maxLength="3000" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <button className="primary" type="submit" disabled={busy}>Post review</button>
      {msg && <p className="error">{msg}</p>}
    </form>
  );
}

function Trip({ item, onChanged }) {
  const keys = useIdempotencyKeys();
  const [details, setDetails] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const active = item.status === 'REQUESTED' || item.status === 'CONFIRMED';

  async function toggleDetails() {
    if (details) return setDetails(null);
    try {
      setDetails(await api('booking', '/bookings/get', { reservation_id: item.reservation_id }));
    } catch (err) {
      setMsg({ error: errorText(err) });
    }
  }

  async function cancel(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const name = `cancel:${item.reservation_id}:${reason}`;
    try {
      await api('booking', '/bookings/cancel', { reservation_id: item.reservation_id, cancellation_reason: reason }, { idempotencyKey: keys.keyFor(name) });
      keys.forget(name);
      setCancelling(false);
      setMsg({ ok: 'Cancelling your booking...' });
      setTimeout(onChanged, 700); // the worker needs a moment to finish
    } catch (err) {
      if (!err.retryable) keys.forget(name);
      setMsg({ error: errorText(err) });
      if (err.code === 'INVALID_STATE_TRANSITION') onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="panel booking">
      <div className="row spread">
        <div>
          <Link to={`/properties/${item.property_id}`}><strong>{item.property_title || item.property_id}</strong></Link>
          {item.city && <span className="muted"> · {item.city}</span>}
          <div>{dateRange(item.check_in, item.check_out)} <span className="muted">· {nightsBetween(item.check_in, item.check_out)} nights · {money(item.total)}</span></div>
        </div>
        <StatusBadge status={item.status} />
      </div>

      <div className="row actions">
        <button onClick={toggleDetails}>{details ? 'Hide details' : 'Details'}</button>
        {active && !cancelling && <button onClick={() => setCancelling(true)}>Cancel</button>}
      </div>

      {cancelling && (
        <form className="filters" onSubmit={cancel}>
          <label>Why are you cancelling?
            <textarea required maxLength="500" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !reason.trim()}>Confirm cancellation</button>
            <button type="button" onClick={() => setCancelling(false)}>Keep my booking</button>
          </div>
        </form>
      )}
      {msg?.ok && <p>{msg.ok}</p>}
      {msg?.error && <p className="error">{msg.error}</p>}

      {details && details.price_breakdown && (
        <div className="details">
          <p className="muted">Reservation {details.reservation_id}</p>
          {details.guest_message && <p>You wrote: {details.guest_message}</p>}
          {details.cancellation_reason && <p>Reason: {details.cancellation_reason}</p>}
          <PriceBreakdown b={details.price_breakdown} />
          <History items={details.status_history} />
        </div>
      )}

      {item.review_due && <ReviewForm item={item} onDone={onChanged} />}
    </li>
  );
}

export default function MyBookings() {
  const session = getSession();
  const [tab, setTab] = useState('upcoming');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);

  const load = useCallback(async () => {
    if (session?.role !== 'guest') return; // hosts and visitors see a message instead, no request needed
    try {
      setData(await api('booking', '/bookings/byGuest', { guest_id: session.user_id, status: TABS[tab].status, page, page_size: 10 }));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [tab, page, session?.user_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  useLiveUpdates(session ? [`user:${session.user_id}`] : [], (frame) => {
    if (!LIVE_EVENTS.includes(frame.type)) return;
    setBanner(liveMessage(frame));
    load();
  });

  if (!session) return <p>Please <Link to="/login">log in</Link> to see your trips.</p>;
  if (session.role !== 'guest') return <p className="muted">My trips is for guests. Hosts can find their requests under Host.</p>;

  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const switchTab = (t) => {
    if (t === tab) return; // clicking the tab you are already on should not clear the list
    setTab(t);
    setPage(1);
    setData(null);
    setBanner(null);
  };

  return (
    <div>
      <h1>My trips</h1>
      <div className="tabs">
        {Object.entries(TABS).map(([key, t]) => (
          <button key={key} className={key === tab ? 'tab active' : 'tab'} onClick={() => switchTab(key)}>{t.label}</button>
        ))}
      </div>

      {banner && <p className="notice">{banner}</p>}
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading...</p>}
      {data?.items.length === 0 && (
        <p className="muted">
          {tab === 'upcoming' ? <>No upcoming trips. <Link to="/">Find a place to stay.</Link></> : 'Nothing here yet.'}
        </p>
      )}

      <ul className="list">
        {data?.items.map((item) => <Trip key={item.reservation_id} item={item} onChanged={load} />)}
      </ul>

      {data && pages > 1 && (
        <div className="pager">
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted">Page {page} of {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
