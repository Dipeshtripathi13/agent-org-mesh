import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Reversible encryption for secrets that must be read back later — an organization's own
 * LLM provider API key (org_main_agent.api_key_encrypted), the one secret in this codebase
 * that isn't a password or session token (auth.ts's hashes are deliberately one-way).
 *
 * AES-256-GCM via Node's built-in `crypto`, no new dependency, same posture as auth.ts.
 * Keyed by CREDENTIAL_ENCRYPTION_KEY (32 random bytes, base64) — one per deployment
 * environment, never committed. Stored format: base64(iv(12) || authTag(16) || ciphertext).
 */

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is not set on the backend — required to store a custom provider credential');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 of 32 random bytes)');
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Fails closed: a wrong key, tampered ciphertext, or malformed input throws rather than
 *  returning a corrupted or empty string that could be mistaken for a real credential. */
export function decryptSecret(stored: string): string {
  const buf = Buffer.from(stored, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('malformed encrypted credential');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
