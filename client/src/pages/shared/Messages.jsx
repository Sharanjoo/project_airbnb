import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useSession } from '../../api/useSession.js';
import { useLiveUpdates } from '../../api/useLiveUpdates.js';
import './Messages.css';

// Slice 1: conversations between a guest and a host (one thread per guest, host and listing).
// A booking request opens the thread automatically and the guest's note becomes the
// first message. Deep links other pages can use:
//   /messages?thread=thr_...        open a conversation
//   /messages?reservation=res_...   open (or create) the thread for a booking
//   /messages?property=prp_...      guest: ask the host about a listing
// Live updates: the notification gateway pushes message.sent to user:<me> with ids only;
// the page then fetches the text through the API, where participant checks apply.

const PAGE = 30;
const time = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const errorText = (e) => (e.details?.length ? e.details.map((d) => `${d.field}: ${d.issue}`).join('; ') : e.message);

/** Merge message lists by id, oldest first. */
function merge(a, b) {
  const byId = new Map([...a, ...b].map((m) => [m.message_id, m]));
  return [...byId.values()].sort((x, y) => (x.timestamp === y.timestamp ? (x.message_id < y.message_id ? -1 : 1) : x.timestamp < y.timestamp ? -1 : 1));
}

function ThreadList({ threads, selected, onSelect }) {
  if (!threads) return <p className="muted">Loading conversations…</p>;
  if (threads.length === 0) {
    return <p className="muted">No conversations yet. Requesting a booking starts one with the host.</p>;
  }
  return (
    <ul className="thread-list">
      {threads.map((t) => (
        <li key={t.thread_id}>
          <button type="button" className={t.thread_id === selected ? 'active' : ''} onClick={() => onSelect(t.thread_id)}>
            <span className="thread-top">
              <strong>{t.counterpart.name || t.counterpart.user_id}</strong>
              {t.unread_count > 0 && <span className="unread" aria-label={`${t.unread_count} unread`}>{t.unread_count}</span>}
            </span>
            <span className="thread-sub">{t.property_title || t.property_id}</span>
            <span className="thread-preview muted">{t.last_message ? t.last_message.preview : 'No messages yet'}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Conversation({ thread, me, onActivity, liveTick }) {
  const [messages, setMessages] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState([]); // { client_message_id, message_text, failed }
  const [error, setError] = useState(null);
  const bottom = useRef(null);
  const threadId = thread.thread_id;

  const markRead = useCallback(() => api('messaging', '/messages/markRead', { thread_id: threadId }).then(onActivity).catch(() => {}), [threadId, onActivity]);

  // Newest page (initial load and on every live push for this thread)
  const loadLatest = useCallback(async () => {
    try {
      const page = await api('messaging', '/messages/list', { thread_id: threadId, limit: PAGE });
      setMessages((prev) => merge(prev, page.items));
      setCursor((c) => c ?? page.next_before);
      setHasMore((h) => h || page.has_more);
      if (page.items.some((m) => m.receiver_id === me && !m.read_at)) markRead();
    } catch (e) {
      setError(errorText(e));
    }
  }, [threadId, me, markRead]);

  useEffect(() => {
    setMessages([]); setCursor(null); setHasMore(false); setPending([]); setError(null);
    loadLatest();
  }, [threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (liveTick) loadLatest(); }, [liveTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [messages.length, pending.length]);

  async function loadOlder() {
    try {
      const page = await api('messaging', '/messages/list', { thread_id: threadId, before: cursor, limit: PAGE });
      setMessages((prev) => merge(page.items, prev));
      setCursor(page.next_before);
      setHasMore(page.has_more);
    } catch (e) {
      setError(errorText(e));
    }
  }

  // Each message keeps its client_message_id across retries, so a retry after a
  // timeout or a 503 can never create a second copy on the server.
  async function send(item) {
    setPending((p) => [...p.filter((x) => x.client_message_id !== item.client_message_id), { ...item, failed: false }]);
    try {
      const saved = await api('messaging', '/messages/send', { thread_id: threadId, message_text: item.message_text, client_message_id: item.client_message_id });
      setPending((p) => p.filter((x) => x.client_message_id !== item.client_message_id));
      setMessages((prev) => merge(prev, [saved]));
      onActivity();
    } catch (e) {
      setPending((p) => p.map((x) => (x.client_message_id === item.client_message_id ? { ...x, failed: true, reason: errorText(e) } : x)));
    }
  }

  function submit(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText('');
    send({ client_message_id: crypto.randomUUID(), message_text: body });
  }

  return (
    <section className="conversation">
      <header>
        <h2>{thread.counterpart.name || thread.counterpart.user_id}</h2>
        <p className="muted">
          <Link to={`/properties/${thread.property_id}`}>{thread.property_title || thread.property_id}</Link>
          {thread.reservation_ids.length > 0 && ` · booking ${thread.reservation_ids.join(', ')}`}
        </p>
      </header>
      <div className="message-scroll">
        {hasMore && <button type="button" className="older" onClick={loadOlder}>Load earlier messages</button>}
        {messages.length === 0 && pending.length === 0 && <p className="muted">No messages yet. Say hello.</p>}
        <ol className="messages">
          {messages.map((m) => (
            <li key={m.message_id} className={m.sender_id === me ? 'mine' : 'theirs'}>
              <p>{m.message_text}</p>
              <span className="meta">
                {m.reservation_id && 'Booking request · '}
                {time(m.timestamp)}
                {m.sender_id === me && (m.read_at ? ' · Read' : ' · Sent')}
              </span>
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.client_message_id} className="mine pending">
              <p>{p.message_text}</p>
              <span className="meta">
                {p.failed ? <>Not sent ({p.reason}) <button type="button" onClick={() => send(p)}>Retry</button></> : 'Sending…'}
              </span>
            </li>
          ))}
        </ol>
        <div ref={bottom} />
      </div>
      {error && <p className="error">{error}</p>}
      <form className="composer" onSubmit={submit}>
        <textarea
          value={text}
          maxLength={2000}
          rows={2}
          placeholder="Write a message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) submit(e); }}
        />
        <button type="submit" disabled={!text.trim()}>Send</button>
      </form>
    </section>
  );
}

export default function Messages() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const [threads, setThreads] = useState(null);
  const [error, setError] = useState(null);
  const [liveTick, setLiveTick] = useState(0);
  const selected = params.get('thread');

  const loadThreads = useCallback(() => {
    if (!session) return Promise.resolve();
    return api('messaging', '/threads/byUser', { page_size: 50 })
      .then((d) => setThreads(d.items))
      .catch((e) => setError(errorText(e)));
  }, [session?.user_id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadThreads(); }, [loadThreads]);

  // ?reservation= / ?property= : open or create the thread, then show it
  useEffect(() => {
    const reservation = params.get('reservation');
    const property = params.get('property');
    if (!session || (!reservation && !property)) return;
    api('messaging', '/threads/open', reservation ? { reservation_id: reservation } : { property_id: property })
      .then((t) => { setParams({ thread: t.thread_id }, { replace: true }); loadThreads(); })
      .catch((e) => setError(errorText(e)));
  }, [params.get('reservation'), params.get('property'), session?.user_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // message.sent pushes for me carry ids only: refresh the list, and the open thread if it is the one
  useLiveUpdates([], (frame) => {
    if (frame.type !== 'message.sent') return;
    loadThreads();
    if (frame.payload?.thread_id === selected) setLiveTick((n) => n + 1);
  });

  if (!session) {
    return (
      <div className="panel">
        <h1>Messages</h1>
        <p>Please <Link to="/login">log in</Link> to see your conversations.</p>
      </div>
    );
  }

  const current = threads?.find((t) => t.thread_id === selected);
  return (
    <div className="messages-page">
      <aside>
        <h1>Messages</h1>
        {error && <p className="error">{error}</p>}
        <ThreadList threads={threads} selected={selected} onSelect={(id) => { setError(null); setParams({ thread: id }); }} />
      </aside>
      {current
        ? <Conversation key={current.thread_id} thread={current} me={session.user_id} onActivity={loadThreads} liveTick={liveTick} />
        : <section className="conversation empty"><p className="muted">{selected && threads ? 'Conversation not found.' : 'Select a conversation.'}</p></section>}
    </div>
  );
}
