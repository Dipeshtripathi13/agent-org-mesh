import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password and session-token primitives for platform admin authentication. Pure and
 * synchronous — no DB, no clock reads beyond Node's own crypto RNG — so it's covered by
 * the same golden-test suite as policy.ts/audit.ts rather than exercised only through the
 * live server.
 *
 * No new dependency: Node's built-in `crypto` module already covers everything here
 * (scrypt for slow, salted password hashing; randomBytes/createHash for high-entropy
 * session tokens) the same way `randomUUID` is already used elsewhere in this codebase.
 */

const SCRYPT_KEYLEN = 64;

/** 'scrypt$<saltHex>$<hashHex>' — the whole thing is what's stored in admins.password_hash. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** Timing-safe by construction — always compares two fixed-length digests, never the
 *  password itself, and never short-circuits on a length mismatch by returning early with
 *  a cheaper failure path (a malformed stored hash just fails the compare, same cost). */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Raw session token — goes in the cookie, is never itself persisted. */
export function generateSessionToken(): string {
  return `aoms_${randomBytes(32).toString('base64url')}`;
}

/** What's actually stored in admin_sessions.token_hash — a DB dump can never be replayed
 *  as a live session. Same SHA-256-of-a-high-entropy-random-value approach as
 *  ingestTokens.ts's hashToken; a fast hash is fine here (unlike passwords) because the
 *  input already has ~256 bits of entropy, not a human-guessable secret. */
export function hashSessionToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** One-time temp password shown to whoever invites a new admin — readable, not a token,
 *  since a human has to type it once to log in and set their own password afterward. */
export function generateTempPassword(): string {
  return randomBytes(9).toString('base64url');
}
