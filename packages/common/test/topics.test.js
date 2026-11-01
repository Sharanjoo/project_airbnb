const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { TOPICS } = require('../src/topics');

test('topics.js matches infra/kafka/topics.txt', () => {
  const file = fs.readFileSync(path.join(__dirname, '../../../infra/kafka/topics.txt'), 'utf8');
  const fromFile = file
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0])
    .sort();
  assert.deepStrictEqual(Object.values(TOPICS).sort(), fromFile);
});
