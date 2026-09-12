import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertCredentialKeyUsable, decryptCredential, encryptCredential, isEncryptedCredential } from './credentials.js';

beforeEach(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
});

describe('credential encryption at rest', () => {
  it('round-trips and never stores the plaintext', () => {
    const token = 'ghp_realLookingPersonalAccessToken1234567890';
    const stored = encryptCredential(token);
    expect(isEncryptedCredential(stored)).toBe(true);
    expect(stored).not.toContain(token);
    expect(decryptCredential(stored)).toBe(token);
  });

  it('uses a fresh IV each time, so equal tokens are not linkable', () => {
    expect(encryptCredential('same-token')).not.toBe(encryptCredential('same-token'));
  });

  it('round-trips a multi-line PEM private key', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    expect(decryptCredential(encryptCredential(pem))).toBe(pem);
  });

  it('reads a not-yet-migrated plaintext value unchanged', () => {
    expect(decryptCredential('lin_api_legacyPlaintext')).toBe('lin_api_legacyPlaintext');
  });

  it('throws on a tampered value instead of returning a corrupted token', () => {
    const stored = encryptCredential('secret-token');
    const body = Buffer.from(stored.slice('enc:v1:'.length), 'base64');
    body[body.length - 1] ^= 0xff;
    expect(() => decryptCredential(`enc:v1:${body.toString('base64')}`)).toThrow();
  });

  it('throws under a different key', () => {
    const stored = encryptCredential('secret-token');
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => decryptCredential(stored)).toThrow();
  });

  it('refuses to encrypt without a key, and the boot check fails loudly', () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptCredential('x')).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
    expect(() => assertCredentialKeyUsable()).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });
});
