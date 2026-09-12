import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildReport, redactSecrets, reportClientError, resetErrorReportingForTests } from './errorReporting';

const TOKENS = [`aoi_${'a'.repeat(43)}`, `aov_${'b'.repeat(43)}`, `aor_${'c'.repeat(43)}`];

describe('redactSecrets', () => {
  it('removes invitation, verification and reset tokens wherever they appear', () => {
    for (const token of TOKENS) {
      const out = redactSecrets(`failed on /x/${token} and again ${token}.`);
      expect(out).not.toContain(token);
      expect(out).toContain(`${token.slice(0, 4)}[redacted]`);
    }
  });
  it('leaves ordinary text alone', () => {
    expect(redactSecrets('Cannot read properties of undefined (reading "id")')).toBe('Cannot read properties of undefined (reading "id")');
  });
});

describe('buildReport', () => {
  it('uses an Error’s message and stack, redacts the path, and bounds every field', () => {
    const err = new Error('x'.repeat(5000));
    const report = buildReport('render', err, { componentStack: '\n at Page', path: `/reset-password/${TOKENS[2]}` });
    expect(report.kind).toBe('render');
    expect(report.message).toHaveLength(1000);
    expect(report.stack!.length).toBeLessThanOrEqual(8000);
    expect(report.path).toBe('/reset-password/aor_[redacted]');
  });
  it('describes non-Error rejections readably', () => {
    expect(buildReport('unhandledrejection', { status: 503 }, { path: '/' }).message).toBe('{"status":503}');
    expect(buildReport('error', 'plain string', { path: '/' }).message).toBe('plain string');
  });
});

describe('reportClientError', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetErrorReportingForTests();
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the backend endpoint', () => {
    reportClientError('error', new Error('boom'), { path: '/me/mine' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/client-errors');
    expect(JSON.parse(String(init.body))).toMatchObject({ kind: 'error', message: 'boom', path: '/me/mine' });
  });

  it('sends the same problem only once', () => {
    const err = new Error('same');
    reportClientError('error', err, { path: '/' });
    reportClientError('error', err, { path: '/' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops after ten distinct reports on one page', () => {
    for (let i = 0; i < 25; i += 1) reportClientError('error', new Error(`problem ${i}`), { path: '/' });
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('never throws when the network call fails', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    expect(() => reportClientError('error', new Error('while offline'), { path: '/' })).not.toThrow();
  });
});
