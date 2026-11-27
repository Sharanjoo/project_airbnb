// Create the platform admin account (Slice 1). Run once per database, before using the
// Platform and AI dashboards:
//
//   npm run infra:up
//   npm run admin:create                     asks for the password (not shown while typing)
//   npm run admin:create -- --reset-password  sets a new password for the existing admin
//
// Settings (optional, read from the environment or your git-ignored .env):
//   ADMIN_EMAIL     default admin@staybook.test
//   ADMIN_NAME      default "Staybook Admin"
//   ADMIN_PASSWORD  only for unattended runs; otherwise you are prompted. Never commit it.
//
// Running it again is safe: an existing admin is left exactly as it is, an ordinary or
// deleted host with that email is never promoted or revived, and a password is only asked
// for when one is needed. The password, its hash and tokens are never printed.
// Then log in on the Login page with "Host" selected; you land on /dashboards/platform.
const {
  ensureAdmin, mysqlRepo, AdminSetupError, ADMIN_PASSWORD_MIN, DEFAULT_EMAIL, DEFAULT_NAME,
} = require('../services/user-service/src/adminSetup');

const USAGE = `Usage: npm run admin:create [-- --reset-password]

Creates the admin account (a host with access_level 'admin') if it does not exist.
  --reset-password   set a new password for the existing admin
  --help             show this help

Environment: ADMIN_EMAIL (default ${DEFAULT_EMAIL}), ADMIN_NAME (default "${DEFAULT_NAME}"),
ADMIN_PASSWORD (optional; you are prompted when it is not set).
`;

/** Read one line from a TTY without echoing it. Resolves with the text typed. */
function promptHidden(question, { input, output }) {
  return new Promise((resolve, reject) => {
    let value = '';
    output.write(question);
    const finish = (err) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (err) reject(err); else resolve(value);
    };
    function onData(chunk) {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish();
        if (ch === '\u0003') return finish(new AdminSetupError('CANCELLED', 'Cancelled.', 'invalid'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
      return undefined;
    }
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
  });
}

function passwordSource({ env, stdin, stderr }) {
  return async () => {
    if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;
    if (!stdin.isTTY) {
      throw new AdminSetupError('NO_PASSWORD',
        'No terminal to ask for the password. Run this in a terminal, or set ADMIN_PASSWORD for this run.', 'invalid');
    }
    const io = { input: stdin, output: stderr };
    const first = await promptHidden(`Admin password (at least ${ADMIN_PASSWORD_MIN} characters, not shown): `, io);
    const second = await promptHidden('Repeat the password: ', io);
    if (first !== second) throw new AdminSetupError('PASSWORD_MISMATCH', 'The two passwords do not match. Nothing was changed.', 'invalid');
    return first;
  };
}

/** A failure as one safe line: never the error object, which can carry query details. */
function describeError(err, env) {
  if (err instanceof AdminSetupError) return `${err.code}: ${err.message}`;
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
    return `${err.code}: cannot reach MySQL at ${env.MYSQL_HOST || 'localhost'}:${env.MYSQL_PORT || 3307}. Start it with npm run infra:up.`;
  }
  if (err.code === 'ER_ACCESS_DENIED_ERROR') return `${err.code}: MySQL refused the login. Check MYSQL_USER and MYSQL_PASSWORD.`;
  return `${err.code || 'ERROR'}: setup failed. Nothing was printed about the password.`;
}

const OUTCOME = {
  created: 'Created admin',
  exists: 'Admin already exists, nothing changed:',
  password_reset: 'Password changed for admin',
};

/** Returns the exit code: 0 done, 1 bad input or setup problem, 2 refused by the database state. */
async function main({
  argv = process.argv.slice(2), env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
  repo = mysqlRepo, hash,
} = {}) {
  const unknown = argv.filter((a) => a !== '--reset-password' && a !== '--help');
  if (argv.includes('--help') || unknown.length) {
    (unknown.length ? stderr : stdout).write(unknown.length ? `Unknown option: ${unknown[0]}\n\n${USAGE}` : USAGE);
    return unknown.length ? 1 : 0;
  }
  try {
    const result = await ensureAdmin({
      email: env.ADMIN_EMAIL || DEFAULT_EMAIL,
      name: env.ADMIN_NAME || DEFAULT_NAME,
      resetPassword: argv.includes('--reset-password'),
      getPassword: passwordSource({ env, stdin, stderr }),
    }, { repo, ...(hash ? { hash } : {}) });
    stdout.write(`${OUTCOME[result.outcome]} ${result.host_id} (${result.email}).\n`);
    if (result.outcome === 'exists') stdout.write('To set a new password: npm run admin:create -- --reset-password\n');
    if (result.outcome === 'password_reset') {
      stdout.write('Sessions already signed in with the old password stay valid until their tokens expire.\n');
    }
    stdout.write('Log in on the Login page with "Host" selected; admins land on /dashboards/platform.\n');
    return 0;
  } catch (err) {
    stderr.write(`admin:create failed. ${describeError(err, env)}\n`);
    return err instanceof AdminSetupError && err.kind === 'refused' ? 2 : 1;
  }
}

module.exports = { main, promptHidden, describeError };

if (require.main === module) {
  main().then(async (code) => {
    await require('@airbnb/common').getMysql().end().catch(() => {});
    process.exitCode = code;
  });
}
