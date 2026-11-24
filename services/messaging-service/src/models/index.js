// Default stores on the shared MongoDB client. Tests build their own with createStore(getDb).
const { getMongo } = require('@airbnb/common');
const { createThreads } = require('./threads');
const { createMessages } = require('./messages');

const createStore = (getDb = getMongo) => ({ threads: createThreads(getDb), messages: createMessages(getDb) });

module.exports = { createStore };
