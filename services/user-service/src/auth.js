// Password hashing and JWT issuing for the user service.
// The gateway verifies these tokens with the same JWT_SECRET and forwards
// `sub` as X-User-Id and `role` as X-User-Role to every service.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { logger } = require('@airbnb/common');

const DEV_SECRET = 'change-me-dev-secret';
const JWT_ALGORITHM = 'HS256';
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

// bcrypt only uses the first 72 bytes of a password. Longer ones are rejected at
// validation so two different long passwords can never share a hash.
const BCRYPT_MAX_BYTES = 72;

const secret = () => process.env.JWT_SECRET || DEV_SECRET;

const ttlSeconds = () => {
  const n = Number(process.env.JWT_EXPIRES_IN_SECONDS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
};

// 10 rounds by default; tests lower it with BCRYPT_ROUNDS to stay fast.
const rounds = () => {
  const n = Number(process.env.BCRYPT_ROUNDS);
  return Number.isInteger(n) && n >= 4 && n <= 15 ? n : 10;
};

if (process.env.NODE_ENV === 'production' && secret() === DEV_SECRET) {
  logger.warn('JWT_SECRET is the development default; set a real secret before deploying');
}

const hashPassword = (plain) => bcrypt.hash(plain, rounds());

// Compared when the email is unknown, so a missing account costs the same time as
// a wrong password and response timing does not reveal which emails exist.
// Hashed once at startup (same cost as real hashes), not on the first unknown email.
const dummyHash = bcrypt.hash('dummy-password-for-timing', rounds());
dummyHash.catch(() => {});

async function verifyPassword(plain, hash) {
  if (!hash) {
    await bcrypt.compare(plain, await dummyHash);
    return false;
  }
  return bcrypt.compare(plain, hash);
}

/** Sign the session token. Claims are exactly what the gateway reads: sub and role. */
function issueToken({ userId, role }) {
  const token = jwt.sign({ sub: userId, role }, secret(), { algorithm: JWT_ALGORITHM, expiresIn: ttlSeconds() });
  const { exp } = jwt.decode(token);
  return { token, expires_at: new Date(exp * 1000).toISOString(), user_id: userId, role };
}

module.exports = { hashPassword, verifyPassword, issueToken, ttlSeconds, BCRYPT_MAX_BYTES, JWT_ALGORITHM };
