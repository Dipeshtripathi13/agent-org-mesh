/**
 * Outbound HTTP limits (release audit OPS-04). Nothing used to bound a call to a connector,
 * a model provider or Resend: one hung vendor held a request open indefinitely, and ask-multi
 * multiplied that by every selected person and every connected tool.
 *
 * `installOutboundTimeout` wraps the global fetch once at startup, so every caller — the ~24
 * connector modules, the MCP SDK's transport, anything added later — gets a deadline without
 * having to remember one. The default is combined with any signal the caller passes, because
 * SDKs pass signals of their own that never fire: the MCP transport sends its session
 * AbortController's signal on every request, so a wrapper that deferred to "any signal" left
 * those calls with no deadline at all (found by proof against a server that never answers).
 *
 * Code that genuinely needs a different limit asks for it with `deadline(ms)`, which the wrapper
 * recognises and leaves alone. A client that manages its own timeout end to end (the Anthropic
 * SDK, configured in anthropic.ts) takes `originalFetch` instead.
 */

const ORIGINAL = Symbol.for('agent-org-mesh.outboundTimeout.original');
const OWN_DEADLINES = new WeakSet<AbortSignal>();

type GlobalWithOriginal = typeof globalThis & { [ORIGINAL]?: typeof fetch };

/** An explicit per-call deadline that replaces, rather than joins, the default. */
export function deadline(ms: number): AbortSignal {
  const signal = AbortSignal.timeout(ms);
  OWN_DEADLINES.add(signal);
  return signal;
}

/** The unwrapped fetch, for clients that enforce their own timeout. */
export function originalFetch(): typeof fetch {
  return (globalThis as GlobalWithOriginal)[ORIGINAL] ?? globalThis.fetch;
}

export function installOutboundTimeout(defaultMs: number): void {
  const g = globalThis as GlobalWithOriginal;
  const original = g[ORIGINAL] ?? globalThis.fetch;
  g[ORIGINAL] = original;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (callerSignal && OWN_DEADLINES.has(callerSignal)) return original(input, init);
    const ceiling = AbortSignal.timeout(defaultMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, ceiling]) : ceiling;
    return original(input, { ...init, signal });
  }) as typeof fetch;
}

/** Rejects with a labelled error if `promise` hasn't settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Promise.allSettled with at most `limit` running at once; results keep input order. */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/** Promise.all with at most `limit` running at once; rejects on the first failure. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const settled = await settleWithConcurrency(items, limit, fn);
  return settled.map((r) => {
    if (r.status === 'rejected') throw r.reason;
    return r.value;
  });
}
