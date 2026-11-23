import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, logout, setSession } from '../api/client.js';
import { useSession } from '../api/useSession.js';

// Slice 1: log in and sign up as a guest or a host.
// The session stored here ({ token, user_id, role, expires_at }) is what every
// other page reads through getSession() / useSession().

export const HOME_FOR_ROLE = { guest: '/', host: '/host/listings', admin: '/dashboards/platform' };

const EMPTY = { email: '', password: '', confirm: '', first_name: '', last_name: '', name: '', phone: '', location: '' };

const errorText = (e) => (e.details?.length ? e.details.map((d) => `${d.field}: ${d.issue}`).join('; ') : e.message);

/** Only the fields the chosen endpoint accepts, with empty optional fields left out (the API rejects unknown or blank ones). */
export function signupBody(role, form) {
  const body = { email: form.email.trim(), password: form.password };
  if (role === 'guest') {
    body.first_name = form.first_name.trim();
    body.last_name = form.last_name.trim();
    if (form.location.trim()) body.location = form.location.trim();
  } else {
    body.name = form.name.trim();
  }
  if (form.phone.trim()) body.phone = form.phone.trim();
  return body;
}

export default function Login() {
  const session = useSession();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [role, setRole] = useState('guest'); // account type: 'guest' | 'host'
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (field) => (e) => setForm({ ...form, [field]: e.target.value });

  async function logIn(email, password) {
    const s = await api('user', '/auth/login', { email: email.trim(), password, role });
    setSession(s);
    navigate(HOME_FOR_ROLE[s.role] || '/');
  }

  async function submit(e) {
    e.preventDefault();
    setError(null);
    if (mode === 'signup' && form.password !== form.confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'signup') {
        await api('user', role === 'guest' ? '/guests/create' : '/hosts/create', signupBody(role, form));
      }
      await logIn(form.email, form.password);
    } catch (err) {
      if (err.code === 'EMAIL_TAKEN') setError(`A ${role} account with this email already exists. Log in instead.`);
      else if (err.code === 'RATE_LIMITED') setError('Too many attempts. Wait a minute and try again.');
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (session) {
    return (
      <section className="panel auth">
        <h1>You are logged in</h1>
        <p>
          Signed in as <code>{session.user_id}</code> ({session.role}).
          {session.expires_at && <span className="muted"> Session ends {new Date(session.expires_at).toLocaleString()}.</span>}
        </p>
        <div className="row">
          <Link to={HOME_FOR_ROLE[session.role] || '/'}>Continue</Link>
          <button type="button" onClick={logout}>Log out</button>
        </div>
      </section>
    );
  }

  const signup = mode === 'signup';
  return (
    <section className="panel auth">
      <div className="auth-switch" role="tablist">
        <button type="button" role="tab" aria-selected={!signup} className={!signup ? 'primary' : ''} onClick={() => { setMode('login'); setError(null); }}>
          Log in
        </button>
        <button type="button" role="tab" aria-selected={signup} className={signup ? 'primary' : ''} onClick={() => { setMode('signup'); setError(null); }}>
          Sign up
        </button>
      </div>

      <form onSubmit={submit} className="auth-form">
        <fieldset>
          <legend>Account type</legend>
          <label className="inline"><input type="radio" name="role" value="guest" checked={role === 'guest'} onChange={() => setRole('guest')} /> Guest</label>
          <label className="inline"><input type="radio" name="role" value="host" checked={role === 'host'} onChange={() => setRole('host')} /> Host</label>
        </fieldset>

        {signup && role === 'guest' && (
          <div className="row">
            <label>First name<input required maxLength={60} value={form.first_name} onChange={set('first_name')} autoComplete="given-name" /></label>
            <label>Last name<input required maxLength={60} value={form.last_name} onChange={set('last_name')} autoComplete="family-name" /></label>
          </div>
        )}
        {signup && role === 'host' && (
          <label>Name<input required maxLength={120} value={form.name} onChange={set('name')} autoComplete="name" /></label>
        )}

        <label>Email<input required type="email" maxLength={255} value={form.email} onChange={set('email')} autoComplete="email" /></label>
        <label>
          Password
          <input required type="password" minLength={signup ? 8 : 1} value={form.password} onChange={set('password')}
            autoComplete={signup ? 'new-password' : 'current-password'} />
        </label>

        {signup && (
          <>
            <label>Confirm password<input required type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" /></label>
            <label>Phone (optional, e.g. +14085550101)<input type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" /></label>
            {role === 'guest' && (
              <label>Location (optional)<input maxLength={120} value={form.location} onChange={set('location')} placeholder="San Jose, CA" /></label>
            )}
          </>
        )}

        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Please wait…' : signup ? `Create ${role} account` : `Log in as ${role}`}
        </button>
      </form>
    </section>
  );
}
