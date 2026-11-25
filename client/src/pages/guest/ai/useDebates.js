import { useEffect, useReducer, useRef } from 'react';
import { api } from '../../../api/client.js';
import { applyFrame, emptyDebate } from './debate.js';
import { openStream } from './stream.js';

const EMPTY = { debate: emptyDebate(), link: { state: 'connecting' } };

function reducer(all, action) {
  if (action.type === 'reset') return {};
  const cur = all[action.id] || EMPTY;
  return { ...all, [action.id]: action.type === 'frame' ? { ...cur, debate: applyFrame(cur.debate, action.frame) } : { ...cur, link: action.link } };
}

/** One stream per task id. Frames are kept per task, so concurrent debates never mix. */
export function useDebates(ids, token) {
  const [all, dispatch] = useReducer(reducer, {});
  const open = useRef(new Map());
  const key = ids.join(',');

  useEffect(() => () => { // another login, or leaving the page
    open.current.forEach((close) => close());
    open.current.clear();
    dispatch({ type: 'reset' });
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const wanted = key ? key.split(',') : [];
    const base = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;
    for (const [id, close] of open.current) {
      if (!wanted.includes(id)) {
        close();
        open.current.delete(id);
      }
    }
    for (const id of wanted) {
      if (open.current.has(id)) continue;
      open.current.set(id, openStream({
        taskId: id, token, base,
        check: () => api('ai', `/ai/tasks/${encodeURIComponent(id)}`, null, { method: 'GET' }),
        onFrame: (frame) => dispatch({ type: 'frame', id, frame }),
        onLink: (link) => dispatch({ type: 'link', id, link }),
      }));
    }
  }, [key, token]);

  return {
    get: (id) => all[id] || EMPTY,
    /** A decision is made over HTTP after the stream closed, so add its status here. */
    setStatus: (id, status) => dispatch({ type: 'frame', id, frame: { type: 'status', status } }),
  };
}
