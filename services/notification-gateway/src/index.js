// Notification gateway: turns Kafka events into WebSocket pushes (13.4).
// Client connects to ws://host:8009/ws?token=<JWT> and sends
//   { "subscribe": ["user:gst_0001", "property:prp_0001"] }
// Every Kafka event is pushed to channels derived from its payload.
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'notification-gateway';
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { EventBus, TOPICS, logger } = require('@airbnb/common');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-dev-secret';
const GROUP = 'notify-cg';

const PUSHED_TOPICS = [
  TOPICS.BOOKING_CONFIRMED, TOPICS.BOOKING_REJECTED, TOPICS.BOOKING_CANCELLED, TOPICS.BOOKING_COMPLETED,
  TOPICS.AVAILABILITY_CHANGED, TOPICS.MESSAGE_SENT, TOPICS.AI_RESULTS,
];

/** Which channels an event goes to. Extend as new pushes are needed. */
function channelsFor(env) {
  const p = env.payload || {};
  const ch = new Set();
  if (p.guest_id) ch.add(`user:${p.guest_id}`);
  if (p.host_id) ch.add(`user:${p.host_id}`);
  if (p.receiver_id) ch.add(`user:${p.receiver_id}`);
  if (p.property_id) ch.add(`property:${p.property_id}`);
  if (env.event_type === TOPICS.AI_RESULTS && p.task_id) ch.add(`task:${p.task_id}`);
  return [...ch];
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
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const token = new URL(req.url, 'http://x').searchParams.get('token');
    try {
      ws.user = jwt.verify(token, JWT_SECRET);
    } catch {
      return ws.close(4401, 'unauthenticated');
    }
    ws.channels = new Set([`user:${ws.user.sub}`]);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        // TODO (slice 4): authorize channels (a user may only join their own user:* channel)
        for (const c of msg.subscribe || []) ws.channels.add(c);
        for (const c of msg.unsubscribe || []) ws.channels.delete(c);
      } catch { /* ignore malformed client frames */ }
    });
  });

  function push(env) {
    const channels = channelsFor(env);
    const frame = JSON.stringify({ type: env.event_type, trace_id: env.trace_id, sent_at: new Date().toISOString(), payload: env.payload });
    let delivered = 0;
    for (const ws of wss.clients) {
      if (ws.readyState === 1 && channels.some((c) => ws.channels.has(c))) {
        ws.send(frame);
        delivered++;
      }
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

module.exports = { createNotifier, channelsFor };
