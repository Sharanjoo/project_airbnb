// Messaging Service (API doc §6). Owner: Slice 1. Data in MongoDB threads/messages.
// Pattern: validateBody(schema) -> participant check -> model call -> publish -> ok(res, data).
//
// Access rule for every endpoint: a thread is visible only to its two participants
// (thread.participants holds the guest id and the host id). Being an admin does not
// open other people's conversations. A thread the caller is not in answers 404, the
// same as a thread that does not exist, so ids cannot be probed.
const express = require('express');
const Joi = require('joi');
const {
  asyncHandler, validateBody, requireRole, ok, Errors, logger,
} = require('@airbnb/common');
const { createStore } = require('./models');
const defaultDirectory = require('./models/directory');
const threadModel = require('./models/threads');
const messageModel = require('./models/messages');
const { deliver } = require('./delivery');

const threadId = Joi.string().pattern(/^thr_[A-Za-z0-9]{1,40}$/);
const messageId = Joi.string().pattern(/^msg_[A-Za-z0-9]{1,40}$/);

const openSchema = Joi.object({
  property_id: Joi.string().max(64),
  reservation_id: Joi.string().max(100),
}).xor('property_id', 'reservation_id');
const getSchema = Joi.object({ thread_id: threadId.required() });
const byUserSchema = Joi.object({
  user_id: Joi.string().max(64), // optional; when given it must be the caller
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number().integer().min(1).max(50).default(20),
});
const listSchema = Joi.object({
  thread_id: threadId.required(),
  before: messageId, // cursor: the oldest message_id the client already has
  limit: Joi.number().integer().min(1).max(100).default(30),
});
const sendSchema = Joi.object({
  thread_id: threadId.required(), // was any string; bounded like the other endpoints

  message_text: Joi.string().trim().min(1).max(2000).required(),
  client_message_id: Joi.string().max(64),
});
const markReadSchema = Joi.object({
  thread_id: threadId.required(),
  up_to_message_id: messageId,
});

const actorType = (role) => (role === 'admin' ? 'admin' : role);

function buildRouter({ bus, store = createStore(), directory = defaultDirectory }) {
  const r = express.Router();
  const participant = requireRole('guest', 'host');

  /** The thread, if the caller takes part in it; otherwise 404 (never reveal that it exists). */
  async function loadOwnThread(req, id) {
    const doc = await store.threads.findById(id);
    if (!threadModel.isParticipant(doc, req.user.id)) throw Errors.notFound('Thread');
    return doc;
  }

  /** Thread as the caller sees it: who they are talking to, the listing title, unread count. */
  async function present(docs, userId) {
    const counterparts = docs.map((d) => threadModel.counterpartOf(d, userId));
    const [{ names, titles }, unread] = await Promise.all([
      directory.describe({ userIds: [...new Set(counterparts)], propertyIds: [...new Set(docs.map((d) => d.property_id))] }),
      Promise.all(docs.map((d) => store.messages.countUnread(d._id, userId))),
    ]);
    return docs.map((d, i) => ({
      ...threadModel.toApi(d),
      property_title: titles[d.property_id] || null,
      counterpart: { user_id: counterparts[i], name: names[counterparts[i]] || null },
      unread_count: unread[i],
    }));
  }

  // ---- open: a guest asking about a listing, or either side of a reservation
  r.post('/threads/open', participant, validateBody(openSchema), asyncHandler(async (req, res) => {
    const { id, role } = req.user;
    let link;
    if (req.body.reservation_id) {
      const resv = await directory.findReservation(req.body.reservation_id);
      // Not found and "not yours" look the same, like threads themselves
      if (!resv || (resv.guest_id !== id && resv.host_id !== id)) throw Errors.notFound('Reservation');
      link = { guestId: resv.guest_id, hostId: resv.host_id, propertyId: resv.property_id, reservationId: resv.reservation_id };
    } else {
      if (role !== 'guest') throw Errors.forbidden('Only guests can contact a host about a listing; hosts reply in existing threads.');
      const prop = await directory.findProperty(req.body.property_id);
      if (!prop || prop.status === 'deleted') throw Errors.notFound('Property');
      if (prop.status !== 'active') throw Errors.gone();
      link = { guestId: id, hostId: prop.host_id, propertyId: prop.property_id };
    }
    const { thread, created } = await store.threads.openThread(link);
    const [view] = await present([thread], id);
    return ok(res, view, created ? 201 : 200);
  }));

  r.post('/threads/get', participant, validateBody(getSchema), asyncHandler(async (req, res) => {
    const doc = await loadOwnThread(req, req.body.thread_id);
    const [view] = await present([doc], req.user.id);
    return ok(res, view);
  }));

  // ---- the caller's conversations, newest activity first
  r.post('/threads/byUser', participant, validateBody(byUserSchema), asyncHandler(async (req, res) => {
    const { user_id: userId, page, page_size: pageSize } = req.body;
    if (userId && userId !== req.user.id) throw Errors.forbidden('You can only list your own conversations.');
    const { rows, total } = await store.threads.listForUser(req.user.id, { page, pageSize });
    return ok(res, { items: await present(rows, req.user.id), page, page_size: pageSize, total });
  }));

  // ---- history, cursor paginated (stable while new messages arrive)
  r.post('/messages/list', participant, validateBody(listSchema), asyncHandler(async (req, res) => {
    const doc = await loadOwnThread(req, req.body.thread_id);
    let before = null;
    if (req.body.before) {
      before = await store.messages.findById(req.body.before);
      if (!before || before.thread_id !== doc._id) throw Errors.validation([{ field: 'before', issue: 'not a message in this thread' }]);
    }
    const { rows, hasMore, nextBefore } = await store.messages.listPage(doc._id, { before, limit: req.body.limit });
    return ok(res, { items: rows.map(messageModel.toApi), has_more: hasMore, next_before: nextBefore });
  }));

  // ---- send. A repeat with the same client_message_id returns the stored message (200)
  //      instead of creating a second one, and never publishes twice.
  r.post('/messages/send', participant, validateBody(sendSchema), asyncHandler(async (req, res) => {
    const { thread_id: tid, message_text: text, client_message_id: clientRef } = req.body;
    const doc = await loadOwnThread(req, tid);
    const senderId = req.user.id;
    const { message, created } = await store.messages.insert({
      threadId: doc._id,
      senderId,
      receiverId: threadModel.counterpartOf(doc, senderId),
      text,
      dedupeKey: clientRef ? messageModel.userDedupeKey(doc._id, senderId, clientRef) : null,
      clientRef: clientRef || null,
    });
    if (!created && message.message_text !== text) {
      throw Errors.conflict('IDEMPOTENCY_KEY_REUSED', 'client_message_id was already used for a different message.', [
        { field: 'client_message_id', issue: 'already used' },
      ]);
    }
    try {
      await deliver({ bus, store, message, traceId: req.traceId, actorId: senderId, actorType: actorType(req.user.role) });
    } catch (err) {
      // Stored but not announced: the client retries with the same client_message_id,
      // which finds the stored message and publishes it then.
      logger.error('message.sent publish failed', { trace_id: req.traceId, message_id: message._id, error: err.message });
      throw Errors.dependency('Kafka');
    }
    return ok(res, messageModel.toApi(message), created ? 201 : 200);
  }));

  r.post('/messages/markRead', participant, validateBody(markReadSchema), asyncHandler(async (req, res) => {
    const doc = await loadOwnThread(req, req.body.thread_id);
    let upTo = null;
    if (req.body.up_to_message_id) {
      upTo = await store.messages.findById(req.body.up_to_message_id);
      if (!upTo || upTo.thread_id !== doc._id) throw Errors.validation([{ field: 'up_to_message_id', issue: 'not a message in this thread' }]);
    }
    const marked = await store.messages.markRead(doc._id, req.user.id, { upTo });
    const unread = await store.messages.countUnread(doc._id, req.user.id);
    return ok(res, { thread_id: doc._id, marked_read: marked, unread_count: unread });
  }));

  return r;
}

module.exports = { buildRouter, sendSchema };
