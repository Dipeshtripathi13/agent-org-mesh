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

  /**
   * Every case below passed the guard as "public" until 2026-09-30. Found by reading this file
   * after GHSA-rpw4-54j3-4h4q (`ip-address` recognising fe80::/64 instead of fe80::/10) failed
   * CI's dependency audit — the same mistake was sitting in our own check, which matched the
   * string "fe80:" and so covered only fe80::/16.
   */
  it('flags the whole of fe80::/10, not just addresses starting fe80:', () => {
    expect(isPrivateIp('fe80::1'), 'the bottom of the range still works').toBe(true);
    expect(isPrivateIp('fe81::1')).toBe(true);
    expect(isPrivateIp('fe9f::1')).toBe(true);
    expect(isPrivateIp('feb0::1')).toBe(true);
    expect(isPrivateIp('febf:ffff::1'), 'the top of the range').toBe(true);
  });

  it('does not over-reach past fe80::/10 into real public space', () => {
    expect(isPrivateIp('fec0::1'), 'site-local, deprecated and routable-ish — not link-local').toBe(false);
    expect(isPrivateIp('fe7f::1')).toBe(false);
    expect(isPrivateIp('2001:db8::1')).toBe(false);
  });

  it('flags an IPv4-mapped address written in hex, which reads as a different string', () => {
    expect(isPrivateIp('::ffff:7f00:1'), '127.0.0.1').toBe(true);
    expect(isPrivateIp('::ffff:a00:1'), '10.0.0.1').toBe(true);
    expect(isPrivateIp('::ffff:a9fe:a9fe'), '169.254.169.254, the metadata endpoint').toBe(true);
    expect(isPrivateIp('::ffff:cb00:710f'), '203.0.113.15 is public, mapped or not').toBe(false);
  });

  it('flags the unspecified address and carrier-grade NAT space', () => {
    expect(isPrivateIp('::')).toBe(true);
    expect(isPrivateIp('0:0:0:0:0:0:0:0')).toBe(true);
    expect(isPrivateIp('100.64.0.1'), 'RFC6598, used for real cloud internals').toBe(true);
    expect(isPrivateIp('100.127.255.255')).toBe(true);
    expect(isPrivateIp('100.63.255.255'), 'just below the range, genuinely public').toBe(false);
    expect(isPrivateIp('100.128.0.1'), 'just above it').toBe(false);
  });

  it('flags multicast and broadcast', () => {
    expect(isPrivateIp('224.0.0.1')).toBe(true);
    expect(isPrivateIp('255.255.255.255')).toBe(true);
    expect(isPrivateIp('223.255.255.255'), 'the last ordinary unicast address').toBe(false);
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
