// Admin setup (npm run admin:create) against the real MySQL from docker compose.
//   npm run infra:up   then   npm run test:db -w services/user-service
// Every test uses its own throwaway email domain; the real admin account is never touched.
process.env.NODE_ENV = 'test';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { createApp, logger, getMysql, getRedis } = require('@airbnb/common');
const { buildRouter } = require('../../src/routes');
const { ensureAdmin } = require('../../src/adminSetup');
const { createAccountStatus } = require('../../../gateway/src/accountStatus');

const DOMAIN = `admin-${Date.now()}.example.com`;
const ROOT = path.resolve(__dirname, '../../../..');
const db = () => getMysql();
const newPassword = () => `Adm-${randomBytes(9).toString('base64url')}`;
let server;
let base;

test.before(() => {
  const app = createApp({ name: 'user-int-admin', logger });
  app.use(buildRouter({ bus: { publish: async () => {} } }));
  app.finalize();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  server.close();
  const like = `%@${DOMAIN}`;
  await db().execute('DELETE FROM hosts WHERE email LIKE ?', [like]);
  await db().execute('DELETE FROM guests WHERE email LIKE ?', [like]);
  await db().end();
  await getRedis().quit().catch(() => {});
});

const call = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const login = (email, password, role) => call('/auth/login', { email, password, ...(role ? { role } : {}) });
const hostRow = async (email) => (await db().execute('SELECT host_id, access_level, password_hash, version, is_deleted, verification_status FROM hosts WHERE email = ?', [email]))[0][0];
const setup = (email, password, extra = {}) => ensureAdmin({ email, name: 'Int Admin', getPassword: async () => password, ...extra });

/** Run the real command in a child process (no terminal), like a teammate would. */
function runCommand(args, env) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(ROOT, 'scripts/create-admin.js'), ...args], {
      cwd: ROOT, env: { ...process.env, ADMIN_PASSWORD: '', ...env }, timeout: 20000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout, err: stderr }));
    child.stdin.end(); // a pipe, not a TTY
  });
}

test('first run creates the admin; login as Host gives role "admin"; repeat run changes nothing', async () => {
  const email = `first@${DOMAIN}`;
  const password = newPassword();
  const created = await setup(email, password);
  assert.strictEqual(created.outcome, 'created');
  const row = await hostRow(email);
  assert.deepStrictEqual(
    { access_level: row.access_level, version: row.version, is_deleted: row.is_deleted, verification_status: row.verification_status },
    { access_level: 'admin', version: 1, is_deleted: 0, verification_status: 'verified' },
  );

  const again = await setup(email, newPassword()); // a different password must NOT be applied
  assert.deepStrictEqual(again, { outcome: 'exists', host_id: created.host_id, email });
  const after = await hostRow(email);
  assert.strictEqual(after.password_hash, row.password_hash);
  assert.strictEqual(after.version, 1);
  const [[{ n }]] = await db().execute('SELECT COUNT(*) AS n FROM hosts WHERE email = ?', [email]);
  assert.strictEqual(n, 1);

  for (const role of ['host', undefined]) {
    const r = await login(email, password, role);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.role, 'admin');
    assert.strictEqual(r.body.data.user_id, created.host_id);
    const claims = jwt.decode(r.body.data.token);
    assert.deepStrictEqual({ sub: claims.sub, role: claims.role }, { sub: created.host_id, role: 'admin' }, 'JWT claims unchanged: sub and role');
  }
  assert.strictEqual((await login(email, password, 'guest')).status, 401, 'there is no guest account with this email');
  assert.strictEqual(await createAccountStatus().check(created.host_id), 'active', 'the gateway accepts the admin');
});

test('--reset-password: new password works, old one fails, existing tokens stay valid until they expire', async () => {
  const email = `reset@${DOMAIN}`;
  const oldPassword = newPassword();
  const { host_id: hostId } = await setup(email, oldPassword);
  const oldToken = (await login(email, oldPassword, 'host')).body.data.token;

  const newPw = newPassword();
  assert.strictEqual((await setup(email, newPw, { resetPassword: true })).outcome, 'password_reset');
  assert.strictEqual((await hostRow(email)).version, 2);
  assert.strictEqual((await login(email, oldPassword, 'host')).status, 401);
  assert.strictEqual((await login(email, newPw, 'host')).body.data.role, 'admin');
  // Documented limitation: a password change does not revoke tokens already issued.
  assert.ok(jwt.decode(oldToken).exp * 1000 > Date.now());
  assert.strictEqual(await createAccountStatus().check(hostId), 'active');
});

test('an ordinary host (signed up normally) is refused and left exactly as it was', async () => {
  const email = `ordinary@${DOMAIN}`;
  const password = newPassword();
  const signup = await call('/hosts/create', { name: 'Ordinary', email, password });
  assert.strictEqual(signup.status, 201);
  const before = await hostRow(email);
  for (const resetPassword of [false, true]) {
    await assert.rejects(setup(email, newPassword(), { resetPassword }), (e) => e.code === 'HOST_NOT_ADMIN');
  }
  assert.deepStrictEqual(await hostRow(email), before);
  assert.strictEqual((await login(email, password, 'host')).body.data.role, 'host', 'still an ordinary host');
});

test('sign-up still cannot create an admin', async () => {
  const r = await call('/hosts/create', { name: 'Sneaky', email: `sneaky@${DOMAIN}`, password: newPassword(), access_level: 'admin' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(await hostRow(`sneaky@${DOMAIN}`), undefined);
});

test('a deleted host and an active guest with the email are refused', async () => {
  const gone = `gone@${DOMAIN}`;
  await call('/hosts/create', { name: 'Gone', email: gone, password: newPassword() });
  await db().execute('UPDATE hosts SET is_deleted = TRUE WHERE email = ?', [gone]);
  await assert.rejects(setup(gone, newPassword()), (e) => e.code === 'HOST_DELETED');
  assert.strictEqual((await hostRow(gone)).is_deleted, 1);

  const guestEmail = `guest@${DOMAIN}`;
  assert.strictEqual((await call('/guests/create', { first_name: 'G', last_name: 'U', email: guestEmail, password: newPassword() })).status, 201);
  await assert.rejects(setup(guestEmail, newPassword()), (e) => e.code === 'EMAIL_USED_BY_GUEST');
  assert.strictEqual(await hostRow(guestEmail), undefined);
});

test('two runs at the same time: one creates, the other reports it exists; one row', async () => {
  const email = `race@${DOMAIN}`;
  const outcomes = (await Promise.all([setup(email, newPassword()), setup(email, newPassword())])).map((r) => r.outcome).sort();
  assert.deepStrictEqual(outcomes, ['created', 'exists']);
  const [[{ n }]] = await db().execute('SELECT COUNT(*) AS n FROM hosts WHERE email = ?', [email]);
  assert.strictEqual(n, 1);
});

test('the real command: create, repeat, refuse, and never print the password or hash', async () => {
  const email = `cli@${DOMAIN}`;
  const password = newPassword();
  const first = await runCommand([], { ADMIN_EMAIL: email, ADMIN_PASSWORD: password });
  assert.strictEqual(first.code, 0, first.err);
  assert.match(first.out, /^Created admin hst_/);
  const { password_hash: hash } = await hostRow(email);
  for (const text of [first.out, first.err]) assert.ok(!text.includes(password) && !text.includes(hash));

  const repeat = await runCommand([], { ADMIN_EMAIL: email }); // no password needed, none given
  assert.strictEqual(repeat.code, 0, repeat.err);
  assert.match(repeat.out, /already exists, nothing changed/);
  assert.strictEqual((await hostRow(email)).password_hash, hash);

  const noTerminal = await runCommand(['--reset-password'], { ADMIN_EMAIL: email });
  assert.strictEqual(noTerminal.code, 1, 'needs a password, has no terminal: exits instead of hanging');
  assert.match(noTerminal.err, /NO_PASSWORD/);

  await call('/hosts/create', { name: 'Plain', email: `plain@${DOMAIN}`, password: newPassword() });
  const refused = await runCommand([], { ADMIN_EMAIL: `plain@${DOMAIN}`, ADMIN_PASSWORD: newPassword() });
  assert.strictEqual(refused.code, 2);
  assert.match(refused.err, /HOST_NOT_ADMIN/);
  assert.strictEqual((await hostRow(`plain@${DOMAIN}`)).access_level, 'standard');
});
