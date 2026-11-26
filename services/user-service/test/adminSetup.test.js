process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4';
// Admin setup (npm run admin:create) with an in-memory repo: every outcome, the refusals,
// the hidden password prompt and that nothing secret is ever printed.
// The same flows against the real MySQL are in test/integration/admin.int.js.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { ensureAdmin, AdminSetupError, DEFAULT_EMAIL } = require('../src/adminSetup');
const { main, describeError } = require('../../../scripts/create-admin');

const newPassword = () => `Adm-${randomBytes(9).toString('base64url')}`; // generated, never a fixed secret

function fakeRepo({ hosts = [], guests = [] } = {}) {
  const rows = new Map(hosts.map((h) => [h.email, { is_deleted: 0, ...h }]));
  const calls = { insert: 0, update: 0 };
  return {
    rows,
    calls,
    raceWith: null, // set to a row to simulate another writer taking the email first
    async findHost(email) { return rows.get(email) || null; },
    async activeGuestExists(email) { return guests.includes(email); },
    async insertAdmin(h) {
      calls.insert += 1;
      if (this.raceWith) {
        rows.set(h.email, this.raceWith);
        throw Object.assign(new Error(`Duplicate entry '${h.email}' for key 'hosts.uq_hosts_email'`), { code: 'ER_DUP_ENTRY' });
      }
      if (rows.has(h.email)) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      rows.set(h.email, { ...h, access_level: 'admin', is_deleted: 0, version: 1 });
    },
    async updateAdminPassword(hostId, hash) {
      calls.update += 1;
      const row = [...rows.values()].find((r) => r.host_id === hostId && r.access_level === 'admin' && !r.is_deleted);
      if (!row) return false;
      Object.assign(row, { password_hash: hash, version: (row.version || 1) + 1 });
      return true;
    },
  };
}

const admin = (over) => ({ host_id: 'hst_admin1', email: DEFAULT_EMAIL, access_level: 'admin', password_hash: 'old-hash', version: 1, ...over });
const once = (value) => { let n = 0; const fn = async () => { n += 1; return value; }; fn.count = () => n; return fn; };
const neverAsked = () => { throw new Error('the password should not be asked for'); };

// ---------------------------------------------------------------- ensureAdmin

test('no account: creates an admin host with a bcrypt hash of the supplied password', async () => {
  const repo = fakeRepo();
  const password = newPassword();
  const r = await ensureAdmin({ email: DEFAULT_EMAIL, name: 'Staybook Admin', getPassword: once(password) }, { repo });
  assert.strictEqual(r.outcome, 'created');
  assert.match(r.host_id, /^hst_[0-9a-f]{32}$/);
  const row = repo.rows.get(DEFAULT_EMAIL);
  assert.strictEqual(row.access_level, 'admin');
  assert.ok(await bcrypt.compare(password, row.password_hash));
  assert.ok(!JSON.stringify(r).includes(password) && !JSON.stringify(r).includes(row.password_hash), 'result carries no secret');
});

test('email is normalised like sign-up (trimmed, lower case)', async () => {
  const repo = fakeRepo();
  const r = await ensureAdmin({ email: '  Admin@Staybook.TEST ', name: 'A', getPassword: once(newPassword()) }, { repo });
  assert.strictEqual(r.email, 'admin@staybook.test');
  assert.ok(repo.rows.has('admin@staybook.test'));
});

test('repeat run: an existing admin is left untouched and no password is asked for', async () => {
  const repo = fakeRepo({ hosts: [admin()] });
  const r = await ensureAdmin({ email: DEFAULT_EMAIL, name: 'X', getPassword: neverAsked }, { repo });
  assert.deepStrictEqual(r, { outcome: 'exists', host_id: 'hst_admin1', email: DEFAULT_EMAIL });
  assert.deepStrictEqual(repo.calls, { insert: 0, update: 0 });
  assert.strictEqual(repo.rows.get(DEFAULT_EMAIL).password_hash, 'old-hash');
});

test('resetPassword: replaces only the admin hash and bumps the version', async () => {
  const repo = fakeRepo({ hosts: [admin()] });
  const password = newPassword();
  const r = await ensureAdmin({ email: DEFAULT_EMAIL, name: 'X', resetPassword: true, getPassword: once(password) }, { repo });
  assert.strictEqual(r.outcome, 'password_reset');
  const row = repo.rows.get(DEFAULT_EMAIL);
  assert.ok(await bcrypt.compare(password, row.password_hash));
  assert.strictEqual(row.version, 2);
});

test('an ordinary host with the email is never promoted, even with resetPassword', async () => {
  for (const level of ['standard', 'superhost']) {
    for (const resetPassword of [false, true]) {
      const repo = fakeRepo({ hosts: [admin({ host_id: 'hst_0009', access_level: level })] });
      await assert.rejects(
        ensureAdmin({ email: DEFAULT_EMAIL, name: 'X', resetPassword, getPassword: neverAsked }, { repo }),
        (e) => e instanceof AdminSetupError && e.code === 'HOST_NOT_ADMIN' && e.kind === 'refused',
      );
      assert.deepStrictEqual(repo.calls, { insert: 0, update: 0 });
      assert.strictEqual(repo.rows.get(DEFAULT_EMAIL).access_level, level);
      assert.strictEqual(repo.rows.get(DEFAULT_EMAIL).password_hash, 'old-hash');
    }
  }
});

test('a deleted host (even a deleted admin) is never revived', async () => {
  for (const level of ['standard', 'admin']) {
    const repo = fakeRepo({ hosts: [admin({ access_level: level, is_deleted: 1 })] });
    await assert.rejects(
      ensureAdmin({ email: DEFAULT_EMAIL, name: 'X', resetPassword: true, getPassword: neverAsked }, { repo }),
      (e) => e.code === 'HOST_DELETED',
    );
    assert.deepStrictEqual(repo.calls, { insert: 0, update: 0 });
  }
});

test('an active guest with the email is refused (login would be ambiguous)', async () => {
  const repo = fakeRepo({ guests: [DEFAULT_EMAIL] });
  await assert.rejects(ensureAdmin({ email: DEFAULT_EMAIL, name: 'X', getPassword: neverAsked }, { repo }), (e) => e.code === 'EMAIL_USED_BY_GUEST');
  assert.strictEqual(repo.calls.insert, 0);
});

test('weak or over-long passwords are refused before anything is written', async () => {
  for (const bad of ['', 'short', 'elevenchars', 'é'.repeat(37)]) { // 'é' is 2 bytes: 74 bytes > 72
    const repo = fakeRepo();
    await assert.rejects(ensureAdmin({ email: DEFAULT_EMAIL, name: 'X', getPassword: once(bad) }, { repo }), (e) => e.code === 'INVALID_PASSWORD' && e.kind === 'invalid');
    assert.strictEqual(repo.calls.insert, 0);
  }
});

test('invalid email or name -> INVALID_INPUT, nothing read or written', async () => {
  for (const input of [{ email: 'not-an-email', name: 'X' }, { email: DEFAULT_EMAIL, name: '  ' }]) {
    const repo = fakeRepo();
    await assert.rejects(ensureAdmin({ ...input, getPassword: neverAsked }, { repo }), (e) => e.code === 'INVALID_INPUT');
    assert.strictEqual(repo.calls.insert, 0);
  }
});

test('race: another run creates the admin first -> exists; an ordinary host first -> refused', async () => {
  const repo = fakeRepo();
  repo.raceWith = admin({ host_id: 'hst_winner' });
  const r = await ensureAdmin({ email: DEFAULT_EMAIL, name: 'X', getPassword: once(newPassword()) }, { repo });
  assert.deepStrictEqual(r, { outcome: 'exists', host_id: 'hst_winner', email: DEFAULT_EMAIL });

  const repo2 = fakeRepo();
  repo2.raceWith = admin({ host_id: 'hst_signup', access_level: 'standard' });
  await assert.rejects(ensureAdmin({ email: DEFAULT_EMAIL, name: 'X', getPassword: once(newPassword()) }, { repo: repo2 }), (e) => e.code === 'HOST_NOT_ADMIN');
});

test('resetPassword when the row stops being an admin mid-run -> CHANGED_CONCURRENTLY', async () => {
  const repo = fakeRepo({ hosts: [admin()] });
  const getPassword = async () => { repo.rows.get(DEFAULT_EMAIL).access_level = 'standard'; return newPassword(); };
  await assert.rejects(ensureAdmin({ email: DEFAULT_EMAIL, name: 'X', resetPassword: true, getPassword }, { repo }), (e) => e.code === 'CHANGED_CONCURRENTLY');
  assert.strictEqual(repo.rows.get(DEFAULT_EMAIL).password_hash, 'old-hash');
});

// ---------------------------------------------------------------- the command (scripts/create-admin.js)

function sink() { let text = ''; return { write(s) { text += s; return true; }, get text() { return text; } }; }

/** A fake terminal: answers each prompt with the next line, as typed characters. */
function fakeTty(lines) {
  const tty = new EventEmitter();
  Object.assign(tty, {
    isTTY: true,
    rawModes: [],
    setRawMode(on) { this.rawModes.push(on); },
    setEncoding() {},
    pause() {},
    resume() { const line = lines.shift(); if (line !== undefined) setImmediate(() => this.emit('data', `${line}\r`)); },
  });
  return tty;
}

const run = (opts) => {
  const stdout = sink();
  const stderr = sink();
  return main({ argv: [], env: {}, stdin: { isTTY: false }, stdout, stderr, ...opts })
    .then((code) => ({ code, out: stdout.text, err: stderr.text }));
};

test('command: prompts twice without echoing, creates the admin, prints no secret', async () => {
  const repo = fakeRepo();
  const password = newPassword();
  const tty = fakeTty([password, password]);
  const r = await run({ repo, stdin: tty });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /^Created admin hst_[0-9a-f]{32} \(admin@staybook\.test\)\./);
  assert.match(r.out, /"Host" selected/);
  const hash = repo.rows.get(DEFAULT_EMAIL).password_hash;
  for (const secret of [password, hash]) assert.ok(!r.out.includes(secret) && !r.err.includes(secret), 'secret never printed');
  assert.match(r.err, /Admin password .*not shown/);
  assert.deepStrictEqual(tty.rawModes, [true, false, true, false], 'raw mode on while typing, restored after');
});

test('command: mismatched passwords -> exit 1, nothing written', async () => {
  const repo = fakeRepo();
  const r = await run({ repo, stdin: fakeTty([newPassword(), newPassword()]) });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /PASSWORD_MISMATCH/);
  assert.strictEqual(repo.calls.insert, 0);
});

test('command: ADMIN_PASSWORD and ADMIN_EMAIL from the environment; still prints no secret', async () => {
  const repo = fakeRepo();
  const password = newPassword();
  const r = await run({ repo, env: { ADMIN_PASSWORD: password, ADMIN_EMAIL: 'ops@staybook.test', ADMIN_NAME: 'Ops' } });
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(repo.rows.has('ops@staybook.test'));
  assert.ok(!r.out.includes(password) && !r.err.includes(password));
});

test('command: repeat run exits 0 without asking for a password', async () => {
  const r = await run({ repo: fakeRepo({ hosts: [admin()] }), stdin: { isTTY: true, setRawMode() { throw new Error('prompted'); } } });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /already exists, nothing changed/);
  assert.match(r.out, /--reset-password/);
});

test('command: --reset-password says old sessions stay valid until their tokens expire', async () => {
  const repo = fakeRepo({ hosts: [admin()] });
  const r = await run({ repo, argv: ['--reset-password'], env: { ADMIN_PASSWORD: newPassword() } });
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, /Password changed for admin hst_admin1/);
  assert.match(r.out, /stay valid until their tokens expire/);
});

test('command: no terminal and no ADMIN_PASSWORD -> exit 1 at once, nothing written', async () => {
  const repo = fakeRepo();
  const r = await run({ repo });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /NO_PASSWORD/);
  assert.strictEqual(repo.calls.insert, 0);
});

test('command: refusals exit 2 with the reason; ordinary host stays ordinary', async () => {
  const repo = fakeRepo({ hosts: [admin({ host_id: 'hst_0001', access_level: 'superhost' })] });
  const r = await run({ repo, env: { ADMIN_PASSWORD: newPassword() } });
  assert.strictEqual(r.code, 2);
  assert.match(r.err, /HOST_NOT_ADMIN: An ordinary host account \(hst_0001\)/);
  assert.strictEqual(repo.rows.get(DEFAULT_EMAIL).access_level, 'superhost');
});

test('command: --help exits 0; an unknown option exits 1 before touching the database', async () => {
  const repo = fakeRepo();
  assert.strictEqual((await run({ repo, argv: ['--help'] })).code, 0);
  const r = await run({ repo, argv: ['--promote'] });
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /Unknown option: --promote/);
});

test('errors are reduced to one line: no SQL, parameters or stack', () => {
  const err = Object.assign(new Error('boom'), { code: 'ER_SOMETHING', sql: "INSERT ... VALUES ('<password hash>')", stack: 'at x' });
  const line = describeError(err, {});
  assert.strictEqual(line, 'ER_SOMETHING: setup failed. Nothing was printed about the password.');
  assert.match(describeError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), {}), /cannot reach MySQL at localhost:3307/);
});
