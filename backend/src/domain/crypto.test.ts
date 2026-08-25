import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './crypto.js';

describe('encryptSecret / decryptSecret', () => {
  const originalKey = process.env.CREDENTIAL_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = originalKey;
  });

  it('round-trips a secret', () => {
    const stored = encryptSecret('sk-ant-real-secret-value');
    expect(decryptSecret(stored)).toBe('sk-ant-real-secret-value');
  });

  it('produces different ciphertext each time — random IV, not deterministic', () => {
    const a = encryptSecret('same secret');
    const b = encryptSecret('same secret');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same secret');
    expect(decryptSecret(b)).toBe('same secret');
  });

  it('never stores the plaintext as a substring of the ciphertext', () => {
    const stored = encryptSecret('sk-ant-real-secret-value');
    expect(stored).not.toContain('sk-ant-real-secret-value');
  });

  it('fails to decrypt under a different key', () => {
    const stored = encryptSecret('sk-ant-real-secret-value');
    process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => decryptSecret(stored)).toThrow();
  });

  it('fails to decrypt tampered ciphertext rather than returning garbage', () => {
    const stored = encryptSecret('sk-ant-real-secret-value');
    const tampered = Buffer.from(stored, 'base64');
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptSecret(tampered.toString('base64'))).toThrow();
  });

  it('throws clearly when no encryption key is configured', () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    expect(() => encryptSecret('anything')).toThrow(/CREDENTIAL_ENCRYPTION_KEY/);
  });

  it('rejects malformed stored input rather than throwing an unrelated error', () => {
    expect(() => decryptSecret('not-valid-base64-ciphertext')).toThrow();
    expect(() => decryptSecret('')).toThrow();
  });
});
