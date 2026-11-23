import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { clearSession, onSessionChange, parseSession, readSessionRaw } from './client.js';

// setTimeout overflows above ~24.8 days; tokens are hours long, so clamp to be safe.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The current session, re-rendering when it changes (login, logout, a 401 that
 * cleared it, expiry, or a login in another tab). Returns { token, user_id, role, expires_at } or null.
 */
export function useSession() {
  const raw = useSyncExternalStore(onSessionChange, readSessionRaw, () => null);
  const session = useMemo(() => parseSession(raw), [raw]);

  // Stored but already expired or malformed: clear it now. Otherwise clear it the moment it expires.
  useEffect(() => {
    if (raw && !session) {
      clearSession();
      return undefined;
    }
    if (!session?.expires_at) return undefined;
    const ms = Math.min(Date.parse(session.expires_at) - Date.now(), MAX_TIMER_MS);
    const timer = setTimeout(clearSession, Math.max(ms, 0));
    return () => clearTimeout(timer);
  }, [raw, session]);

  return session;
}
