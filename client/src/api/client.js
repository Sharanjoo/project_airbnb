// One fetch wrapper for every service call: adds JWT, a trace id, and turns the
// common error body ({ error: { code, message } }) into a thrown ApiError.
const SESSION_KEY = 'staybook.session';
const SESSION_EVENT = 'staybook:session'; // fired on this tab when the session changes

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details || [];
    this.retryable = !!body?.error?.retryable;
    this.traceId = body?.trace_id;
  }
}

function readStorage() {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

/** Parse a stored session; null when missing, malformed or past expires_at. */
export function parseSession(raw, now = Date.now()) {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (!s?.token || !s?.user_id || !s?.role) return null;
    if (s.expires_at && Date.parse(s.expires_at) <= now) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * { token, user_id, role, expires_at } or null (also null once expired). Pages call
 * this while rendering, so it has no side effects; useSession() in App clears an
 * expired session from storage.
 */
export function getSession() {
  return parseSession(readStorage());
}

function notify() {
  window.dispatchEvent(new Event(SESSION_EVENT));
}

/** Store the login response: { token, expires_at, user_id, role }. */
export function setSession({ token, expires_at, user_id, role }) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token, expires_at, user_id, role }));
  } finally {
    notify();
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } finally {
    notify();
  }
}

/** Subscribe to session changes in this tab and in other tabs. Returns an unsubscribe function. */
export function onSessionChange(callback) {
  const onStorage = (e) => { if (e.key === null || e.key === SESSION_KEY) callback(); };
  window.addEventListener(SESSION_EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SESSION_EVENT, callback);
    window.removeEventListener('storage', onStorage);
  };
}

export function readSessionRaw() {
  return readStorage();
}

export function logout() {
  clearSession();
  window.location.href = '/login';
}

/** api('booking', '/bookings/request', body, { idempotencyKey, headers }) */
export async function api(service, path, body, { method = 'POST', idempotencyKey, headers: extra = {} } = {}) {
  const session = getSession();
  const headers = { 'Content-Type': 'application/json', 'X-Trace-Id': crypto.randomUUID(), ...extra };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`/api/v1/${service}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => null);
  // The gateway rejected our token (expired, or signed with an old secret): drop it so
  // the UI shows the logged-out state instead of failing every call. On public routes
  // the gateway answers normally but flags the dropped token with X-Auth-Status.
  // Only clear if the stored token is still the one this request sent: a slow reply
  // to an old request must not log out a session created in the meantime.
  const rejected = (res.status === 401 && json?.error?.code === 'UNAUTHENTICATED') || res.headers.get('X-Auth-Status') === 'invalid';
  if (rejected && session?.token && getSession()?.token === session.token) clearSession();
  if (!res.ok) throw new ApiError(res.status, json);
  return json.data;
}
