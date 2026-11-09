import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getSession } from '../../api/client.js';
import { AMENITIES, CITIES, TYPES, label } from '../guest/Search.jsx';

// Slice 2: a host's own listings: create, edit price, pause, delete, block dates.
// Conflicts (another tab or co-host changed the same listing) come back as 409
// and are shown to the host, who reloads and decides again (feature 13.3).

const NEW = {
  title: '', description: '', property_type: 'apartment', line1: '', city: 'San Jose', state: 'CA', zip: '',
  capacity: 2, bedrooms: 1, bathrooms: 1, nightly_price: 120, cleaning_fee: 30, amenities: ['wifi'],
};

const message = (e) => (e.details?.length ? e.details.map((d) => `${d.field}: ${d.issue}`).join('; ') : e.message);

function Calendar({ listing }) {
  const [cal, setCal] = useState(null);
  const [range, setRange] = useState({ start_date: '', end_date: '' });
  const [msg, setMsg] = useState(null);

  const load = () => api('property', '/properties/availability', { property_id: listing.property_id }).then(setCal).catch((e) => setMsg(message(e)));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function change(body) {
    setMsg(null);
    try {
      await api('property', '/properties/availability', { property_id: listing.property_id, expected_version: cal.availability_version, ...body });
    } catch (e) {
      setMsg(e.code === 'VERSION_CONFLICT' ? 'Someone else changed this calendar. It has been reloaded; check it and try again.' : message(e));
    }
    load();
  }

  if (!cal) return <p className="muted">{msg || 'Loading calendar…'}</p>;
  return (
    <div className="calendar">
      {cal.unavailable.length === 0 && <p className="muted">No blocked or booked dates in the next 90 days.</p>}
      <ul>
        {cal.unavailable.map((u) => (
          <li key={`${u.start_date}-${u.status}`}>
            {u.start_date} → {u.end_date} · {u.status}
            {u.status === 'blocked' && <button onClick={() => change({ action: 'unblock', availability_id: u.availability_id })}>Unblock</button>}
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={(e) => { e.preventDefault(); change({ action: 'block', ...range }); }}>
        <input type="date" required value={range.start_date} onChange={(e) => setRange({ ...range, start_date: e.target.value })} />
        <input type="date" required value={range.end_date} onChange={(e) => setRange({ ...range, end_date: e.target.value })} />
        <button type="submit">Block dates</button>
      </form>
      {msg && <p className="error">{msg}</p>}
    </div>
  );
}

function ListingRow({ listing, onChanged }) {
  const [price, setPrice] = useState(listing.nightly_price);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(null);

  // The search result has no version, so read the listing first: always edit the latest copy.
  async function update(changes) {
    setMsg(null);
    try {
      const current = await api('property', '/properties/get', { property_id: listing.property_id });
      await api('property', '/properties/update', { property_id: listing.property_id, version: current.version, ...changes });
      onChanged();
    } catch (e) {
      setMsg(e.code === 'VERSION_CONFLICT' ? 'Changed elsewhere at the same moment; reloaded, please try again.' : message(e));
      onChanged();
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${listing.title}"?`)) return;
    try {
      await api('property', '/properties/delete', { property_id: listing.property_id });
      onChanged();
    } catch (e) {
      setMsg(message(e));
    }
  }

  return (
    <li className="panel">
      <div className="row spread">
        <div>
          <Link to={`/properties/${listing.property_id}`}><strong>{listing.title}</strong></Link>
          <p className="muted">{label(listing.property_type)} · {listing.city} · {listing.status}</p>
        </div>
        <div className="row">
          <input type="number" min="10" max="5000" value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 90 }} />
          <button onClick={() => update({ nightly_price: Number(price) })}>Save price</button>
          <button onClick={() => update({ status: listing.status === 'active' ? 'inactive' : 'active' })}>
            {listing.status === 'active' ? 'Pause' : 'Activate'}
          </button>
          <button onClick={() => setOpen(!open)}>{open ? 'Hide calendar' : 'Calendar'}</button>
          <button onClick={remove}>Delete</button>
        </div>
      </div>
      {msg && <p className="error">{msg}</p>}
      {open && <Calendar listing={listing} />}
    </li>
  );
}

export default function HostListings() {
  const session = getSession();
  const [listings, setListings] = useState(null);
  const [form, setForm] = useState(NEW);
  const [showNew, setShowNew] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () => api('property', '/properties/search', { host_id: session.user_id, sort: 'newest', page_size: 100 })
    .then((r) => setListings(r.items))
    .catch((e) => setMsg(message(e)));
  useEffect(() => { if (session?.role === 'host') load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (session?.role !== 'host') return <p className="muted">Log in as a host to manage listings. <Link to="/login">Log in</Link></p>;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  async function create(e) {
    e.preventDefault();
    setMsg(null);
    try {
      await api('property', '/properties/create', {
        title: form.title, description: form.description, property_type: form.property_type,
        address: { line1: form.line1, city: form.city, state: form.state, zip: form.zip },
        capacity: Number(form.capacity), bedrooms: Number(form.bedrooms), bathrooms: Number(form.bathrooms),
        nightly_price: Number(form.nightly_price), cleaning_fee: Number(form.cleaning_fee), amenities: form.amenities,
        pet_friendly: form.amenities.includes('pet_friendly'),
      });
      setForm(NEW);
      setShowNew(false);
      load();
    } catch (err) {
      setMsg(message(err));
    }
  }

  return (
    <div>
      <div className="row spread">
        <h1>My listings</h1>
        <button className="primary" onClick={() => setShowNew(!showNew)}>{showNew ? 'Cancel' : 'New listing'}</button>
      </div>
      {msg && <p className="error">{msg}</p>}

      {showNew && (
        <form className="panel filters" onSubmit={create}>
          <label>Title<input required minLength="5" maxLength="100" value={form.title} onChange={set('title')} /></label>
          <label>Description<textarea required maxLength="5000" value={form.description} onChange={set('description')} /></label>
          <div className="row">
            <label>Type<select value={form.property_type} onChange={set('property_type')}>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></label>
            <label>City<select value={form.city} onChange={set('city')}>{CITIES.map((c) => <option key={c}>{c}</option>)}</select></label>
          </div>
          <div className="row">
            <label>Street<input required value={form.line1} onChange={set('line1')} /></label>
            <label>ZIP<input required pattern="\d{5}" value={form.zip} onChange={set('zip')} /></label>
          </div>
          <div className="row">
            <label>Guests<input type="number" min="1" max="16" value={form.capacity} onChange={set('capacity')} /></label>
            <label>Bedrooms<input type="number" min="0" max="10" value={form.bedrooms} onChange={set('bedrooms')} /></label>
            <label>Baths<input type="number" min="0.5" max="10" step="0.5" value={form.bathrooms} onChange={set('bathrooms')} /></label>
          </div>
          <div className="row">
            <label>$ / night<input type="number" min="10" max="5000" value={form.nightly_price} onChange={set('nightly_price')} /></label>
            <label>Cleaning fee<input type="number" min="0" max="500" value={form.cleaning_fee} onChange={set('cleaning_fee')} /></label>
          </div>
          <fieldset>
            <legend>Amenities</legend>
            {AMENITIES.map((a) => (
              <label key={a} className="chip">
                <input type="checkbox" checked={form.amenities.includes(a)}
                  onChange={() => setForm({ ...form, amenities: form.amenities.includes(a) ? form.amenities.filter((x) => x !== a) : [...form.amenities, a] })} />
                {label(a)}
              </label>
            ))}
          </fieldset>
          <button className="primary" type="submit">Create listing</button>
        </form>
      )}

      {!listings && <p className="muted">Loading…</p>}
      {listings?.length === 0 && <p className="muted">No listings yet.</p>}
      <ul className="list">
        {listings?.map((l) => <ListingRow key={l.property_id} listing={l} onChanged={load} />)}
      </ul>
    </div>
  );
}
