import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

/**
 * Request IDs, structured error logs and browser error reports (release audit OPS-06/OPS-09),
 * through the real app. A test-only route that throws is registered before the app becomes
 * ready, so a genuine unhandled error travels the real error handler.
 */

let app: FastifyInstance;
let logSpy: MockInstance;
let ip = 0;
const TOKEN = `aor_${'X'.repeat(43)}`;

const loggedLines = () =>
  logSpy.mock.calls
    .map((args) => { try { return JSON.parse(String(args[0])); } catch { return null; } })
    .filter((line): line is Record<string, any> => line != null && line.level === 'error');

beforeAll(async () => {
  ({ app } = await import('./server.js'));
  app.get('/api/test-only/boom', async () => {
    throw new Error(`database exploded while handling ${TOKEN}`);
  });
});

beforeEach(() => {
  logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  await app?.close();
});

describe('request IDs', () => {
  it('every response carries one', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runtimes' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a caller’s well-formed correlation ID is kept; anything else is replaced', async () => {
    const kept = await app.inject({ method: 'GET', url: '/api/runtimes', headers: { 'x-request-id': 'trace-abc12345' } });
    expect(kept.headers['x-request-id']).toBe('trace-abc12345');
    const replaced = await app.inject({ method: 'GET', url: '/api/runtimes', headers: { 'x-request-id': 'has spaces <script>' } });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('server errors', () => {
  it('a 500 returns only a generic message and the request ID, and logs one structured line', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/test-only/boom' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toEqual({ error: 'internal server error', requestId: res.headers['x-request-id'] });
    expect(res.body).not.toContain('exploded');

    const line = loggedLines().find((l) => l.requestId === body.requestId);
    expect(line).toMatchObject({ source: 'server', method: 'GET', route: '/api/test-only/boom', status: 500 });
    expect(line!.error.message).toContain('database exploded');
    expect(line!.error.stack).toBeTruthy();
    expect(JSON.stringify(line)).not.toContain(TOKEN);
    expect(line!.error.message).toContain('aor_[redacted]');
  });

  it('expected rejections (4xx) are not logged as errors', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/query', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(loggedLines().some((l) => l.requestId === res.headers['x-request-id'])).toBe(false);
  });

  it('an out-of-range orgId is refused instead of crashing the query', async () => {
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: `10.7.0.${++ip}`,
      payload: { email: 'jordan@agentorgmesh.local', password: 'admin-dev-only' },
    });
    const cookie = `aom_session=${login.cookies.find((c) => c.name === 'aom_session')!.value}`;
    const res = await app.inject({ method: 'GET', url: '/api/overview?orgId=99999999999', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(loggedLines()).toHaveLength(0);
  });
});

describe('browser error reports', () => {
  const report = (payload: unknown, remoteAddress = `10.7.1.${++ip}`, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url: '/api/client-errors', remoteAddress, payload: payload as never, headers });

  it('accepts a report without a session and logs it with secrets redacted', async () => {
    const res = await report({
      kind: 'render',
      message: `Cannot read properties of undefined while on /reset-password/${TOKEN}`,
      stack: `TypeError: boom\n    at ResetPassword (/assets/index.js:1:2)`,
      componentStack: '\n    at ResetPassword\n    at EmailLinkPage',
      path: `/reset-password/${TOKEN}`,
      release: 'test',
    });
    expect(res.statusCode).toBe(204);
    const line = loggedLines().find((l) => l.requestId === res.headers['x-request-id']);
    expect(line).toMatchObject({ source: 'browser', kind: 'render', path: '/reset-password/aor_[redacted]', accountId: null });
    expect(JSON.stringify(line)).not.toContain(TOKEN);
  });

  it('rejects malformed and oversized reports without logging them', async () => {
    expect((await report({ kind: 'render' })).statusCode).toBe(400);
    expect((await report({ kind: 'nonsense', message: 'x' })).statusCode).toBe(400);
    expect((await report({ kind: 'error', message: 'x', stack: 'y'.repeat(8001) })).statusCode).toBe(400);
    expect(loggedLines()).toHaveLength(0);
  });

  it('is rate limited per address', async () => {
    const address = '10.7.9.9';
    const codes: number[] = [];
    for (let i = 0; i < 21; i += 1) codes.push((await report({ kind: 'error', message: `flood ${i}` }, address)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 204)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it('an account that hasn’t verified its email can still report a crash', async () => {
    const signup = await app.inject({
      method: 'POST', url: '/api/auth/signup', remoteAddress: `10.7.2.${++ip}`,
      payload: { name: 'Crash Reporter', email: `crash-${Date.now()}@example.test`, password: 'crash-reporter-1' },
    });
    const cookie = `aom_session=${signup.cookies.find((c) => c.name === 'aom_session')!.value}`;
    const res = await report({ kind: 'unhandledrejection', message: 'fetch failed' }, `10.7.3.${++ip}`, { cookie });
    expect(res.statusCode).toBe(204);
    expect(loggedLines().find((l) => l.requestId === res.headers['x-request-id'])?.accountId).toBe(signup.json().account.id);
  });
});
