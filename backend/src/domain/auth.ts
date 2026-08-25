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
// 2^17 — current OWASP-recommended minimum scrypt cost parameter, up from Node's own
// default of 2^14 (found during a security audit: fine in 2024, below current guidance
// now). r/p stay at their conventional values; maxmem has to rise to match — N=131072 at
// r=8 needs ~134MB, over Node's 32MB default ceiling.
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
// Every password hash minted before this change used Node's implicit default (no options
// passed at all) — that's N=16384, r=8, p=1. Never used for new hashes, only so an
// already-registered password keeps verifying under the cost it was actually hashed with.
const LEGACY_SCRYPT_N = 16384;

function scrypt(password: string, salt: string, n: number): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN, { N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
}

/** 'scrypt$<N>$<saltHex>$<hashHex>' — the cost parameter travels with the hash so a
 *  future increase (like this one) never locks anyone out; verifyPassword just re-derives
 *  with whatever N the hash was actually minted under, old or new. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scrypt(password, salt, SCRYPT_N).toString('hex');
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

/** Timing-safe by construction — always compares two fixed-length digests, never the
 *  password itself, and never short-circuits on a length mismatch by returning early with
 *  a cheaper failure path (a malformed stored hash just fails the compare, same cost).
 *  Accepts both the current 4-part format and the pre-audit 3-part one (no encoded N,
 *  implicitly LEGACY_SCRYPT_N) — anything else fails closed. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  let n: number;
  let salt: string;
  let hashHex: string;
  if (parts.length === 4 && parts[0] === 'scrypt') {
    n = Number(parts[1]);
    [, , salt, hashHex] = parts;
  } else if (parts.length === 3 && parts[0] === 'scrypt') {
    n = LEGACY_SCRYPT_N;
    [, salt, hashHex] = parts;
  } else {
    return false;
  }
  if (!Number.isFinite(n) || !salt || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scrypt(password, salt, n);
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
