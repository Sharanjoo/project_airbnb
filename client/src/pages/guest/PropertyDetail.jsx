import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { api, getSession } from '../../api/client.js';
import { useLiveUpdates } from '../../api/useLiveUpdates.js';
import { label } from './Search.jsx';

// Slice 2 (listing, save, calendar) + Slice 3 (booking request).
// Live updates (13.4): when someone else books or a host blocks dates on this
// listing, the calendar refreshes and the booking button is disabled without a reload.

const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2; // [start, end) ranges

export default function PropertyDetail() {
  const { propertyId } = useParams();
  const [params] = useSearchParams();
  const session = getSession();
  const [p, setP] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [stay, setStay] = useState({ check_in: params.get('check_in') || '', check_out: params.get('check_out') || '', guest_count: 2, guest_message: '' });
  const [notice, setNotice] = useState(null);
  const [booking, setBooking] = useState(null);

  const loadCalendar = useCallback(async () => {
    if (!session) return;
    try {
      setCalendar(await api('property', '/properties/availability', { property_id: propertyId }));
    } catch {
      setCalendar(null);
    }
  }, [propertyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api('property', '/properties/get', { property_id: propertyId }, { headers: { 'X-View-Source': params.get('check_in') ? 'search' : 'direct' } })
      .then(setP)
      .catch((e) => setError(e.status === 410 ? 'This listing is no longer available.' : e.message));
    loadCalendar();
  }, [propertyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useLiveUpdates([`property:${propertyId}`], (frame) => {
    if (!['availability.changed', 'booking.confirmed', 'booking.cancelled', 'booking.rejected'].includes(frame.type)) return;
    const latency = frame.sent_at ? Math.max(0, Date.now() - Date.parse(frame.sent_at)) : null;
    loadCalendar();
    const pl = frame.payload || {};
    const hit = stay.check_in && stay.check_out && pl.check_in && pl.check_out && overlaps(stay.check_in, stay.check_out, pl.check_in, pl.check_out);
    setNotice(`${hit ? 'Your dates are no longer available.' : 'Availability just changed.'}${latency !== null ? ` (update arrived in ${latency} ms)` : ''}`);
  });

  const blocked = calendar?.unavailable.filter((u) => stay.check_in && stay.check_out && overlaps(stay.check_in, stay.check_out, u.start_date, u.end_date)) || [];
  const nights = stay.check_in && stay.check_out ? Math.round((Date.parse(stay.check_out) - Date.parse(stay.check_in)) / 86400000) : 0;

  async function toggleSave() {
    try {
      await api('property', '/properties/save', { property_id: propertyId, saved: !saved });
      setSaved(!saved);
    } catch (e) {
      setError(e.message);
    }
  }

  async function requestBooking(e) {
    e.preventDefault();
    setBooking({ state: 'sending' });
    try {
      const data = await api('booking', '/bookings/request', {
        property_id: propertyId, check_in: stay.check_in, check_out: stay.check_out,
        guest_count: Number(stay.guest_count), guest_message: stay.guest_message || undefined,
      }, { idempotencyKey: crypto.randomUUID() });
      setBooking({ state: 'sent', reservation_id: data.reservation_id });
    } catch (err) {
      setBooking({ state: 'error', message: err.message });
    }
  }

  if (error) return <p className="error">{error} <Link to="/">Back to search</Link></p>;
  if (!p) return <p className="muted">Loading…</p>;

  return (
    <div className="detail">
      <section>
        <p className="muted">{label(p.property_type)} · {p.address.city}, {p.address.state}</p>
        <h1>{p.title}</h1>
        <p className="muted">
          {p.rating ? `★ ${p.rating.toFixed(2)} · ${p.review_count} reviews` : 'New listing'} · up to {p.capacity} guest{p.capacity === 1 ? '' : 's'} ·{' '}
          {p.bedrooms} bedroom{p.bedrooms === 1 ? '' : 's'} · {p.bathrooms} bath
        </p>
        <p>{p.description}</p>
        <h3>Amenities</h3>
        <p>{p.amenities.map(label).join(' · ') || 'None listed'}</p>
        {session?.role === 'guest' && (
          <button onClick={toggleSave}>{saved ? '♥ Saved' : '♡ Save'}</button>
        )}

        <h3>Unavailable dates</h3>
        {!session && <p className="muted">Log in to see the calendar.</p>}
        {calendar && (calendar.unavailable.length
          ? <ul>{calendar.unavailable.map((u) => <li key={`${u.start_date}-${u.status}`}>{u.start_date} → {u.end_date} ({u.status})</li>)}</ul>
          : <p className="muted">Open for the next 90 days.</p>)}
      </section>

      <form className="panel" onSubmit={requestBooking}>
        <p className="price">${p.nightly_price} <small>/ night</small></p>
        {notice && <p className="notice">{notice}</p>}
        <div className="row">
          <label>Check in<input type="date" required value={stay.check_in} onChange={(e) => setStay({ ...stay, check_in: e.target.value })} /></label>
          <label>Check out<input type="date" required value={stay.check_out} onChange={(e) => setStay({ ...stay, check_out: e.target.value })} /></label>
        </div>
        <label>Guests<input type="number" min="1" max={p.capacity} value={stay.guest_count} onChange={(e) => setStay({ ...stay, guest_count: e.target.value })} /></label>
        <label>Message to host<textarea maxLength="1000" value={stay.guest_message} onChange={(e) => setStay({ ...stay, guest_message: e.target.value })} /></label>
        {nights > 0 && (
          <p className="muted">
            {nights} night{nights === 1 ? '' : 's'} × ${p.nightly_price} + ${p.cleaning_fee} cleaning (fees and taxes calculated at booking)
          </p>
        )}
        {blocked.length > 0 && <p className="error">Those dates are not available.</p>}
        <button className="primary" type="submit"
          disabled={session?.role !== 'guest' || blocked.length > 0 || nights < 1 || booking?.state === 'sending'}>
          {session?.role === 'guest' ? 'Request to book' : 'Log in as a guest to book'}
        </button>
        {booking?.state === 'sent' && <p>Request sent ({booking.reservation_id}). You will see the host's answer in My trips.</p>}
        {booking?.state === 'error' && <p className="error">{booking.message}</p>}
      </form>
    </div>
  );
}
