// One fetch wrapper for every service call: adds JWT, a trace id, and turns the
// common error body ({ error: { code, message } }) into a thrown ApiError.
const SESSION_KEY = 'staybook.session';

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

export function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

export function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function logout() {
  localStorage.removeItem(SESSION_KEY);
  window.location.href = '/login';
}

/** api('booking', '/bookings/request', body, { idempotencyKey }) */
export async function api(service, path, body, { method = 'POST', idempotencyKey } = {}) {
  const session = getSession();
  const headers = { 'Content-Type': 'application/json', 'X-Trace-Id': crypto.randomUUID() };
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const res = await fetch(`/api/v1/${service}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json);
  return json.data;
}
