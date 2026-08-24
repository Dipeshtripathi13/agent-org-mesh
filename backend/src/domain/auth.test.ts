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

  it('stores the scrypt marker and a salt/hash pair', () => {
    const stored = hashPassword('x');
    const parts = stored.split('$');
    expect(parts[0]).toBe('scrypt');
    expect(parts).toHaveLength(3);
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
