import { decryptSecret, encryptSecret } from './crypto.js';

/**
 * Third-party tool credentials at rest (release audit SEC-10): GitHub/Jira/Notion tokens,
 * Snowflake private keys, Databricks client secrets, Gmail refresh tokens — everything in
 * person_oauth_tokens/account_oauth_tokens. A database dump used to hand all of them over.
 *
 * Stored as `enc:v1:` + crypto.ts's AES-256-GCM envelope under CREDENTIAL_ENCRYPTION_KEY. The
 * version prefix lets a future key rotation tell generations apart. Reads accept a value
 * without the prefix as legacy plaintext, so deploying this never breaks a working connection
 * before scripts/migrate-encrypt-credentials.ts has converted the existing rows.
 */
const PREFIX = 'enc:v1:';

export const isEncryptedCredential = (stored: string): boolean => stored.startsWith(PREFIX);

export function encryptCredential(plaintext: string): string {
  return PREFIX + encryptSecret(plaintext);
}

/** Throws on a wrong key or tampered value rather than returning garbage as a token. */
export function decryptCredential(stored: string): string {
  return isEncryptedCredential(stored) ? decryptSecret(stored.slice(PREFIX.length)) : stored;
}

/** Fails fast at boot: without a usable key every connect would fail at request time. */
export function assertCredentialKeyUsable(): void {
  const probe = 'credential-key-check';
  if (decryptSecret(encryptSecret(probe)) !== probe) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY round-trip failed');
  }
}
