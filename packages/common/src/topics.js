// Topic names in one place. Must match infra/kafka/topics.txt (test/topics.test.js checks it).
const TOPICS = Object.freeze({
  USER_CREATED: 'user.created',
  USER_UPDATED: 'user.updated',
  PROPERTY_CREATED: 'property.created',
  PROPERTY_UPDATED: 'property.updated',
  PROPERTY_VIEWED: 'property.viewed',
  PROPERTY_SAVED: 'property.saved',
  AVAILABILITY_CHANGED: 'availability.changed',
  BOOKING_REQUESTED: 'booking.requested',
  BOOKING_APPROVED: 'booking.approved',
  BOOKING_DECLINED: 'booking.declined',
  BOOKING_CANCEL_REQUESTED: 'booking.cancel_requested',
  BOOKING_CONFIRMED: 'booking.confirmed',
  BOOKING_REJECTED: 'booking.rejected',
  BOOKING_CANCELLED: 'booking.cancelled',
  BOOKING_COMPLETED: 'booking.completed',
  PAYMENT_COMPLETED: 'payment.completed',
  MESSAGE_SENT: 'message.sent',
  REVIEW_CREATED: 'review.created',
  REVIEW_RESPONDED: 'review.responded',
  AI_REQUESTS: 'ai.requests',
  DEBATE_ROUND_0: 'debate.round.0',
  DEBATE_ROUND_1: 'debate.round.1',
  DEBATE_ROUND_2: 'debate.round.2',
  AI_RESULTS: 'ai.results',
  AI_APPROVALS: 'ai.approvals',
});

const dlqTopic = (topic) => `${topic}.dlq`;

module.exports = { TOPICS, dlqTopic };
