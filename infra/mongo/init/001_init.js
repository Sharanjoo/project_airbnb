// MongoDB collections and indexes: flexible documents, messages, reviews, traces, AI debate.
// Runs automatically the first time the mongo container starts (empty volume).
const adb = db.getSiblingDB('airbnb');

// Messaging
adb.createCollection('threads');
adb.threads.createIndex({ guest_id: 1, host_id: 1, property_id: 1 }, { unique: true });
adb.threads.createIndex({ participants: 1, 'last_message.timestamp': -1 });

adb.createCollection('messages');
adb.messages.createIndex({ thread_id: 1, timestamp: -1 });
adb.messages.createIndex({ client_message_id: 1 }, { unique: true, sparse: true });

// Reviews
adb.createCollection('reviews');
adb.reviews.createIndex({ reservation_id: 1 }, { unique: true });
adb.reviews.createIndex({ property_id: 1, created_datetime: -1 });
adb.reviews.createIndex({ host_id: 1 });

// Analytics and observability
adb.createCollection('events');
adb.events.createIndex({ event_id: 1 }, { unique: true });
adb.events.createIndex({ event_type: 1, timestamp: -1 });
adb.events.createIndex({ trace_id: 1 });

adb.createCollection('traces');
adb.traces.createIndex({ trace_id: 1, timestamp: 1 });
adb.traces.createIndex({ service: 1, timestamp: -1 });

// AI agent service
adb.createCollection('ai_tasks');
adb.ai_tasks.createIndex({ task_id: 1 }, { unique: true });
adb.ai_tasks.createIndex({ trace_id: 1 }, { unique: true });
adb.ai_tasks.createIndex({ status: 1, updated_at: -1 });

adb.createCollection('debate_messages');
adb.debate_messages.createIndex({ trace_id: 1, round: 1, agent: 1 });
adb.debate_messages.createIndex({ event_id: 1 }, { unique: true });

adb.createCollection('feedback');
adb.feedback.createIndex({ trace_id: 1 });

adb.createCollection('agent_versions');
adb.agent_versions.createIndex({ version_id: 1 }, { unique: true });
adb.agent_versions.insertOne({
  version_id: 'matcher-v1',
  parent_version: null,
  description: 'Initial weights',
  status: 'promoted',
  created_at: new Date(),
});

print('airbnb Mongo collections and indexes created');
