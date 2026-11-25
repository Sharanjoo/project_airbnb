// Data access for MongoDB `threads` (indexes in infra/mongo/init/001_init.js).
//
// One thread per (guest_id, host_id, property_id): the unique index on those three
// fields is what makes thread creation idempotent. Every booking request for the same
// listing reuses the thread and adds its reservation_id to `reservation_ids`.
//
// Document: { _id: thread_id, guest_id, host_id, property_id, participants: [guest_id, host_id],
//             reservation_ids: [], created_at: Date, last_message: null | { message_id, sender_id, preview, timestamp: Date } }
const { newId } = require('@airbnb/common');

const PREVIEW_LENGTH = 120;
const DUPLICATE_KEY = 11000;

const iso = (d) => (d instanceof Date ? d.toISOString() : d || null);

/** Mongo document -> API shape (without per-caller fields such as unread_count). */
function toApi(doc) {
  if (!doc) return null;
  return {
    thread_id: doc._id,
    guest_id: doc.guest_id,
    host_id: doc.host_id,
    property_id: doc.property_id,
    reservation_ids: doc.reservation_ids || [],
    created_at: iso(doc.created_at),
    last_message: doc.last_message
      ? { ...doc.last_message, timestamp: iso(doc.last_message.timestamp) }
      : null,
  };
}

const isParticipant = (doc, userId) => Boolean(doc && doc.participants && doc.participants.includes(userId));

/** The other person in a two-party thread. */
const counterpartOf = (doc, userId) => (doc.guest_id === userId ? doc.host_id : doc.guest_id);

function createThreads(getDb) {
  const col = async () => (await getDb()).collection('threads');

  /**
   * Create the thread for (guest, host, property) or return the existing one.
   * Returns { thread, created }. Safe under concurrency and redelivery: the unique
   * index lets exactly one upsert insert; a racing upsert that loses gets E11000
   * and simply reads the winner's document.
   */
  async function openThread({ guestId, hostId, propertyId, reservationId = null, now = new Date() }) {
    const filter = { guest_id: guestId, host_id: hostId, property_id: propertyId };
    const update = {
      $setOnInsert: {
        _id: newId('thr'),
        guest_id: guestId,
        host_id: hostId,
        property_id: propertyId,
        participants: [guestId, hostId],
        created_at: now,
        last_message: null,
      },
    };
    // reservation_ids cannot be in both $setOnInsert and $addToSet
    if (reservationId) update.$addToSet = { reservation_ids: reservationId };
    else update.$setOnInsert.reservation_ids = [];

    const c = await col();
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await c.findOneAndUpdate(filter, update, { upsert: true, returnDocument: 'after', includeResultMetadata: true });
        return { thread: res.value, created: Boolean(res.lastErrorObject && res.lastErrorObject.upserted) };
      } catch (err) {
        if (err.code !== DUPLICATE_KEY || attempt >= 2) throw err;
        // Another request inserted the same thread a moment ago: retry, which now matches it.
      }
    }
  }

  async function findById(threadId) {
    return (await col()).findOne({ _id: threadId });
  }

  /** Threads the user takes part in, most recent message first (threads without messages last). */
  async function listForUser(userId, { page = 1, pageSize = 20 } = {}) {
    const c = await col();
    const filter = { participants: userId };
    const [rows, total] = await Promise.all([
      c.find(filter)
        .sort({ 'last_message.timestamp': -1, created_at: -1, _id: 1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray(),
      c.countDocuments(filter),
    ]);
    return { rows, total };
  }

  /** Point last_message at this message unless a newer one is already there. */
  async function touchLastMessage(threadId, message) {
    const last = {
      message_id: message._id,
      sender_id: message.sender_id,
      preview: message.message_text.slice(0, PREVIEW_LENGTH),
      timestamp: message.timestamp,
    };
    await (await col()).updateOne(
      {
        _id: threadId,
        $or: [{ last_message: null }, { 'last_message.timestamp': { $lt: message.timestamp } },
          { 'last_message.timestamp': message.timestamp, 'last_message.message_id': { $lt: message._id } }],
      },
      { $set: { last_message: last } },
    );
  }

  return { openThread, findById, listForUser, touchLastMessage };
}

module.exports = { createThreads, toApi, isParticipant, counterpartOf, PREVIEW_LENGTH };
