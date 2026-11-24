// Load one analytics GET endpoint and reload when the query changes.
//   const { data, error, loading, reload } = useAnalytics('/analytics/platform', { from, to })
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';

export function useAnalytics(path, params, { skip = false } = {}) {
  const qs = new URLSearchParams(Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  const url = qs ? `${path}?${qs}` : path;
  const [state, setState] = useState({ data: null, error: null, loading: !skip });

  const load = useCallback(async () => {
    if (skip) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ data: await api('analytics', url, null, { method: 'GET' }), error: null, loading: false });
    } catch (err) {
      setState({ data: null, error: err, loading: false });
    }
  }, [url, skip]);

  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

/** A friendly line for an API error. */
export function errorLine(err) {
  if (!err) return null;
  if (err.status === 401) return 'Please log in to see this dashboard.';
  if (err.status === 403) return 'This dashboard is not available for your account.';
  if (err.status === 503) return 'Analytics data is temporarily unavailable. Try again in a moment.';
  return err.message;
}
