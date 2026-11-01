const { randomUUID } = require('crypto');

// Readable, type-prefixed ids: gst_, hst_, prp_, res_, thr_, msg_, rev_, avl_, tsk_
function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

module.exports = { newId, uuid: randomUUID };
