// Notification gateway: turns Kafka events into WebSocket pushes (13.4).
// Client connects to ws://host:8009/ws?token=<JWT> and sends
//   { "subscribe": ["user:gst_0001", "property:prp_0001"] }
// Every Kafka event is pushed to channels derived from its payload.
//
// Who may hear what:
//   user:<id>      only the user whose token has sub = <id>. Gets the full payload.
//   property:<id>  anyone signed in (listing pages are public). Gets only the public
//                  fields in PUBLIC_PROPERTY_FIELDS, and only for PROPERTY_EVENTS.
//   task:<id>      ai.results only reach the task's owner (payload.user_id) or an admin.
// Subscribing to anything else is ignored. One connection holds at most MAX_CHANNELS
// channels (its own user channel included); further subscribes are ignored too.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'notification-gateway';
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { EventBus, TOPICS, logger } = require('@airbnb/common');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-dev-secret';
const GROUP = 'notify-cg';

const PUSHED_TOPICS = [
  TOPICS.BOOKING_REQUESTED, // hosts see new requests instantly (HostRequests)
  TOPICS.BOOKING_CONFIRMED, TOPICS.BOOKING_REJECTED, TOPICS.BOOKING_CANCELLED, TOPICS.BOOKING_COMPLETED,
  TOPICS.AVAILABILITY_CHANGED, TOPICS.MESSAGE_SENT, TOPICS.AI_RESULTS,
];

/** Events that listing watchers (property:<id>) hear about. A pending request is not one of them. */
const PROPERTY_EVENTS = new Set([
  TOPICS.AVAILABILITY_CHANGED, TOPICS.BOOKING_CONFIRMED, TOPICS.BOOKING_REJECTED,
  TOPICS.BOOKING_CANCELLED, TOPICS.BOOKING_COMPLETED,
]);

/** The only payload fields a listing watcher receives: dates and status, never who booked or why. */
const PUBLIC_PROPERTY_FIELDS = [
  'property_id', 'check_in', 'check_out', 'start_date', 'end_date', 'status', 'new_status', 'availability_version',
];

const CHANNEL_RE = /^(user|property|task):[A-Za-z0-9_-]{1,64}$/;

/** Every push checks each connection's channels, so a connection may not hold thousands of them. */
const MAX_CHANNELS = Number(process.env.NOTIFY_MAX_CHANNELS || 50);
/** Largest client frame accepted; a subscribe list within MAX_CHANNELS is far smaller. */
const MAX_FRAME_BYTES = 16 * 1024;

/** May this signed-in user subscribe to this channel? */
function canSubscribe(user, channel) {
  if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) return false;
  const [kind, id] = channel.split(':');
  if (kind === 'user') return id === String(user.sub); // only your own
  if (kind === 'property') return true; // public listing updates, filtered in push()
  if (kind === 'task') return true; // delivery is checked against the task owner in push()
  return false;
}

/** Which channels an event goes to. Extend as new pushes are needed. */
function channelsFor(env) {
  const p = env.payload || {};
  const ch = new Set();
  if (env.event_type === TOPICS.MESSAGE_SENT) {
    // private: only the receiver, never a listing channel
    return p.receiver_id ? [`user:${p.receiver_id}`] : [];
  }
  if (p.guest_id) ch.add(`user:${p.guest_id}`);
  if (p.host_id) ch.add(`user:${p.host_id}`);
  if (p.receiver_id) ch.add(`user:${p.receiver_id}`);
  if (p.property_id && PROPERTY_EVENTS.has(env.event_type)) ch.add(`property:${p.property_id}`);
  if (env.event_type === TOPICS.AI_RESULTS && p.task_id) ch.add(`task:${p.task_id}`);
  return [...ch];
}

function publicPayload(payload) {
  const p = payload || {};
  return Object.fromEntries(PUBLIC_PROPERTY_FIELDS.filter((k) => k in p).map((k) => [k, p[k]]));
}

function createNotifier() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ status: 'ok', service: 'notification-gateway', clients: wss.clients.size }));
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_FRAME_BYTES });

  wss.on('connection', (ws, req) => {
    // A bad client frame (too big, invalid) closes that connection; without a listener the
    // error would be thrown and stop the whole gateway.
    ws.on('error', (err) => logger.warn('websocket client error', { error: err.message }));
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    try {
      ws.user = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      return ws.close(4401, 'unauthenticated');
    }
    if (!ws.user || !ws.user.sub) return ws.close(4401, 'unauthenticated');
    ws.channels = new Set([`user:${ws.user.sub}`]);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        // Channels the caller may not join are dropped silently: no frame says whether they exist.
        for (const c of [].concat(msg.subscribe || [])) {
          if (ws.channels.size >= MAX_CHANNELS) break;
          if (canSubscribe(ws.user, c)) ws.channels.add(c);
        }
        for (const c of [].concat(msg.unsubscribe || [])) {
          if (c !== `user:${ws.user.sub}`) ws.channels.delete(c);
        }
      } catch { /* ignore malformed client frames */ }
    });
  });

  function push(env) {
    const channels = channelsFor(env);
    const p = env.payload || {};
    const frame = (payload) => JSON.stringify({ type: env.event_type, trace_id: env.trace_id, sent_at: new Date().toISOString(), payload });
    const full = frame(p);
    let pub; // built only if a listing watcher needs it
    let delivered = 0;
    for (const ws of wss.clients) {
      if (ws.readyState !== 1 || !ws.channels) continue;
      const own = channels.some((c) => c.startsWith('user:') && ws.channels.has(c));
      const ownsTask = channels.some((c) => c.startsWith('task:') && ws.channels.has(c))
        && (ws.user.role === 'admin' || (p.user_id && p.user_id === ws.user.sub));
      const watching = channels.some((c) => c.startsWith('property:') && ws.channels.has(c));
      if (own || ownsTask) ws.send(full);
      else if (watching) ws.send(pub || (pub = frame(publicPayload(p))));
      else continue;
      delivered++;
    }
    return delivered;
  }

  return { server, wss, push };
}

if (require.main === module) {
  const port = Number(process.env.NOTIFY_PORT || 8009);
  const notifier = createNotifier();
  notifier.server.listen(port, () => logger.info(`notification-gateway listening on ${port}`));
  const bus = new EventBus('notification-gateway');
  bus
    .consume({ groupId: GROUP, topics: PUSHED_TOPICS, handler: async (env) => notifier.push(env) })
    .catch((err) => { logger.error('notify consumer failed', { error: err.message }); process.exit(1); });
}

module.exports = { createNotifier, channelsFor, canSubscribe, publicPayload, PUSHED_TOPICS, MAX_CHANNELS };
