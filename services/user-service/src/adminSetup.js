// Admin account setup (Slice 1). Used by `npm run admin:create` (scripts/create-admin.js).
//
// An admin is a host row with access_level = 'admin'; POST /auth/login already turns that
// into a token with role "admin". Public sign-up can never set access_level, so this is
// the only code that writes an admin. No schema change, no seeded credentials: the
// password is supplied by whoever runs the command and only its bcrypt hash is stored.
//
// Safe to run any number of times:
//   no account with the email      -> create the admin                  'created'
//   an active admin                -> change nothing                    'exists'
//   an active admin + resetPassword -> new password hash, version + 1    'password_reset'
//   an ordinary host               -> refuse (never promote anyone)     HOST_NOT_ADMIN
//   a deleted host                 -> refuse (never revive an account)  HOST_DELETED
//   an active guest                -> refuse (login would be ambiguous) EMAIL_USED_BY_GUEST
//
// Nothing here logs or returns the password or its hash.
const Joi = require('joi');
const { getMysql, newId } = require('@airbnb/common');
const { hashPassword, BCRYPT_MAX_BYTES } = require('./auth');

const ADMIN_PASSWORD_MIN = 12; // sign-up allows 8; an account that sees every dashboard gets more
const DEFAULT_EMAIL = 'admin@staybook.test';
const DEFAULT_NAME = 'Staybook Admin';

class AdminSetupError extends Error {
  /** kind: 'invalid' (bad input or setup) or 'refused' (the database state forbids it) */
  constructor(code, message, kind = 'refused') {
    super(message);
    this.code = code;
    this.kind = kind;
  }
}

// Same email rules as sign-up (routes.js), so the stored email matches what login looks up.
const inputSchema = Joi.object({
  email: Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(255).required(),
  name: Joi.string().trim().min(1).max(120).required(),
});

/** Throws AdminSetupError('INVALID_PASSWORD') if the password is not acceptable for an admin. */
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < ADMIN_PASSWORD_MIN) {
    throw new AdminSetupError('INVALID_PASSWORD', `The admin password must be at least ${ADMIN_PASSWORD_MIN} characters.`, 'invalid');
  }
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) {
    throw new AdminSetupError('INVALID_PASSWORD', `The admin password must be at most ${BCRYPT_MAX_BYTES} bytes.`, 'invalid');
  }
}

/** MySQL access used by ensureAdmin. Tests pass a fake with the same four functions. */
const mysqlRepo = {
  async findHost(email) {
    const [rows] = await getMysql().execute(
      'SELECT host_id, access_level, is_deleted FROM hosts WHERE email = ?',
      [email],
    );
    return rows[0] || null;
  },
  async activeGuestExists(email) {
    const [rows] = await getMysql().execute('SELECT 1 FROM guests WHERE email = ? AND is_deleted = FALSE', [email]);
    return rows.length > 0;
  },
  async insertAdmin({ host_id: hostId, name, email, password_hash: hash }) {
    await getMysql().execute(
      `INSERT INTO hosts (host_id, name, email, password_hash, verification_status, access_level)
       VALUES (?, ?, ?, ?, 'verified', 'admin')`,
      [hostId, name, email, hash],
    );
  },
  /** Only ever touches a row that is still an active admin. Returns true if it changed one. */
  async updateAdminPassword(hostId, hash) {
    const [res] = await getMysql().execute(
      `UPDATE hosts SET password_hash = ?, version = version + 1
       WHERE host_id = ? AND access_level = 'admin' AND is_deleted = FALSE`,
      [hash, hostId],
    );
    return res.affectedRows === 1;
  },
};

function refuseExisting(host, email) {
  if (host.is_deleted) {
    throw new AdminSetupError('HOST_DELETED',
      `A deleted host account uses ${email}. It will not be revived; choose another ADMIN_EMAIL.`);
  }
  if (host.access_level !== 'admin') {
    throw new AdminSetupError('HOST_NOT_ADMIN',
      `An ordinary host account (${host.host_id}) uses ${email}. It will not be promoted; choose another ADMIN_EMAIL.`);
  }
}

/**
 * Create the admin, or confirm it exists. getPassword() is only called when a password is
 * actually needed (creating, or resetPassword), so a repeat run never asks for one.
 * Returns { outcome: 'created' | 'exists' | 'password_reset', host_id, email }.
 */
async function ensureAdmin({ email, name, resetPassword = false, getPassword }, { repo = mysqlRepo, hash = hashPassword } = {}) {
  const { value, error } = inputSchema.validate({ email, name });
  if (error) throw new AdminSetupError('INVALID_INPUT', `Invalid admin setting: ${error.details[0].context.key}.`, 'invalid');
  const target = value.email;

  const newHash = async () => {
    const password = await getPassword();
    checkPassword(password);
    return hash(password);
  };

  const existing = await repo.findHost(target);
  if (existing) {
    refuseExisting(existing, target);
    if (!resetPassword) return { outcome: 'exists', host_id: existing.host_id, email: target };
    if (!(await repo.updateAdminPassword(existing.host_id, await newHash()))) {
      throw new AdminSetupError('CHANGED_CONCURRENTLY', `The account for ${target} changed during setup; run the command again.`);
    }
    return { outcome: 'password_reset', host_id: existing.host_id, email: target };
  }

  if (await repo.activeGuestExists(target)) {
    throw new AdminSetupError('EMAIL_USED_BY_GUEST',
      `A guest account uses ${target}; an admin with the same email would make login ambiguous. Choose another ADMIN_EMAIL.`);
  }

  const hostId = newId('hst');
  const passwordHash = await newHash();
  try {
    await repo.insertAdmin({ host_id: hostId, name: value.name, email: target, password_hash: passwordHash });
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    // Another run (or a sign-up) took the email between our check and the insert.
    const winner = await repo.findHost(target);
    if (!winner) throw err;
    refuseExisting(winner, target);
    return { outcome: 'exists', host_id: winner.host_id, email: target };
  }
  return { outcome: 'created', host_id: hostId, email: target };
}

module.exports = {
  ensureAdmin, checkPassword, mysqlRepo, AdminSetupError, ADMIN_PASSWORD_MIN, DEFAULT_EMAIL, DEFAULT_NAME,
};
