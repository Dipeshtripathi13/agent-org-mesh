import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateSessionToken,
  generateTempPassword,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from './auth.js';

describe('hashPassword / verifyPassword', () => {
  it('verifies the correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('wrong password', stored)).toBe(false);
  });

  it('rejects an empty password against a real hash', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('produces a different hash each time — random salt, not deterministic', () => {
    const a = hashPassword('same password');
    const b = hashPassword('same password');
    expect(a).not.toBe(b);
    expect(verifyPassword('same password', a)).toBe(true);
    expect(verifyPassword('same password', b)).toBe(true);
  });

  it('rejects a malformed stored hash rather than throwing', () => {
    expect(verifyPassword('anything', 'not-a-real-hash')).toBe(false);
    expect(verifyPassword('anything', '')).toBe(false);
    expect(verifyPassword('anything', 'scrypt$onlytwoparts')).toBe(false);
  });

  it('stores the scrypt marker, cost parameter, and a salt/hash pair', () => {
    const stored = hashPassword('x');
    const parts = stored.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(Number(parts[1])).toBeGreaterThan(0);
    expect(parts).toHaveLength(4);
  });

  // Deliberate, not an accident: the cost parameter (N) was raised from Node's old
  // implicit default (16384) to the current OWASP-recommended 131072 during a security
  // audit. Every password hash minted before that change is in the old 3-part format
  // (scrypt$salt$hash, no encoded N) — this proves that format still verifies correctly
  // under the legacy cost it was actually hashed with, so raising the cost for new
  // passwords never locks out anyone who registered before this change.
  it('still verifies a pre-upgrade 3-part hash (scrypt$salt$hash, no encoded N)', () => {
    const salt = randomBytes(16).toString('hex');
    const legacyHash = scryptSync('an old password', salt, 64).toString('hex');
    const legacyStored = `scrypt$${salt}$${legacyHash}`;
    expect(verifyPassword('an old password', legacyStored)).toBe(true);
    expect(verifyPassword('wrong password', legacyStored)).toBe(false);
  });
});

describe('generateSessionToken / hashSessionToken', () => {
  it('generates tokens with the expected prefix', () => {
    expect(generateSessionToken().startsWith('aoms_')).toBe(true);
  });

  it('generates unique tokens across many samples', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateSessionToken()));
    expect(tokens.size).toBe(500);
  });

  it('hashes the same token identically every time', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it('hashes different tokens to different digests', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(hashSessionToken(a)).not.toBe(hashSessionToken(b));
  });

  it('never stores the raw token as its own hash', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).not.toBe(token);
  });
});

describe('generateTempPassword', () => {
  it('generates non-empty, reasonably long temp passwords', () => {
    const pw = generateTempPassword();
    expect(pw.length).toBeGreaterThanOrEqual(10);
  });

  it('generates unique values across many samples', () => {
    const values = new Set(Array.from({ length: 200 }, () => generateTempPassword()));
    expect(values.size).toBe(200);
  });
});
