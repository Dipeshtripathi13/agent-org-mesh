/** Browser error reporting (release audit OPS-06 / OPS-09): render crashes caught by the error
 *  boundary, plus uncaught errors and rejected promises, posted to the backend's
 *  /api/client-errors, which logs them (and forwards to Sentry when configured). Best effort
 *  and bounded: a page reports at most MAX_REPORTS_PER_PAGE distinct problems, and a failure
 *  to report is never itself reported. */

export type ClientErrorKind = 'render' | 'error' | 'unhandledrejection';

export interface ClientErrorReport {
  kind: ClientErrorKind;
  message: string;
  stack?: string;
  componentStack?: string;
  path?: string;
  release?: string;
}

const MAX_REPORTS_PER_PAGE = 10;
let sent = 0;
const seen = new Set<string>();

/** One-time invitation, verification and reset tokens live in URL paths — never send them. */
export function redactSecrets(text: string): string {
  return text.replace(/\b(ao[ivr]_)[A-Za-z0-9_-]{20,}/g, '$1[redacted]');
}

const clip = (text: string | undefined, max: number) => (text == null ? undefined : redactSecrets(text).slice(0, max));

export function buildReport(
  kind: ClientErrorKind,
  error: unknown,
  extra: { componentStack?: string; path?: string } = {},
): ClientErrorReport {
  const err = error instanceof Error ? error : null;
  const message = err?.message || (typeof error === 'string' ? error : (() => { try { return JSON.stringify(error); } catch { return String(error); } })()) || 'Unknown error';
  const path = extra.path ?? (typeof location !== 'undefined' ? location.pathname : undefined);
  return {
    kind,
    message: clip(message, 1000)!,
    stack: clip(err?.stack, 8000),
    componentStack: clip(extra.componentStack, 8000),
    path: clip(path, 500),
  };
}

export function reportClientError(kind: ClientErrorKind, error: unknown, extra: { componentStack?: string; path?: string } = {}): void {
  if (sent >= MAX_REPORTS_PER_PAGE) return;
  const report = buildReport(kind, error, extra);
  const key = `${report.kind}|${report.message}|${report.stack?.split('\n')[1] ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  sent += 1;
  try {
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      credentials: 'include',
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Reporting must never throw into the page it's reporting on.
  }
}

export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (event) => reportClientError('error', event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event) => reportClientError('unhandledrejection', event.reason));
}

export function resetErrorReportingForTests(): void {
  sent = 0;
  seen.clear();
}
