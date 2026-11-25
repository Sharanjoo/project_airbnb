// Follows one AI task over its WebSocket and reconnects where it stopped.
// No React here; the timers and WebSocket are passed in so tests can drive them.

const FINAL = { 4401: 'Your session ended. Log in again.', 4403: 'This AI task belongs to another account.', 4404: 'This AI task does not exist.' };
const MAX_WAIT_MS = 8000;
const CHECK_TIMEOUT_MS = 10000; // a request that never answers must not stop the reconnecting

/**
 * openStream({ taskId, token, check, onFrame, onLink }) -> close()
 *   check()        normal HTTP call made before each connection: it gives a clear 403/404,
 *                  and the gateway only accepts WebSocket upgrades after a first HTTP call.
 *   onFrame(frame) every stream frame
 *   onLink(link)   { state: connecting | live | waiting | closed | failed, message }
 */
export function openStream({ taskId, token, check, onFrame, onLink, WS = globalThis.WebSocket, base, wait = setTimeout, cancel = clearTimeout }) {
  let closed = false;
  let ws = null;
  let timer = null;
  let after = 0;
  let failures = 0;

  const timedOut = () => new Promise((_, reject) => { timer = wait(() => reject(new Error('no answer')), CHECK_TIMEOUT_MS); });

  function retry() {
    if (closed) return;
    const ms = Math.min(1000 * 2 ** failures, MAX_WAIT_MS);
    failures += 1;
    onLink({ state: 'waiting', message: `Connection lost. Trying again in ${ms / 1000} s.` });
    timer = wait(connect, ms);
  }

  async function connect() {
    if (closed) return;
    onLink({ state: 'connecting' });
    try {
      await Promise.race([check(), timedOut()]);
    } catch (e) {
      cancel(timer);
      if (closed) return;
      if ([401, 403, 404].includes(e.status)) return onLink({ state: 'failed', message: FINAL[4000 + e.status] });
      return retry();
    }
    cancel(timer);
    if (closed) return;
    ws = new WS(`${base}/api/v1/ai/ai/tasks/${encodeURIComponent(taskId)}/stream?token=${encodeURIComponent(token)}&after=${after}`);
    ws.onopen = () => !closed && onLink({ state: 'live' });
    ws.onmessage = (e) => {
      if (closed) return;
      let frame;
      try {
        frame = JSON.parse(e.data);
      } catch {
        return;
      }
      if (frame.seq > after) after = frame.seq;
      failures = 0;
      onFrame(frame);
    };
    ws.onclose = (e) => {
      if (closed) return;
      if (e.code === 1000) onLink({ state: 'closed' });
      else if (FINAL[e.code]) onLink({ state: 'failed', message: FINAL[e.code] });
      else retry();
    };
  }

  connect();
  return () => {
    closed = true;
    cancel(timer);
    // A frame with a gap must never be applied later, so handlers stop with the flag above.
    ws?.close();
  };
}
