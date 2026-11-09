import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client.js';

// Slice 2: property search with every filter from the spec (§5).
export const CITIES = ['San Jose', 'San Francisco', 'Oakland', 'Palo Alto', 'Santa Cruz', 'Monterey', 'South Lake Tahoe', 'Napa', 'Sacramento', 'Fresno'];
export const TYPES = ['entire_home', 'apartment', 'private_room', 'shared_room', 'cabin', 'condo'];
export const AMENITIES = ['wifi', 'kitchen', 'parking', 'washer', 'ac', 'heating', 'pool', 'pet_friendly', 'workspace', 'self_checkin'];
export const label = (s) => s.replace(/_/g, ' ');

const EMPTY = {
  city: 'San Jose', check_in: '', check_out: '', guests: '', price_min: '', price_max: '',
  property_types: [], amenities: [], min_rating: '', pet_friendly: false, sort: 'price_asc',
};

/** Form state -> API body, dropping empty fields. */
function toBody(f, page) {
  const body = { sort: f.sort, page, page_size: 12 };
  if (f.city) body.location = { city: f.city };
  if (f.check_in && f.check_out) Object.assign(body, { check_in: f.check_in, check_out: f.check_out });
  if (f.guests) body.guests = Number(f.guests);
  if (f.price_min) body.price_min = Number(f.price_min);
  if (f.price_max) body.price_max = Number(f.price_max);
  if (f.property_types.length) body.property_types = f.property_types;
  if (f.amenities.length) body.amenities = f.amenities;
  if (f.min_rating) body.min_rating = Number(f.min_rating);
  if (f.pet_friendly) body.pet_friendly = true;
  return body;
}

export default function Search() {
  const [params] = useSearchParams();
  const [form, setForm] = useState({ ...EMPTY, city: params.get('city') || EMPTY.city });
  const [page, setPage] = useState(1);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function run(p = 1) {
    setLoading(true);
    setError(null);
    try {
      setResult(await api('property', '/properties/search', toBody(form, p)));
      setPage(p);
    } catch (e) {
      setError(e.details?.length ? e.details.map((d) => `${d.field}: ${d.issue}`).join('; ') : e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    run(1);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const toggle = (k, v) => setForm({ ...form, [k]: form[k].includes(v) ? form[k].filter((x) => x !== v) : [...form[k], v] });
  const pages = result ? Math.max(1, Math.ceil(result.total / result.page_size)) : 1;
  const dates = form.check_in && form.check_out ? `?check_in=${form.check_in}&check_out=${form.check_out}` : '';

  return (
    <div className="search-layout">
      <form className="panel filters" onSubmit={(e) => { e.preventDefault(); run(1); }}>
        <h1>Find a stay</h1>
        <label>Where
          <select value={form.city} onChange={set('city')}>
            <option value="">Anywhere</option>
            {CITIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <div className="row">
          <label>Check in<input type="date" value={form.check_in} onChange={set('check_in')} /></label>
          <label>Check out<input type="date" value={form.check_out} onChange={set('check_out')} /></label>
        </div>
        <div className="row">
          <label>Guests<input type="number" min="1" max="16" value={form.guests} onChange={set('guests')} /></label>
          <label>Min rating<input type="number" min="0" max="5" step="0.1" value={form.min_rating} onChange={set('min_rating')} /></label>
        </div>
        <div className="row">
          <label>Min $/night<input type="number" min="0" value={form.price_min} onChange={set('price_min')} /></label>
          <label>Max $/night<input type="number" min="0" value={form.price_max} onChange={set('price_max')} /></label>
        </div>
        <fieldset>
          <legend>Property type</legend>
          {TYPES.map((t) => (
            <label key={t} className="chip">
              <input type="checkbox" checked={form.property_types.includes(t)} onChange={() => toggle('property_types', t)} />
              {label(t)}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Amenities (all required)</legend>
          {AMENITIES.map((a) => (
            <label key={a} className="chip">
              <input type="checkbox" checked={form.amenities.includes(a)} onChange={() => toggle('amenities', a)} />
              {label(a)}
            </label>
          ))}
        </fieldset>
        <label className="inline"><input type="checkbox" checked={form.pet_friendly} onChange={set('pet_friendly')} /> Pet friendly</label>
        <label>Sort by
          <select value={form.sort} onChange={set('sort')}>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="rating_desc">Top rated</option>
            <option value="newest">Newest</option>
          </select>
        </label>
        <div className="row">
          <button type="submit" className="primary" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
          <button type="button" onClick={() => setForm(EMPTY)}>Clear</button>
        </div>
      </form>

      <section>
        {error && <p className="error">{error}</p>}
        {result && (
          <p className="muted">
            {result.total} {result.total === 1 ? 'stay' : 'stays'}
            {form.check_in && form.check_out ? ' available for your dates' : ''}
            <span className="badge" title="Search strategy, cache result and server time (feature 13.8 / 13.9)">
              {result.strategy} · {result.cache} · {result.took_ms} ms
            </span>
          </p>
        )}
        <div className="grid">
          {result?.items.map((p) => (
            <Link key={p.property_id} to={`/properties/${p.property_id}${dates}`} className="card">
              <div className="card-top">
                <span className="type">{label(p.property_type)} · {p.city}</span>
                <span>{p.rating ? `★ ${p.rating.toFixed(2)} (${p.review_count})` : 'New'}</span>
              </div>
              <strong>{p.title}</strong>
              <span className="muted">Up to {p.capacity} guest{p.capacity === 1 ? '' : 's'} · {p.bedrooms} bedroom{p.bedrooms === 1 ? '' : 's'}</span>
              <span className="muted">{p.amenities.slice(0, 4).map(label).join(' · ')}</span>
              <span className="price">${p.nightly_price} <small>/ night</small></span>
            </Link>
          ))}
        </div>
        {result && result.total === 0 && <p className="muted">No stays match. Try fewer filters or other dates.</p>}
        {pages > 1 && (
          <div className="pager">
            <button disabled={page <= 1 || loading} onClick={() => run(page - 1)}>Previous</button>
            <span>Page {page} of {pages}</span>
            <button disabled={page >= pages || loading} onClick={() => run(page + 1)}>Next</button>
          </div>
        )}
      </section>
    </div>
  );
}
