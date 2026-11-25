import test from 'node:test';
import assert from 'node:assert/strict';
import { openStream } from '../src/pages/guest/ai/stream.js';

const tick = () => new Promise((r) => setImmediate(r));

function setup(check = async () => {}) {
  const sockets = [], links = [], frames = [], timers = [], checks = [];
  class WS {
    constructor(url) { this.url = url; sockets.push(this); }
    close() { this.closed = true; }
  }
  const close = openStream({
    taskId: 't1', token: 'a b', base: 'ws://h', check, WS, onFrame: (f) => frames.push(f), onLink: (l) => links.push(l),
    wait: (fn, ms) => { const t = { fn, ms }; (ms === 10000 ? checks : timers).push(t); return t; }, cancel: () => {},
  });
  return { sockets, links, frames, timers, checks, close };
}

test('reconnects after the last frame it received', async () => {
  const t = setup();
  await tick();
  assert.match(t.sockets[0].url, /^ws:\/\/h\/api\/v1\/ai\/ai\/tasks\/t1\/stream\?token=a%20b&after=0$/);
  t.sockets[0].onmessage({ data: JSON.stringify({ seq: 4, type: 'status' }) });
  t.sockets[0].onmessage({ data: 'not json' });
  t.sockets[0].onclose({ code: 1006 });
  assert.equal(t.timers[0].ms, 1000);
  t.timers[0].fn();
  await tick();
  assert.match(t.sockets[1].url, /after=4$/);
  assert.equal(t.frames.length, 1);
});

test('backs off and caps the wait', async () => {
  const t = setup(async () => { throw Object.assign(new Error('down'), { status: 503 }); });
  for (let i = 0; i < 6; i += 1) {
    await tick();
    t.timers[i]?.fn();
  }
  await tick();
  assert.deepEqual(t.timers.slice(0, 5).map((x) => x.ms), [1000, 2000, 4000, 8000, 8000]);
});

test('a check that never answers is given up and retried', async () => {
  const t = setup(() => new Promise(() => {}));
  await tick();
  t.checks[0].fn();
  await tick();
  assert.equal(t.links.at(-1).state, 'waiting');
  assert.equal(t.timers[0].ms, 1000);
});

test('does not retry a finished task or a refused one', async () => {
  for (const [code, state] of [[1000, 'closed'], [4401, 'failed'], [4403, 'failed'], [4404, 'failed']]) {
    const t = setup();
    await tick();
    t.sockets[0].onclose({ code });
    assert.equal(t.links.at(-1).state, state);
    assert.equal(t.timers.length, 0);
  }
  const t = setup(async () => { throw Object.assign(new Error('no'), { status: 403 }); });
  await tick();
  assert.equal(t.links.at(-1).state, 'failed');
  assert.equal(t.sockets.length, 0);
});

test('close() stops everything', async () => {
  const t = setup();
  await tick();
  t.close();
  t.sockets[0].onmessage({ data: '{"seq":1}' });
  t.sockets[0].onclose({ code: 1006 });
  assert.equal(t.sockets[0].closed, true);
  assert.equal(t.frames.length + t.timers.length, 0);
});
