import * as Sentry from '@sentry/node';

/**
 * Error tracking (release audit OPS-06). Every server failure and every browser crash report
 * becomes one structured JSON line on stderr — readable in Railway's logs with no account or
 * vendor. When SENTRY_DSN is set, the same events also go to Sentry: one DSN covers both, since
 * browser reports reach us through /api/client-errors and are forwarded from here, so no Sentry
 * code ships to users' browsers.
 *
 * Sentry is configured to send only what this module passes it: no default integrations (no
 * automatic request, console or HTTP capture), no default PII, no tracing. One-time tokens that
 * can appear in URLs, messages or stacks are redacted in the log line and again in every
 * outgoing Sentry event.
 */

export interface ErrorContext {
  requestId: string;
  method?: string;
  route?: string;
  status?: number;
  accountId?: number | null;
  userAgent?: string;
}

export interface BrowserErrorReport {
  kind: 'render' | 'error' | 'unhandledrejection';
  message: string;
  stack?: string;
  componentStack?: string;
  path?: string;
  release?: string;
}

let sentryEnabled = false;

/** Invitation (aoi_), verification (aov_) and password reset (aor_) tokens. */
export function redactSecrets(text: string): string {
  return text.replace(/\b(ao[ivr]_)[A-Za-z0-9_-]{20,}/g, '$1[redacted]');
}

const clip = (text: unknown, max: number): string | undefined =>
  text == null ? undefined : redactSecrets(String(text)).slice(0, max);

export function initErrorReporting(options: {
  dsn?: string;
  transport?: Sentry.NodeOptions['transport'];
  environment?: string;
  release?: string;
} = {}): boolean {
  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    sentryEnabled = false;
    return false;
  }
  Sentry.init({
    dsn,
    environment: options.environment ?? process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: options.release ?? process.env.RAILWAY_GIT_COMMIT_SHA,
    defaultIntegrations: false,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event) => JSON.parse(redactSecrets(JSON.stringify(event))),
    ...(options.transport ? { transport: options.transport } : {}),
  });
  sentryEnabled = true;
  return true;
}

function logLine(fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), ...fields }));
}

export function reportServerError(err: unknown, ctx: ErrorContext): void {
  const error = err instanceof Error ? err : new Error(String(err));
  logLine({
    source: 'server',
    requestId: ctx.requestId,
    method: ctx.method,
    route: ctx.route,
    status: ctx.status,
    error: { name: error.name, message: clip(error.message, 2000), stack: clip(error.stack, 8000) },
  });
  if (!sentryEnabled) return;
  Sentry.withScope((scope) => {
    scope.setTag('source', 'server');
    scope.setTag('request_id', ctx.requestId);
    if (ctx.route) scope.setTag('route', ctx.route);
    if (ctx.method) scope.setTag('method', ctx.method);
    Sentry.captureException(error);
  });
}

export function reportBrowserError(report: BrowserErrorReport, ctx: ErrorContext): void {
  const fields = {
    kind: report.kind,
    message: clip(report.message, 1000) ?? 'Unknown error',
    stack: clip(report.stack, 8000),
    componentStack: clip(report.componentStack, 8000),
    path: clip(report.path, 500),
    release: clip(report.release, 100),
  };
  const userAgent = clip(ctx.userAgent, 200);
  logLine({ source: 'browser', requestId: ctx.requestId, accountId: ctx.accountId ?? null, userAgent, ...fields });
  if (!sentryEnabled) return;
  Sentry.withScope((scope) => {
    scope.setTag('source', 'browser');
    scope.setTag('request_id', ctx.requestId);
    scope.setTag('kind', report.kind);
    if (fields.path) scope.setTag('path', fields.path);
    if (ctx.accountId) scope.setUser({ id: String(ctx.accountId) });
    scope.setContext('browser_report', { ...fields, userAgent });
    const error = new Error(fields.message);
    error.name = `BrowserError (${report.kind})`;
    if (fields.stack) error.stack = fields.stack;
    Sentry.captureException(error);
  });
}

/** Waits for queued Sentry events to be sent (e.g. before exit). A no-op without Sentry. */
export async function flushErrorReporting(timeoutMs = 2000): Promise<boolean> {
  return sentryEnabled ? Sentry.flush(timeoutMs) : true;
}
