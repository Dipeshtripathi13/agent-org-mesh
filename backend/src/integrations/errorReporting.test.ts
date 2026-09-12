import { createTransport } from '@sentry/node';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { flushErrorReporting, initErrorReporting, redactSecrets, reportBrowserError, reportServerError } from './errorReporting.js';

const TOKEN = `aov_${'Q'.repeat(43)}`;
const envelopes: string[] = [];
const capturingTransport = (options: Parameters<typeof createTransport>[0]) =>
  createTransport(options, async (request) => {
    envelopes.push(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8'));
    return { statusCode: 200 };
  });

let logSpy: MockInstance;
const lines = () => logSpy.mock.calls.map((args) => JSON.parse(String(args[0])));

beforeEach(() => {
  logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  envelopes.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('redactSecrets', () => {
  it('redacts all three one-time token kinds', () => {
    const text = `aoi_${'a'.repeat(43)} aov_${'b'.repeat(43)} /reset-password/aor_${'c'.repeat(43)}`;
    expect(redactSecrets(text)).toBe('aoi_[redacted] aov_[redacted] /reset-password/aor_[redacted]');
  });
});

describe('without SENTRY_DSN', () => {
  it('logs a structured line and sends nothing anywhere', async () => {
    delete process.env.SENTRY_DSN;
    expect(initErrorReporting({ transport: capturingTransport })).toBe(false);
    reportServerError(new Error(`failed with ${TOKEN}`), { requestId: 'req-off', method: 'POST', route: '/api/x', status: 500 });
    await flushErrorReporting();
    const [line] = lines();
    expect(line).toMatchObject({ level: 'error', source: 'server', requestId: 'req-off', method: 'POST', route: '/api/x', status: 500 });
    expect(line.error.message).toBe('failed with aov_[redacted]');
    expect(line.error.stack).toContain('Error: failed with aov_[redacted]');
    expect(envelopes).toHaveLength(0);
  });
});

describe('with SENTRY_DSN set', () => {
  it('switches on and sends server errors with the request ID, tokens redacted', async () => {
    expect(initErrorReporting({ dsn: 'https://publickey@o1.ingest.example.invalid/1', transport: capturingTransport, environment: 'test' })).toBe(true);
    reportServerError(new Error(`database timeout for ${TOKEN}`), { requestId: 'req-server-1', method: 'GET', route: '/api/org', status: 500 });
    expect(await flushErrorReporting()).toBe(true);
    const sent = envelopes.join('\n');
    expect(sent).toContain('database timeout');
    expect(sent).toContain('"request_id":"req-server-1"');
    expect(sent).toContain('"source":"server"');
    expect(sent).toContain('"route":"/api/org"');
    expect(sent).not.toContain(TOKEN);
    expect(lines()[0].requestId).toBe('req-server-1');
  });

  it('forwards browser crash reports as events with their kind and path', async () => {
    reportBrowserError(
      { kind: 'render', message: `Cannot read properties of undefined on /verify-email/${TOKEN}`, path: `/verify-email/${TOKEN}`, stack: 'TypeError: x\n    at Page' },
      { requestId: 'req-browser-1', accountId: 42, userAgent: 'Mozilla/5.0 test' },
    );
    expect(await flushErrorReporting()).toBe(true);
    const sent = envelopes.join('\n');
    expect(sent).toContain('BrowserError (render)');
    expect(sent).toContain('"source":"browser"');
    expect(sent).toContain('"kind":"render"');
    expect(sent).toContain('"request_id":"req-browser-1"');
    expect(sent).toContain('/verify-email/aov_[redacted]');
    expect(sent).not.toContain(TOKEN);
    expect(lines()[0]).toMatchObject({ source: 'browser', accountId: 42, path: '/verify-email/aov_[redacted]' });
  });
});
