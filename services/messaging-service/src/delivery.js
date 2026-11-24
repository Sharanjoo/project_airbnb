// After a message is stored: move the thread's last_message and publish message.sent.
// Shared by POST /messages/send and the booking.requested consumer.
//
// message.sent payload carries ids only, never the text:
//   { message_id, thread_id, sender_id, receiver_id, timestamp }
// The notification gateway pushes every payload verbatim to the channels it derives
// from the payload's ids (receiver_id -> user:<receiver>; property_id -> property:<id>,
// which any signed-in user can join). So the payload deliberately has no message_text,
// no preview and no property_id / guest_id / host_id. A client that gets the push
// fetches the text through /messages/list, where participant checks apply.
const { createEnvelope, TOPICS } = require('@airbnb/common');

const iso = (d) => (d instanceof Date ? d.toISOString() : d);

function messageSentEnvelope(message, { traceId, actorId, actorType }) {
  return createEnvelope({
    eventType: TOPICS.MESSAGE_SENT,
    traceId,
    actorId,
    actorType,
    entityType: 'message',
    entityId: message._id,
    idempotencyKey: `message:${message._id}`, // same key on every republish of this message
    payload: {
      message_id: message._id,
      thread_id: message.thread_id,
      sender_id: message.sender_id,
      receiver_id: message.receiver_id,
      timestamp: iso(message.timestamp),
    },
  });
}

/**
 * Idempotent: last_message only moves forward, and message.sent is published until
 * the message is flagged `notified`, by one lease holder at a time. Throws if Kafka
 * is down, leaving the flag unset so the caller's retry (client resend with the same
 * client_message_id, or Kafka redelivery of booking.requested) publishes it.
 */
async function deliver({ bus, store, message, traceId, actorId, actorType }) {
  await store.threads.touchLastMessage(message.thread_id, message);
  if (message.notified) return 'already_published';
  // A concurrent duplicate may be publishing right now: only the lease holder does it.
  if (!(await store.messages.claimPublish(message._id))) return 'publishing_elsewhere';
  try {
    await bus.publish(TOPICS.MESSAGE_SENT, messageSentEnvelope(message, { traceId, actorId, actorType }), message.thread_id);
  } catch (err) {
    await store.messages.releasePublish(message._id).catch(() => {});
    throw err;
  }
  await store.messages.markNotified(message._id);
  return 'published';
}

module.exports = { deliver, messageSentEnvelope };
