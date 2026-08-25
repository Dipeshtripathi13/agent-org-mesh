import { describe, expect, it, vi } from 'vitest';
import { isPrivateIp, isSafeExternalUrl } from './urlSafety.js';

// Mocked rather than a real DNS lookup — deterministic, no network dependency in tests,
// same pure-test posture as the rest of integrations/ (openaiCompatible.test.ts,
// runtimeProvider.test.ts never touch a real network either).
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname === 'evil-rebind.example') return [{ address: '169.254.169.254', family: 4 }];
    if (hostname === 'unresolvable.example') throw new Error('ENOTFOUND');
    return [{ address: '203.0.113.10', family: 4 }]; // TEST-NET-3, a real-looking public IP
  }),
}));

describe('isPrivateIp', () => {
  it('flags RFC1918 ranges', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
  });

  it('flags loopback', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
  });

  it('flags link-local / cloud metadata', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('flags IPv6 unique-local (fc00::/7)', () => {
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
  });

  it('flags an IPv4-mapped IPv6 private address', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
  });

  it('does not flag real public addresses', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });

  it('does not crash or misclassify malformed input', () => {
    expect(isPrivateIp('999.999.999.999')).toBe(false);
    expect(isPrivateIp('not-an-ip')).toBe(false);
  });
});

describe('isSafeExternalUrl', () => {
  it('rejects non-URL input', async () => {
    const result = await isSafeExternalUrl('not a url');
    expect(result.ok).toBe(false);
  });

  it('rejects http:// — https only', async () => {
    const result = await isSafeExternalUrl('http://example.com');
    expect(result.ok).toBe(false);
  });

  it('rejects localhost by hostname before any DNS lookup', async () => {
    const result = await isSafeExternalUrl('https://localhost/v1');
    expect(result.ok).toBe(false);
  });

  it('rejects a *.railway.internal hostname by name', async () => {
    const result = await isSafeExternalUrl('https://postgres.railway.internal/v1');
    expect(result.ok).toBe(false);
  });

  it('accepts a resolvable https URL with a real-looking public address', async () => {
    const result = await isSafeExternalUrl('https://api.example.com/v1');
    expect(result.ok).toBe(true);
  });

  it('rejects a hostname that resolves to a private address — DNS rebinding case', async () => {
    const result = await isSafeExternalUrl('https://evil-rebind.example/v1');
    expect(result.ok).toBe(false);
  });

  it('rejects a hostname that fails to resolve', async () => {
    const result = await isSafeExternalUrl('https://unresolvable.example/v1');
    expect(result.ok).toBe(false);
  });
});
