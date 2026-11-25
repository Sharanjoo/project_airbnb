import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getSession } from '../../api/client.js';
import { useLiveUpdates } from '../../api/useLiveUpdates.js';
import {
  StatusBadge, PriceBreakdown, History, useIdempotencyKeys, dateRange, nightsBetween, money, timeAgo, replyDeadline, errorText,
} from '../shared/bookingUi.jsx';

// Slice 3: the host's reservation requests for one listing at a time.
// A host can approve or decline a request (they have 24 hours to answer) and
// cancel a confirmed booking. New requests show up by themselves: the page
// refreshes whenever a live update arrives, and every 15 seconds as a backup.

const FILTERS = {
  pending: { label: 'Needs your answer', status: ['REQUESTED'] },
  confirmed: { label: 'Confirmed', status: ['CONFIRMED'] },
  past: { label: 'Past', status: ['COMPLETED'] },
  closed: { label: 'Cancelled and declined', status: ['CANCELLED', 'DECLINED', 'EXPIRED', 'REJECTED'] },
};

const LIVE_EVENTS = ['booking.requested', 'booking.confirmed', 'booking.rejected', 'booking.cancelled', 'booking.completed'];

function Request({ item, onChanged }) {
  const keys = useIdempotencyKeys();
  const [details, setDetails] = useState(null);
  const [mode, setMode] = useState(null); // 'decline' or 'cancel' while the reason form is open
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function send(name, path, body, doneText) {
    setBusy(true);
    setMsg(null);
    const keyName = `${name}:${item.reservation_id}:${JSON.stringify(body)}`;
    try {
      await api('booking', path, body, { idempotencyKey: keys.keyFor(keyName) });
      keys.forget(keyName);
      setMode(null);
      setReason('');
      setMsg({ ok: doneText });
      setTimeout(onChanged, 700); // the worker needs a moment to finish
    } catch (err) {
      if (!err.retryable) keys.forget(keyName);
      setMsg({ error: err.code === 'INVALID_STATE_TRANSITION' ? 'This request was already handled. The list has been refreshed.' : errorText(err) });
      if (err.code === 'INVALID_STATE_TRANSITION') onChanged();
    } finally {
      setBusy(false);
    }
  }

  const approve = () => send('approve', '/bookings/approve', { reservation_id: item.reservation_id }, 'Approving...');
  const submitReason = (e) => {
    e.preventDefault();
    if (mode === 'decline') send('decline', '/bookings/decline', { reservation_id: item.reservation_id, reason }, 'Declining...');
    else send('cancel', '/bookings/cancel', { reservation_id: item.reservation_id, cancellation_reason: reason }, 'Cancelling...');
  };

  async function toggleDetails() {
    if (details) return setDetails(null);
    try {
      setDetails(await api('booking', '/bookings/get', { reservation_id: item.reservation_id }));
    } catch (err) {
      setMsg({ error: errorText(err) });
    }
  }

  return (
    <li className="panel booking">
      <div className="row spread">
        <div>
          <strong>{dateRange(item.check_in, item.check_out)}</strong>
          <span className="muted"> · {nightsBetween(item.check_in, item.check_out)} nights · {item.guest_count} guest{item.guest_count === 1 ? '' : 's'} · {money(item.total)}</span>
          <div className="muted">Guest {item.guest_id} · requested {timeAgo(item.booking_datetime)}</div>
          {item.status === 'REQUESTED' && <div className="deadline">{replyDeadline(item.booking_datetime)}</div>}
        </div>
        <StatusBadge status={item.status} />
      </div>

      <div className="row actions">
        {item.status === 'REQUESTED' && (
          <>
            <button className="primary" disabled={busy} onClick={approve}>Approve</button>
            <button disabled={busy} onClick={() => setMode(mode === 'decline' ? null : 'decline')}>Decline</button>
          </>
        )}
        {item.status === 'CONFIRMED' && <button disabled={busy} onClick={() => setMode(mode === 'cancel' ? null : 'cancel')}>Cancel booking</button>}
        <button onClick={toggleDetails}>{details ? 'Hide details' : 'Details'}</button>
      </div>

      {mode && (
        <form className="filters" onSubmit={submitReason}>
          <label>{mode === 'decline' ? 'Tell the guest why you are declining' : 'Tell the guest why you are cancelling'}
            <textarea required maxLength="500" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {mode === 'cancel' && <p className="muted">The dates will open up again and the guest will be told.</p>}
          <div className="row">
            <button className="primary" type="submit" disabled={busy || !reason.trim()}>{mode === 'decline' ? 'Decline request' : 'Cancel booking'}</button>
            <button type="button" onClick={() => setMode(null)}>Back</button>
          </div>
        </form>
      )}
      {msg?.ok && <p>{msg.ok}</p>}
      {msg?.error && <p className="error">{msg.error}</p>}

      {details && details.price_breakdown && (
        <div className="details">
          <p className="muted">Reservation {details.reservation_id}</p>
          {details.guest_message ? <p>Message from the guest: {details.guest_message}</p> : <p className="muted">The guest did not leave a message.</p>}
          {details.cancellation_reason && <p>Reason: {details.cancellation_reason}</p>}
          <PriceBreakdown b={details.price_breakdown} />
          <History items={details.status_history} />
        </div>
      )}
    </li>
  );
}

export default function HostRequests() {
  const session = getSession();
  const [listings, setListings] = useState(null);
  const [propertyId, setPropertyId] = useState('');
  const [filter, setFilter] = useState('pending');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [banner, setBanner] = useState(null);

  useEffect(() => {
    if (session?.role !== 'host') return;
    api('property', '/properties/search', { host_id: session.user_id, sort: 'newest', page_size: 100 })
      .then((res) => {
        setListings(res.items);
        if (res.items.length) setPropertyId(res.items[0].property_id);
      })
      .catch((e) => setError(errorText(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (session?.role !== 'host' || !propertyId) return;
    try {
      setData(await api('booking', '/bookings/byProperty', { property_id: propertyId, status: FILTERS[filter].status, page, page_size: 10 }));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, [propertyId, filter, page, session?.user_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  // The live update does the quick work. Checking every 15 seconds is only a safety net in case a push is missed.
  useEffect(() => {
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  useLiveUpdates(session ? [`user:${session.user_id}`] : [], (frame) => {
    if (!LIVE_EVENTS.includes(frame.type)) return;
    if (frame.type === 'booking.requested') {
      setBanner('You have a new booking request.');
      load();
      setTimeout(load, 1200); // the push can arrive a few milliseconds before the worker has saved the booking
      return;
    }
    setBanner('A booking changed. The list has been refreshed.');
    load();
  });

  if (!session) return <p>Please <Link to="/login">log in</Link> to see your reservation requests.</p>;
  if (session.role !== 'host') return <p className="muted">Reservation requests is for hosts.</p>;

  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  // Changing the listing or the tab starts again from page 1. Picking what is already selected does nothing.
  const change = (current, setter) => (value) => {
    if (value === current) return;
    setter(value);
    setPage(1);
    setData(null);
    setBanner(null);
  };

  return (
    <div>
      <div className="row spread">
        <h1>Reservation requests</h1>
        <Link to="/host/listings">My listings</Link>
      </div>

      {listings?.length === 0 && <p className="muted">You have no listings yet, so there are no requests. <Link to="/host/listings">Create a listing.</Link></p>}
      {!listings && !error && <p className="muted">Loading...</p>}

      {listings?.length > 0 && (
        <>
          <label>Listing
            <select value={propertyId} onChange={(e) => change(propertyId, setPropertyId)(e.target.value)}>
              {listings.map((l) => <option key={l.property_id} value={l.property_id}>{l.title} ({l.city})</option>)}
            </select>
          </label>
          <div className="tabs">
            {Object.entries(FILTERS).map(([key, f]) => (
              <button key={key} className={key === filter ? 'tab active' : 'tab'} onClick={() => change(filter, setFilter)(key)}>{f.label}</button>
            ))}
          </div>
        </>
      )}

      {banner && <p className="notice">{banner}</p>}
      {error && <p className="error">{error}</p>}
      {listings?.length > 0 && !data && !error && <p className="muted">Loading...</p>}
      {data?.items.length === 0 && <p className="muted">Nothing here for this listing.</p>}

      <ul className="list">
        {data?.items.map((item) => <Request key={item.reservation_id} item={item} onChanged={load} />)}
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
