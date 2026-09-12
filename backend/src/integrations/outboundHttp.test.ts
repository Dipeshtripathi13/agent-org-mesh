import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deadline, installOutboundTimeout, mapWithConcurrency, originalFetch, settleWithConcurrency, withTimeout,
} from './outboundHttp.js';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/never') return; // accepts the connection, never answers
    const delay = Number(new URL(req.url!, 'http://x').searchParams.get('delay') ?? 0);
    setTimeout(() => res.end('ok'), delay);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  installOutboundTimeout(150);
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const elapsed = async (work: () => Promise<unknown>) => {
  const started = Date.now();
  const outcome = await work().then(() => 'resolved', () => 'rejected');
  return { outcome, ms: Date.now() - started };
};

describe('outbound fetch timeout', () => {
  it('aborts a call to a server that never answers', async () => {
    const r = await elapsed(() => fetch(`${base}/never`));
    expect(r.outcome).toBe('rejected');
    expect(r.ms).toBeLessThan(2_000);
  });

  it('lets a prompt answer through', async () => {
    expect(await (await fetch(`${base}/ok?delay=10`)).text()).toBe('ok');
  });

  it('still applies when the caller passes a signal that never fires (how the MCP SDK calls fetch)', async () => {
    const neverAborted = new AbortController().signal;
    const r = await elapsed(() => fetch(`${base}/never`, { signal: neverAborted }));
    expect(r.outcome).toBe('rejected');
    expect(r.ms).toBeLessThan(2_000);
  });

  it('still lets the caller’s own signal abort sooner', async () => {
    const r = await elapsed(() => fetch(`${base}/never`, { signal: AbortSignal.timeout(20) }));
    expect(r.outcome).toBe('rejected');
    expect(r.ms).toBeLessThan(150);
  });

  it('honours an explicit deadline() longer than the default', async () => {
    const res = await fetch(`${base}/ok?delay=400`, { signal: deadline(3_000) });
    expect(await res.text()).toBe('ok');
  });

  it('originalFetch() bypasses the default for clients that enforce their own timeout', async () => {
    const res = await originalFetch()(`${base}/ok?delay=400`);
    expect(await res.text()).toBe('ok');
  });

  it('installing twice does not stack wrappers', async () => {
    installOutboundTimeout(150);
    const r = await elapsed(() => fetch(`${base}/never`));
    expect(r.outcome).toBe('rejected');
    expect(r.ms).toBeLessThan(2_000);
    expect(await (await originalFetch()(`${base}/ok?delay=300`)).text()).toBe('ok');
  });
});

describe('withTimeout', () => {
  it('rejects with a labelled error when the work outlasts the limit', async () => {
    await expect(withTimeout(new Promise(() => {}), 50, 'mcp session')).rejects.toThrow('mcp session timed out after 50ms');
  });
  it('returns the value when the work finishes in time', async () => {
    expect(await withTimeout(Promise.resolve(7), 50, 'x')).toBe(7);
  });
});

describe('bounded concurrency', () => {
  const tracker = () => {
    let running = 0;
    let peak = 0;
    const run = async <T,>(value: T, fail = false) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 15));
      running -= 1;
      if (fail) throw new Error(`failed ${String(value)}`);
      return value;
    };
    return { run, peak: () => peak };
  };

  it('never runs more than the limit at once and keeps input order', async () => {
    const t = tracker();
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, (n) => t.run(n * 10));
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(t.peak()).toBe(3);
  });

  it('settles every item even when some fail', async () => {
    const t = tracker();
    const out = await settleWithConcurrency(['a', 'b', 'c', 'd'], 2, (s) => t.run(s, s === 'b'));
    expect(out.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
    expect(t.peak()).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await settleWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
