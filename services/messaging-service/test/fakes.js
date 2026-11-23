// In-memory stand-ins for the Mongo stores, the MySQL directory and the Kafka bus.
// They follow the same contracts as src/models (unique thread per guest/host/property,
// dedupe on the namespaced client_message_id). Real MongoDB behaviour, including the
// indexes and concurrency, is covered in test/integration/messaging.int.js.
const { newId, validateEnvelope } = require('@airbnb/common');

function fakeStore() {
  const threads = new Map();
  const messages = new Map();
  const byDedupe = new Map();
  const cmp = (a, b) => (a.timestamp - b.timestamp) || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
  let clock = Date.parse('2030-01-01T00:00:00Z');

  return {
    threads: {
      _all: threads,
      async openThread({ guestId, hostId, propertyId, reservationId = null }) {
        let t = [...threads.values()].find((x) => x.guest_id === guestId && x.host_id === hostId && x.property_id === propertyId);
        const created = !t;
        if (!t) {
          t = { _id: newId('thr'), guest_id: guestId, host_id: hostId, property_id: propertyId, participants: [guestId, hostId], reservation_ids: [], created_at: new Date(), last_message: null };
          threads.set(t._id, t);
        }
        if (reservationId && !t.reservation_ids.includes(reservationId)) t.reservation_ids.push(reservationId);
        return { thread: structuredClone(t), created };
      },
      async findById(id) { return threads.has(id) ? structuredClone(threads.get(id)) : null; },
      async listForUser(userId, { page = 1, pageSize = 20 } = {}) {
        const mine = [...threads.values()].filter((t) => t.participants.includes(userId))
          .sort((a, b) => (b.last_message?.timestamp || 0) - (a.last_message?.timestamp || 0));
        return { rows: mine.slice((page - 1) * pageSize, page * pageSize).map((t) => structuredClone(t)), total: mine.length };
      },
      async touchLastMessage(threadId, m) {
        const t = threads.get(threadId);
        if (!t.last_message || t.last_message.timestamp < m.timestamp) {
          t.last_message = { message_id: m._id, sender_id: m.sender_id, preview: m.message_text.slice(0, 120), timestamp: m.timestamp };
        }
      },
    },
    messages: {
      _all: messages,
      async insert({ threadId, senderId, receiverId, text, dedupeKey = null, clientRef = null, reservationId = null, timestamp }) {
        if (dedupeKey && byDedupe.has(dedupeKey)) return { message: structuredClone(messages.get(byDedupe.get(dedupeKey))), created: false };
        clock += 1000;
        const m = {
          _id: newId('msg'), thread_id: threadId, sender_id: senderId, receiver_id: receiverId, message_text: text,
          timestamp: timestamp || new Date(clock), read_at: null, client_ref: clientRef, reservation_id: reservationId, notified: false,
        };
        if (dedupeKey) { m.client_message_id = dedupeKey; byDedupe.set(dedupeKey, m._id); }
        messages.set(m._id, m);
        return { message: structuredClone(m), created: true };
      },
      async findById(id) { return messages.has(id) ? structuredClone(messages.get(id)) : null; },
      async listPage(threadId, { before = null, limit = 30 } = {}) {
        let rows = [...messages.values()].filter((m) => m.thread_id === threadId).sort(cmp);
        if (before) rows = rows.filter((m) => cmp(m, before) < 0);
        const hasMore = rows.length > limit;
        const page = rows.slice(-limit).map((m) => structuredClone(m));
        return { rows: page, hasMore, nextBefore: hasMore ? page[0]._id : null };
      },
      async markRead(threadId, readerId, { upTo = null } = {}) {
        let n = 0;
        for (const m of messages.values()) {
          if (m.thread_id === threadId && m.receiver_id === readerId && !m.read_at && (!upTo || cmp(m, upTo) <= 0)) { m.read_at = new Date(); n++; }
        }
        return n;
      },
      async countUnread(threadId, readerId) {
        return [...messages.values()].filter((m) => m.thread_id === threadId && m.receiver_id === readerId && !m.read_at).length;
      },
      async claimPublish(id) {
        const m = messages.get(id);
        if (m.notified || m.leased) return false;
        m.leased = true;
        return true;
      },
      async releasePublish(id) { messages.get(id).leased = false; },
      async markNotified(id) { Object.assign(messages.get(id), { notified: true, leased: false }); },
    },
  };
}

function fakeDirectory() {
  const properties = new Map([
    ['prp_active', { property_id: 'prp_active', host_id: 'hst_1', title: 'Garden studio', status: 'active' }],
    ['prp_paused', { property_id: 'prp_paused', host_id: 'hst_1', title: 'Paused loft', status: 'inactive' }],
    ['prp_gone', { property_id: 'prp_gone', host_id: 'hst_1', title: 'Gone', status: 'deleted' }],
  ]);
  const reservations = new Map([
    ['res_1', { reservation_id: 'res_1', guest_id: 'gst_1', host_id: 'hst_1', property_id: 'prp_active', status: 'CONFIRMED' }],
  ]);
  const names = { gst_1: 'Ana G.', gst_2: 'Ben O.', hst_1: 'Hana Host', hst_2: 'Other Host' };
  return {
    properties,
    reservations,
    async findProperty(id) { return properties.get(id) || null; },
    async findReservation(id) { return reservations.get(id) || null; },
    async describe({ userIds = [], propertyIds = [] }) {
      return {
        names: Object.fromEntries(userIds.filter((u) => names[u]).map((u) => [u, names[u]])),
        titles: Object.fromEntries(propertyIds.filter((p) => properties.has(p)).map((p) => [p, properties.get(p).title])),
      };
    },
  };
}

function fakeBus() {
  const sent = [];
  return {
    sent,
    down: false,
    async publish(topic, env, key) {
      if (this.down) throw new Error('Kafka unavailable');
      const check = validateEnvelope(env, topic); // the real EventBus refuses invalid envelopes too
      if (!check.valid) throw new Error(`invalid envelope: ${check.errors.join('; ')}`);
      sent.push({ topic, env, key });
    },
  };
}

module.exports = { fakeStore, fakeDirectory, fakeBus };
