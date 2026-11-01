import { useEffect, useRef } from 'react';
import { getSession } from './client.js';

/**
 * Subscribe to real-time pushes from the notification gateway (13.4).
 *   useLiveUpdates(['property:prp_0001'], (frame) => { ... })
 * frame = { type, trace_id, sent_at, payload }
 */
export function useLiveUpdates(channels, onFrame) {
  const handler = useRef(onFrame);
  handler.current = onFrame;
  const key = channels.join(',');

  useEffect(() => {
    const token = getSession()?.token;
    if (!token) return undefined;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => ws.send(JSON.stringify({ subscribe: key ? key.split(',') : [] }));
    ws.onmessage = (e) => {
      try {
        handler.current(JSON.parse(e.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    // TODO (slice 4): reconnect with backoff; measure notification latency from frame.sent_at
    return () => ws.close();
  }, [key]);
}
