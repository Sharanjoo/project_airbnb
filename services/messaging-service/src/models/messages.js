// Data access for MongoDB `messages` (indexes in infra/mongo/init/001_init.js).
//
// Document: { _id: message_id, thread_id, sender_id, receiver_id, message_text, timestamp: Date,
//             read_at: Date | null, client_message_id: dedupe key | absent, client_ref: string | null,
//             reservation_id: string | null, notified: boolean }
//
// Duplicate protection uses the existing unique sparse index on `client_message_id`.
// The stored value is a namespaced dedupe key, never the raw client value:
//   user sends:        "<thread_id>:<sender_id>:<client_message_id>"
//   booking request:   "booking:<reservation_id>"
// so one user's id can never collide with (or reveal) another user's message, and a
// booking's first message can never collide with anything a user sends.
// `notified` is a one-flag outbox: message.sent is published until it is true, so a
// crash between the insert and the publish is repaired by the retry or redelivery.
// `publish_lease_until` makes sure only one caller at a time is publishing it.
const { newId } = require('@airbnb/common');

const DUPLICATE_KEY = 11000;
const iso = (d) => (d instanceof Date ? d.toISOString() : d || null);

const userDedupeKey = (threadId, senderId, clientMessageId) => `${threadId}:${senderId}:${clientMessageId}`;
const bookingDedupeKey = (reservationId) => `booking:${reservationId}`;

function toApi(doc) {
  if (!doc) return null;
  return {
    message_id: doc._id,
    thread_id: doc.thread_id,
    sender_id: doc.sender_id,
    receiver_id: doc.receiver_id,
    message_text: doc.message_text,
    timestamp: iso(doc.timestamp),
    read_at: iso(doc.read_at),
    client_message_id: doc.client_ref || null,
    reservation_id: doc.reservation_id || null,
  };
}

function createMessages(getDb) {
  const col = async () => (await getDb()).collection('messages');

  /**
   * Insert a message, or return the one already stored under the same dedupe key.
   * Returns { message, created }. Without a dedupe key every call inserts.
   */
  async function insert({ threadId, senderId, receiverId, text, dedupeKey = null, clientRef = null, reservationId = null, timestamp = new Date() }) {
    const doc = {
      _id: newId('msg'),
      thread_id: threadId,
      sender_id: senderId,
      receiver_id: receiverId,
      message_text: text,
      timestamp,
      read_at: null,
      client_ref: clientRef,
      reservation_id: reservationId,
      notified: false,
    };
    const c = await col();
    if (!dedupeKey) {
      await c.insertOne(doc);
      return { message: doc, created: true };
    }
    doc.client_message_id = dedupeKey;
    try {
      const res = await c.updateOne({ client_message_id: dedupeKey }, { $setOnInsert: doc }, { upsert: true });
      if (res.upsertedCount === 1) return { message: doc, created: true };
    } catch (err) {
      if (err.code !== DUPLICATE_KEY) throw err; // lost a race with the same key: fall through to read it
    }
    return { message: await c.findOne({ client_message_id: dedupeKey }), created: false };
  }

  async function findById(messageId) {
    return (await col()).findOne({ _id: messageId });
  }

  /**
   * One page of a thread, newest first from the cursor, returned oldest -> newest.
   * `before` is a message_id: only messages older than it are returned. Ties on
   * timestamp are broken by _id so no message is skipped or repeated across pages.
   */
  async function listPage(threadId, { before = null, limit = 30 } = {}) {
    const c = await col();
    const filter = { thread_id: threadId };
    if (before) {
      filter.$or = [
        { timestamp: { $lt: before.timestamp } },
        { timestamp: before.timestamp, _id: { $lt: before._id } },
      ];
    }
    const rows = await c.find(filter).sort({ timestamp: -1, _id: -1 }).limit(limit + 1).toArray();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();
    return { rows: page, hasMore, nextBefore: hasMore ? page[0]._id : null };
  }

  /** Mark messages addressed to the reader as read (all, or up to and including `upTo`). Returns how many changed. */
  async function markRead(threadId, readerId, { upTo = null, now = new Date() } = {}) {
    const filter = { thread_id: threadId, receiver_id: readerId, read_at: null };
    if (upTo) {
      filter.$or = [
        { timestamp: { $lt: upTo.timestamp } },
        { timestamp: upTo.timestamp, _id: { $lte: upTo._id } },
      ];
    }
    const res = await (await col()).updateMany(filter, { $set: { read_at: now } });
    return res.modifiedCount;
  }

  async function countUnread(threadId, readerId) {
    return (await col()).countDocuments({ thread_id: threadId, receiver_id: readerId, read_at: null });
  }

  /**
   * Take the right to publish message.sent for this message for `leaseMs`. Only one
   * caller wins while the lease is live, so concurrent duplicates (a client retrying
   * while the first request is still running, or two deliveries of one Kafka event)
   * do not announce the same message twice. If the winner crashes before
   * markNotified, the lease expires and a later retry or redelivery publishes it.
   */
  async function claimPublish(messageId, { leaseMs = 30000, now = new Date() } = {}) {
    const res = await (await col()).updateOne(
      { _id: messageId, notified: false, $or: [{ publish_lease_until: { $exists: false } }, { publish_lease_until: { $lt: now } }] },
      { $set: { publish_lease_until: new Date(now.getTime() + leaseMs) } },
    );
    return res.modifiedCount === 1;
  }

  /** The publish failed: let the next retry claim it straight away. */
  async function releasePublish(messageId) {
    await (await col()).updateOne({ _id: messageId, notified: false }, { $unset: { publish_lease_until: '' } });
  }

  async function markNotified(messageId) {
    await (await col()).updateOne({ _id: messageId }, { $set: { notified: true }, $unset: { publish_lease_until: '' } });
  }

  return { insert, findById, listPage, markRead, countUnread, claimPublish, releasePublish, markNotified };
}

module.exports = { createMessages, toApi, userDedupeKey, bookingDedupeKey };
