import { lookup } from 'node:dns/promises';

/**
 * SSRF guard for the one place this app ever fetches a URL an org admin supplied itself:
 * org_main_agent.base_url (openaiCompatible.ts's callOpenAI, via runtimeProvider.ts's
 * resolveCredentials). Found during a security audit: an admin-supplied baseUrl was
 * stored and later fetched with no validation at all — a real server-side-request-forgery
 * primitive into Railway's private network, localhost, or any other internal address.
 *
 * Re-resolves and re-checks at call time (not just at write time) deliberately — a
 * hostname's DNS answer can change between when it was saved and when it's used
 * (DNS rebinding), so validating once at save time isn't enough on its own.
 */

function isPrivateIpv4(a: number, b: number): boolean {
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local / cloud metadata (169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 0) return true; // "this network"
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return false;
    return isPrivateIpv4(a, b);
  }
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('fe80:')) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local, fc00::/7
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

export type UrlSafetyResult = { ok: true } | { ok: false; reason: string };

export async function isSafeExternalUrl(raw: string): Promise<UrlSafetyResult> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'must be an https:// URL' };
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname.endsWith('.internal') || hostname.endsWith('.railway.internal')) {
    return { ok: false, reason: 'internal or loopback hostnames are not allowed' };
  }
  let addresses: string[];
  try {
    addresses = (await lookup(hostname, { all: true })).map((a) => a.address);
  } catch {
    return { ok: false, reason: 'could not resolve this hostname' };
  }
  if (addresses.some(isPrivateIp)) {
    return { ok: false, reason: 'resolves to a private or internal address' };
  }
  return { ok: true };
}
