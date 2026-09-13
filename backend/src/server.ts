import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import {
  generateSessionToken,
  generateTempPassword,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from './domain/auth.js';
import {
  computeConnectorStats,
  computeCoverage,
  computeOrgCoverage,
  nextSurfaceState,
  stateLabel,
} from './domain/coverage.js';
import { encryptSecret } from './domain/crypto.js';
import { assertCredentialKeyUsable } from './domain/credentials.js';
import { installOutboundTimeout, mapWithConcurrency, settleWithConcurrency } from './integrations/outboundHttp.js';
import { initErrorReporting, reportBrowserError, reportServerError, type BrowserErrorReport } from './integrations/errorReporting.js';
import { startActivityRetention } from './db/retention.js';
import { DEFAULT_GRID, deriveAllowedRoles, nextDisposition, respond } from './domain/policy.js';
import { CONFIGURABLE_CLASSES, ROLES } from './domain/types.js';
import type { AccountMainAgent, ConfigurableClass, OrgMainAgent, RequesterRole, RuntimeScope, SurfaceKey } from './domain/types.js';
import * as repo from './db/repo.js';
import type { OrgRole } from './db/repo.js';
import { anthropicConfigured, summarizeDailyActivity } from './integrations/anthropic.js';
import { rawActivityDigest } from './integrations/modelProvider.js';
import { getMainProvider, getPersonalMainProvider } from './integrations/runtimeProvider.js';
import { isSafeExternalUrl } from './integrations/urlSafety.js';
import { formatClaudeCodeDigest, getTodaysClaudeCodeActivity, PROJECT_ROOT } from './integrations/claudeCodeActivity.js';
import { askClaudeCli, claudeCliAvailable } from './integrations/claudeCli.js';
import { disconnectGmail, getGmailStatus, getValidGmailAccessToken, saveGmailConnection } from './integrations/gmailConnection.js';
import { formatGmailDigest, getEmailsSince } from './integrations/gmail.js';
import { buildAuthUrl, exchangeCode, googleConfigured } from './integrations/googleOAuth.js';
import { disconnectGithub, getGithubStatus, saveGithubConnection, disconnectGithubAccount, getGithubAccountStatus, saveGithubAccountConnection } from './integrations/githubConnection.js';
import { disconnectJira, getJiraStatus, saveJiraConnection, disconnectJiraAccount, getJiraAccountStatus, saveJiraAccountConnection } from './integrations/jiraConnection.js';
import { normalizeIngestPayload, recordEvent, recordAccountEvent } from './integrations/eventIngestion.js';
import { runEscalationChecks } from './integrations/escalationEngine.js';
import { generateToken, listTokens, resolveToken, revokeToken, generateAccountToken, listAccountTokens, revokeAccountToken, resolveAccountToken } from './integrations/ingestTokens.js';
import { DEFAULT_SINCE_DAYS, allowedTextOnly } from './integrations/orchestrator.js';
import { gatherAll, verifyProvider } from './integrations/resourceProviders.js';
import { sendInvitationEmail, sendPasswordResetEmail, sendVerificationEmail } from './integrations/resendEmail.js';
import { CONNECTOR_CATALOG } from './integrations/connectorCatalog.js';
import { getGenericConnectionStatus } from './integrations/genericConnection.js';
import { saveLinearConnection, getLinearStatus, disconnectLinear } from './integrations/linear.js';
import { saveNotionConnection, getNotionStatus, disconnectNotion } from './integrations/notion.js';
import { saveConfluenceConnection, getConfluenceStatus, disconnectConfluence } from './integrations/confluence.js';
import { saveAsanaConnection, getAsanaStatus, disconnectAsana } from './integrations/asana.js';
import { saveGitlabConnection, getGitlabStatus, disconnectGitlab } from './integrations/gitlab.js';
import { saveHubspotConnection, getHubspotStatus, disconnectHubspot } from './integrations/hubspot.js';
import { saveZendeskConnection, getZendeskStatus, disconnectZendesk } from './integrations/zendesk.js';
import { saveTrelloConnection, getTrelloStatus, disconnectTrello } from './integrations/trello.js';
import { saveAirtableConnection, getAirtableStatus, disconnectAirtable } from './integrations/airtable.js';
import { saveMondayConnection, getMondayStatus, disconnectMonday } from './integrations/monday.js';
import { saveFigmaConnection, getFigmaStatus, disconnectFigma } from './integrations/figma.js';
import { saveDiscordConnection, getDiscordStatus, disconnectDiscord } from './integrations/discord.js';
import { saveAirflowConnection, getAirflowStatus, disconnectAirflow } from './integrations/airflow.js';
import { saveDbtConnection, getDbtStatus, disconnectDbt } from './integrations/dbtCloud.js';
import { saveSnowflakeConnection, getSnowflakeStatus, disconnectSnowflake } from './integrations/snowflake.js';
import { saveDatabricksConnection, getDatabricksStatus, disconnectDatabricks } from './integrations/databricks.js';
import { ACCOUNT_CONNECT_HANDLERS, ACCOUNT_DISCONNECT_HANDLERS, ACCOUNT_STATUS_HANDLERS, ACCOUNT_DIGEST_PROVIDERS, accountCustomAgentProviders, verifyAccountProvider } from './integrations/personalConnectors.js';

const isProduction = process.env.NODE_ENV === 'production';

// Tool credentials are encrypted at rest (domain/credentials.ts). Refuse to start without a
// usable key rather than failing every connect and every read at request time.
if (isProduction) assertCredentialKeyUsable();

// Every outbound call gets a deadline unless it sets its own (release audit OPS-04).
installOutboundTimeout(Number(process.env.OUTBOUND_TIMEOUT_MS ?? 20_000));

// Structured error logs always; also sent to Sentry once SENTRY_DSN is set (release audit OPS-06).
initErrorReporting();

// trustProxy: this sits behind Railway's own reverse proxy in production, so req.ip has
// to come from the forwarded header or every request looks like it's from the same
// address — both for rate limiting below and for anything else that ever keys on IP.
//
// `logger: false` used to mean every one of this file's own `app.log.error(...)` calls
// (a real one sits right next to the ask-personal digest-bridge fix — see CLAUDE.md) was
// silently going nowhere: Fastify still hands back a working `app.log` interface when
// logging is disabled, so `.error()` never threw or warned, it just quietly did nothing.
// Found live, mid-debugging a real production issue: `railway logs` produced zero output
// for any request, to any endpoint, ever — not just this one connector's error. `level:
// 'warn'` keeps the default per-request info-level noise out of production logs while
// making every real `.error()`/`.warn()` call actually reach stdout, which is what
// Railway's log capture reads from.
// Trust exactly one proxy hop (Railway's), so req.ip is the address Railway appended — the
// rightmost X-Forwarded-For entry — and anything a client writes to its left is ignored.
// `true` trusted every hop, so req.ip was whatever the client wrote first and the login
// limiter was bypassable by rotating that header (release audit SEC-07, confirmed live).
// Not the numeric form `1`: measured on this Fastify version, a number is silently ignored
// and req.ip becomes the proxy's own address — one shared login limit for every user.
const app = Fastify({
  logger: { level: 'warn' },
  trustProxy: (_address: string, hop: number) => hop < 1,
  // Largest legitimate body is a Snowflake PEM key (~2 KB); 256 KB leaves ample headroom.
  bodyLimit: 256 * 1024,
  // Fastify's default is no limit. Long enough for ask-multi across 20 people with slow tools.
  requestTimeout: 120_000,
  // Keep a caller's correlation ID when it looks like one, otherwise mint a UUID.
  genReqId: (req) => {
    const incoming = req.headers['x-request-id'];
    return typeof incoming === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  },
});
// Same-origin once frontend and API are served from this one process (see the static
// registration below) — cross-origin requests have no legitimate reason to hit this API
// in production, so CORS is disabled outright there rather than left permissively open.
// Local dev keeps `origin: true` since the Vite dev server (:5173) is a different origin
// from the API (:3001).
await app.register(cors, { origin: isProduction ? false : true, credentials: true });
// Standard security headers (CSP, X-Content-Type-Options, X-Frame-Options, HSTS, ...) —
// found missing entirely during a security audit. Defaults are already a good fit for a
// same-origin SPA+API (everything's served from this one process in production, see the
// static registration below): default-src 'self' covers the built frontend's own script/
// style/fetch calls with nothing to relax. crossOriginEmbedderPolicy is disabled — it's
// an isolation feature this app has no use for (no SharedArrayBuffer, nothing embedding
// cross-origin resources) and is a known source of breakage for OAuth redirect flows
// (Gmail) in some browsers.
await app.register(helmet, { crossOriginEmbedderPolicy: false });
await app.register(cookie);
// A generous global ceiling (every route not given its own stricter config below still
// gets one) plus much tighter per-route limits on login/signup specifically, where the
// real risk is — unlimited attempts against a known or guessed email. Keyed on IP; on
// Railway that's the proxy-forwarded client IP, not the load balancer's own address,
// since `trustProxy` is on.
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

// Fastify's default error handler echoes err.message (and, for a raw thrown error, its
// name/code) straight into the response — fine locally, a real information leak once
// this is a public URL: a malformed request was returning the exact Postgres error code
// and message, confirming the stack (Postgres, its column types) to anyone probing it.
// Validation errors (400s Fastify raises itself, e.g. `question is required` — already
// meant to be seen) keep their real message; anything else collapses to one generic
// line. The real error still goes to console.error either way (app.log is a no-op — see
// the account+RBAC section below), so nothing is lost server-side.
app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  const status = err.statusCode ?? 500;
  // 4xx here are expected rejections (schema validation, oversized bodies) — logging them
  // as errors would bury real failures.
  if (status < 500) {
    reply.code(status).send({ error: err.message });
    return;
  }
  // One structured line per failure (and to Sentry when SENTRY_DSN is set). The route
  // pattern is logged, never the raw URL, which can carry one-time tokens.
  reportServerError(err, { requestId: req.id, method: req.method, route: req.routeOptions?.url ?? 'unmatched', status });
  // The request ID lets a person quote exactly which failure they hit.
  reply.code(500).send({ error: 'internal server error', requestId: req.id });
});

// Every response carries its request ID, so a browser report, a log line and a support
// question can all be matched to the same request.
app.addHook('onRequest', async (req, reply) => {
  reply.header('x-request-id', req.id);
});

/* ---------- request validation (release audit SEC-13) ----------
   Handlers used to cast req.body with no checks: a missing targetId was a 500, an unknown
   person id a 500, and POST /api/policy/cycle indexed the grid with any string (role
   "__proto__" wrote through to Object.prototype). Fastify validates these schemas before a
   handler runs and answers 400 with the reason; handlers keep their own trim/business checks. */

const MAX_INT4 = 2147483647;
const ID = { type: 'integer', minimum: 1, maximum: MAX_INT4 } as const;
const str = (maxLength: number, minLength = 0) => ({ type: 'string', minLength, maxLength }) as const;
const nullableStr = (maxLength: number) => ({ type: ['string', 'null'], maxLength }) as const;
const EMAIL = { type: 'string', maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' } as const;
const PASSWORD = str(128, 1);
const NEW_PASSWORD = str(128, 8);
const ROLE = { type: 'string', enum: [...ROLES] } as const;
const ORG_ROLE = { type: 'string', enum: ['owner', 'admin', 'viewer'] } as const;
const UUID = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' } as const;
const QUESTION = str(2000);
const bodySchema = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ body: { type: 'object', required, properties } }) as const;

// Every numeric id in a path is validated here once, so no route can forget it.
// (Claim, escalation, token and custom-agent ids are strings/uuids and are left alone.)
app.addHook('onRoute', (route) => {
  const schema = (route.schema ?? {}) as { params?: unknown };
  if (schema.params) return;
  const names = [...route.url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
  const numeric = names.filter((n) => ['orgId', 'personId', 'adminId'].includes(n) || (n === 'id' && route.url.startsWith('/api/person/')));
  if (numeric.length === 0) return;
  route.schema = {
    ...route.schema,
    params: { type: 'object', properties: Object.fromEntries(numeric.map((n) => [n, ID])) },
  };
});

/* ---------- mandatory email verification gate ----------
   A self-serve signup can't use the product until it proves its email address: otherwise
   anyone could register someone else's address and hold it. Enforced here, before every
   handler, rather than trusted to the UI. Only the routes needed to verify, recover or leave
   the account stay open; everything else answers 403 with code `email_unverified`. Accounts
   created before this existed have email_verification_required = false and are unaffected. */
const VERIFICATION_EXEMPT_ROUTES = new Set([
  '/api/auth/login', '/api/auth/signup', '/api/auth/logout', '/api/auth/me', '/api/auth/change-password',
  '/api/auth/verify-email', '/api/auth/verify-email/resend',
  '/api/auth/password-reset/request', '/api/auth/password-reset/confirm',
  '/api/invitations/:token', '/api/invitations/:token/accept',
  '/api/runtimes', '/api/connectors/catalog', '/api/ingest/:source',
  '/api/client-errors',
]);
app.addHook('preHandler', async (req, reply) => {
  const route = req.routeOptions.url;
  if (!route || !route.startsWith('/api/') || VERIFICATION_EXEMPT_ROUTES.has(route)) return;
  const session = await currentSession(req);
  if (session?.verificationPending) {
    return reply.code(403).send({
      error: 'Verify your email address to continue — use the link we sent you, or ask for a new one.',
      code: 'email_unverified',
    });
  }
});

// Where the browser lands to sign in — used both for post-Gmail-OAuth redirects (already
// existed) and now for the login link in invite emails.
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 0 (never a real org) when missing or malformed, so every gate below fails closed —
 *  this used to default to org 1, quietly pointing an id-less request at the first org. */
function orgIdFromQuery(req: { query: unknown }): number {
  const q = req.query as { orgId?: string };
  const parsed = Number(q.orgId);
  // Above int4 the database would reject the query with a 500; treat it as no org instead.
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2147483647 ? parsed : 0;
}

/* ---------- platform: real account authentication + RBAC ----------
   Server-side sessions (backend/src/db/repo.ts's sessions table), not JWTs — a random
   token in an httpOnly/sameSite cookie, looked up by its SHA-256 hash, exactly the
   pattern ingest_tokens already established. `secure` follows `isProduction`: off for
   local dev (plain http, matching person_oauth_tokens' plaintext-token comment in
   0001_baseline.sql — honest about the dev-only posture, not pretending otherwise), on for a
   real deployment (always served over HTTPS there — a `secure` cookie over plain http
   is simply never sent, so this must flip the moment it's actually running anywhere
   real).

   One account, two independent facts: whether it administers any orgs (org_admins) and
   whether it's linked to any org-chart identities (people.account_id, resolved via
   getPeopleForAccount). Login is the same for both — the Admin panel and "My agent" are
   different *views*, not different accounts. */

const SESSION_COOKIE = 'aom_session';
const OAUTH_STATE_COOKIE = 'aom_oauth_state';
// 7 days, down from 30 — found during a security audit: a 30-day fixed TTL with no idle
// timeout meant a leaked/stolen session cookie stayed valid for up to a month regardless
// of activity. True idle-timeout (sliding renewal) would need `reply` threaded through
// every currentAccountId call site to also refresh the cookie's own client-side expiry,
// not just the DB row — real, larger follow-up work, not done here; this is the
// proportionate fix for now (a 4x-shorter fixed exposure window).
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** `elevate: true` is only for self-serve signup (see its own call site below): creating
 *  a brand-new organization is itself the act of typing this exact account's password
 *  moments earlier, so treating that as already having proven it once — skipping an
 *  immediate, redundant step-up prompt seconds later — is a real judgment call, not a
 *  loophole. A plain login never passes this; that's what keeps "log in" and "log in as
 *  admin" two genuinely separate steps everywhere else. */
async function setSessionCookie(
  reply: { setCookie: (...a: any[]) => void },
  accountId: number,
  opts?: { elevate?: boolean },
): Promise<void> {
  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const tokenHash = hashSessionToken(token);
  await repo.createSession(accountId, tokenHash, now.toISOString(), expiresAt.toISOString());
  if (opts?.elevate) {
    await repo.elevateSession(tokenHash, new Date(now.getTime() + ELEVATION_WINDOW_MS).toISOString());
  }
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: isProduction, expires: expiresAt,
  });
}

/** The entire authentication boundary for this app — identity comes from the session
 *  cookie's hash, never from anything a request body or query string claims. Returns
 *  null (never throws) so every route decides its own 401 vs. "treat as logged out"
 *  response shape. */
async function currentSession(
  req: { cookies: Record<string, string | undefined> },
): Promise<{ accountId: number; elevatedUntil: string | null; verificationPending: boolean } | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  return repo.resolveSession(hashSessionToken(token), new Date().toISOString());
}

async function currentAccountId(req: { cookies: Record<string, string | undefined> }): Promise<number | null> {
  const session = await currentSession(req);
  return session?.accountId ?? null;
}

const ROLE_RANK: Record<OrgRole, number> = { viewer: 1, admin: 2, owner: 3 };

// Step-up auth (a.k.a. "sudo mode"): a normal login is enough to answer questions about
// yourself in "My agent", but every Admin-panel-scoped action — creating an organization,
// managing admins/people, editing policy, reading the audit log — additionally requires
// having re-entered the account's password within this window (POST /api/auth/step-up).
// 15 minutes mirrors GitHub's own sudo-mode default; short on purpose, since re-elevating
// is one password prompt away and a stale elevation is exactly what a stolen-cookie
// attacker would want to inherit for free.
const ELEVATION_WINDOW_MS = 15 * 60 * 1000;

function isElevated(elevatedUntil: string | null): boolean {
  return elevatedUntil != null && new Date(elevatedUntil).getTime() > Date.now();
}

type OrgRoleCheck = { ok: true; accountId: number } | { ok: false; code: 401 | 403 | 428; error: string };

/** Resolves the session, then checks its role for this specific org is at least
 *  `minRole`, AND that the session is currently elevated (see ELEVATION_WINDOW_MS above)
 *  — every one of this function's call sites is an Admin-panel action, so this is the one
 *  place that requirement needs to live for all of them to inherit it. Returns a
 *  discriminated result rather than mutating `reply` and having callers re-read its status
 *  code back out — every call site sets its own reply.code from `result.code` and returns
 *  `{ error: result.error }` directly. 428 ("Precondition Required") is what the frontend
 *  watches for to distinguish "re-enter your password" from a genuine, unrecoverable 403.
 *  Mirrors verifyRequesterRole's shape below (the analogous check for a *person's* claimed
 *  org-chart role on /api/agent/ask). */
/** `elevated`, when true, additionally requires step-up (a fresh password re-entry within
 *  the last 15 minutes) on top of the role check — reserved for genuinely destructive or
 *  security-sensitive writes (inviting/removing an admin, changing an admin's role,
 *  removing a person from the chart, setting the org's main-agent credentials, editing
 *  policy), never for reads or routine writes. Defaults to false: most of this function's
 *  callers are reads (Overview, Coverage, Audit log, Connections, admins list) or
 *  low-stakes writes (adding a person to the chart) that only ever needed the role check,
 *  not a re-auth prompt on top of it.
 *
 *  This replaces step-up gating the *entire* Admin panel on every visit — found, after
 *  research into how GitHub/Stripe/Google Workspace/NIST 800-63B/OWASP actually handle
 *  this, to be a real outlier: none of them re-authenticate on *entering* an admin area,
 *  only on the specific sensitive action itself (GitHub's own docs: sudo mode triggers on
 *  adding an SSH key or authorizing an OAuth app, never on viewing settings). Blanket
 *  re-auth on every entry is also the documented UX failure mode OWASP's Transaction
 *  Authorization framing and NIST's assurance-level session timeouts both implicitly argue
 *  against: it trains people to treat the prompt as noise rather than a real signal. */
async function requireOrgRole(
  req: { cookies: Record<string, string | undefined> },
  orgId: number,
  minRole: OrgRole,
  deniedMessage: string,
  options: { elevated?: boolean } = {},
): Promise<OrgRoleCheck> {
  const session = await currentSession(req);
  if (session == null) return { ok: false, code: 401, error: 'log in first' };
  const role = await repo.getOrgRole(orgId, session.accountId);
  if (role == null || ROLE_RANK[role] < ROLE_RANK[minRole]) return { ok: false, code: 403, error: deniedMessage };
  if (options.elevated && !isElevated(session.elevatedUntil)) return { ok: false, code: 428, error: 'admin re-authentication required' };
  return { ok: true, accountId: session.accountId };
}

/** Same elevation check as requireOrgRole, for the one Admin action that has no orgId yet
 *  to check a role against: creating a brand-new organization from inside an already-
 *  logged-in session (Admin → Organizations → New organization — distinct from
 *  POST /api/auth/signup's self-serve "New here?" path, which is intentionally not
 *  elevation-gated since there's no existing session to elevate). */
async function requireElevatedSession(
  req: { cookies: Record<string, string | undefined> },
): Promise<OrgRoleCheck> {
  const session = await currentSession(req);
  if (session == null) return { ok: false, code: 401, error: 'log in first' };
  if (!isElevated(session.elevatedUntil)) return { ok: false, code: 428, error: 'admin re-authentication required' };
  return { ok: true, accountId: session.accountId };
}

type OrgAccessCheck =
  | { ok: true; accountId: number; personId: number | null; orgRole: OrgRole | null }
  | { ok: false; code: 401 | 403; error: string };

/** Org-scoped reads that both members ("My agent") and admins (Admin panel) legitimately
 *  make — the roster, the policy grid, the main-agent choice. Requires a session that is
 *  a person in this org or holds any admin role for it. Closes release-audit SEC-04: these
 *  were fully public, and org ids are sequential. */
async function requireOrgAccess(req: { cookies: Record<string, string | undefined> }, orgId: number): Promise<OrgAccessCheck> {
  const accountId = await currentAccountId(req);
  if (accountId == null) return { ok: false, code: 401, error: 'log in first' };
  if (!orgId) return { ok: false, code: 403, error: 'not authorized for this organization' };
  const [people, orgRole] = await Promise.all([repo.getPeopleForAccount(accountId), repo.getOrgRole(orgId, accountId)]);
  const personId = people.find((p) => p.orgId === orgId)?.id ?? null;
  if (personId == null && orgRole == null) return { ok: false, code: 403, error: 'not authorized for this organization' };
  return { ok: true, accountId, personId, orgRole };
}

type SessionPersonCheck =
  | { ok: true; accountId: number; personId: number }
  | { ok: false; code: 401 | 403 | 404; error: string };

/** The only way a request acts as an org-chart person: the logged-in session's own linked
 *  identity in `orgId`. Never a requesterId/actorPersonId/personId from the request — the
 *  release audit (SEC-01/02/05) confirmed live that falling back to a client-asserted id
 *  whenever there was no session let an anonymous caller ask as the CEO, preview anyone at
 *  Executive tier, and push fabricated activity into anyone's claims. */
async function requireSessionPerson(
  req: { cookies: Record<string, string | undefined> },
  orgId: number,
  notMemberError = 'you are not a member of this organization',
): Promise<SessionPersonCheck> {
  const accountId = await currentAccountId(req);
  if (accountId == null) return { ok: false, code: 401, error: 'log in first' };
  const person = (await repo.getPeopleForAccount(accountId)).find((p) => p.orgId === orgId);
  if (!person) return { ok: false, code: 403, error: notMemberError };
  return { ok: true, accountId, personId: person.id };
}

const orgIdOfPersonOrNull = (id: number) =>
  Number.isInteger(id) && id > 0 ? repo.getOrgIdOfPerson(id).catch(() => null) : Promise.resolve(null);

// Fixed, never-logged-into hash — burned in a scrypt comparison below whenever an email
// doesn't resolve to a real account, so a nonexistent email takes the same real scrypt
// time as a wrong password on a real one. Without this, verifyPassword was only ever
// called on the "account exists" branch, so response time alone told an attacker which
// emails have real accounts — same class of bug as a different error message would be,
// just via a timing channel instead of response content.
const DUMMY_PASSWORD_HASH = hashPassword(randomUUID());

// Per-email failed-login counter, alongside the per-IP route limit: the IP limit alone lets a
// distributed attacker (many IPs) grind one known account. Counts failures only, resets on
// success, and is checked for unknown emails too so it can't be used to probe which exist.
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();
function loginLockedOut(email: string): boolean {
  const entry = loginFailures.get(email);
  if (!entry) return false;
  if (entry.resetAt <= Date.now()) {
    loginFailures.delete(email);
    return false;
  }
  return entry.count >= LOGIN_FAILURE_LIMIT;
}
function recordLoginFailure(email: string): void {
  const now = Date.now();
  if (loginFailures.size > 10_000) {
    for (const [key, value] of loginFailures) if (value.resetAt <= now) loginFailures.delete(key);
  }
  const entry = loginFailures.get(email);
  if (!entry || entry.resetAt <= now) loginFailures.set(email, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
  else entry.count += 1;
}

app.post('/api/auth/login', {
  config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  schema: bodySchema({ email: str(254, 1), password: PASSWORD }, ['email', 'password']),
}, async (req, reply) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email?.trim() || !password) {
    reply.code(400);
    return { error: 'email and password are required' };
  }
  const normalizedEmail = email.trim().toLowerCase();
  if (loginLockedOut(normalizedEmail)) {
    reply.code(429);
    return { error: 'too many failed sign-in attempts for this account — wait 15 minutes and try again' };
  }
  const account = await repo.getAccountByEmail(normalizedEmail);
  const ok = verifyPassword(password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!account?.passwordHash || !ok) {
    recordLoginFailure(normalizedEmail);
    reply.code(401);
    return { error: 'invalid email or password' };
  }
  loginFailures.delete(normalizedEmail);
  await setSessionCookie(reply, account.id);
  // Typed as repo.Account deliberately, rather than an inline object literal: this has to
  // stay an explicit allowlist (getAccountByEmail also carries passwordHash, which must
  // never leave the server), but an allowlist silently goes stale when the type grows —
  // which is exactly what happened when `mustChangePassword` was added and this response
  // kept claiming to be an Account without it. Annotating it makes that a compile error
  // instead of a field that quietly arrives as undefined.
  const safeAccount: repo.Account = {
    id: account.id,
    name: account.name,
    email: account.email,
    mustChangePassword: account.mustChangePassword,
    emailVerified: account.emailVerified,
    emailVerificationPending: account.emailVerificationPending,
  };
  return { account: safeAccount };
});

/** Self-serve signup — creates a personal account *and* a one-person organization for it,
 *  in the same step, so a brand-new signup can start using the product (set up its own
 *  main agent, ask itself questions) immediately, with nothing left to configure first.
 *  Accounts and organizations are still fully decoupled data-wise (an account can exist
 *  with zero orgs — e.g. one only ever added to someone else's chart by email — and
 *  `POST /api/organizations` still exists for creating an *additional* org later), but
 *  requiring a separate, deliberate "create an organization" click right after signup
 *  turned out to be the wrong shape for the common case: most people trying this out are
 *  one person, not a company standing up a multi-person chart, and they shouldn't have to
 *  name a company just to try it. The org name is auto-derived (`"<name>'s workspace"`,
 *  renameable later like any org) rather than asked for here. The new session is elevated
 *  immediately (`{ elevate: true }`) — typing your password to sign up already proves it,
 *  same reasoning as every other "you just authenticated, don't ask again immediately"
 *  case in this codebase — so the owner can go straight to Admin → Organizations and set
 *  their own main agent with no extra re-auth prompt. Rejects emails that already have a
 *  real (password-holding) account rather than doing something ambiguous with them;
 *  someone re-using an email should log in instead. */
app.post('/api/auth/signup', {
  config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  schema: bodySchema({ name: str(120, 1), email: EMAIL, password: NEW_PASSWORD }, ['name', 'email', 'password']),
}, async (req, reply) => {
  const { name, email, password } = req.body as { name?: string; email?: string; password?: string };
  if (!name?.trim() || !email?.trim() || !password) {
    reply.code(400);
    return { error: 'name, email, and password are required' };
  }
  if (password.length < 8) {
    reply.code(400);
    return { error: 'password must be at least 8 characters' };
  }
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await repo.getAccountByEmail(normalizedEmail);
  if (existing?.passwordHash) {
    reply.code(409);
    return { error: 'an account already exists for this email — log in, or reset the password if you can’t' };
  }
  const trimmedName = name.trim();
  // Verification is required before the account can do anything but verify (see the gate).
  const account = await repo.insertAccount(trimmedName, normalizedEmail, hashPassword(password), false, true);
  const { organization, person } = await repo.createOrganization(account.id, trimmedName, `${trimmedName}'s workspace`);
  await repo.insertInitialRevision(organization.id, structuredClone(DEFAULT_GRID));
  await setSessionCookie(reply, account.id, { elevate: true });
  const verificationEmailSent = await sendVerificationLink(account);
  return { account, organization, person, verificationEmailSent };
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await repo.revokeSession(hashSessionToken(token), new Date().toISOString());
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/api/auth/me', async (req) => {
  const session = await currentSession(req);
  if (session == null) return { account: null, orgRoles: {}, people: [], adminElevatedUntil: null };
  const [account, orgRoles, people] = await Promise.all([
    repo.getAccount(session.accountId),
    repo.getOrgRolesForAccount(session.accountId),
    repo.getPeopleForAccount(session.accountId),
  ]);
  return { account, orgRoles, people, adminElevatedUntil: isElevated(session.elevatedUntil) ? session.elevatedUntil : null };
});

// Step-up ("log in as admin"): re-verifies the already-logged-in account's own password
// and, only on success, elevates its existing session for ELEVATION_WINDOW_MS. Not a
// second, separate login — same session cookie, same account, no new identity — which is
// exactly what makes this a real second factor of "are you still you" rather than a
// second copy of the first factor. Rate-limited like login/change-password so a stolen
// session cookie can't be used to grind the account's own password.
app.post('/api/auth/step-up', {
  config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  schema: bodySchema({ password: PASSWORD }, ['password']),
}, async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  const accountId = await currentAccountId(req);
  if (accountId == null || !token) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const { password } = req.body as { password?: string };
  const account = await repo.getAccount(accountId);
  const full = account ? await repo.getAccountByEmail(account.email) : null;
  const ok = full?.passwordHash && verifyPassword(password ?? '', full.passwordHash);
  if (!ok) {
    reply.code(401);
    return { error: 'incorrect password' };
  }
  const until = new Date(Date.now() + ELEVATION_WINDOW_MS);
  await repo.elevateSession(hashSessionToken(token), until.toISOString());
  return { adminElevatedUntil: until.toISOString() };
});

// Rate-limited the same way login is (10/15min) — found during a security audit: this
// previously only inherited the generous global 300/min ceiling, giving up to 300
// guesses/minute at currentPassword to anyone holding a stolen session cookie.
app.post('/api/auth/change-password', {
  config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  schema: bodySchema({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, ['currentPassword', 'newPassword']),
}, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'not logged in' };
  }
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (!newPassword || newPassword.length < 8) {
    reply.code(400);
    return { error: 'new password must be at least 8 characters' };
  }
  const account = await repo.getAccountByEmail((await repo.getAccount(accountId))!.email);
  if (!account?.passwordHash || !verifyPassword(currentPassword ?? '', account.passwordHash)) {
    reply.code(401);
    return { error: 'current password is incorrect' };
  }
  if (newPassword === currentPassword) {
    reply.code(400);
    return { error: 'the new password must be different from the current one' };
  }
  // Clears must_change_password in the same statement — this is the only path out of a
  // forced change, and reaching it required proving the current password.
  await repo.setAccountPassword(accountId, hashPassword(newPassword));
  // OWASP's Forgot Password guidance: a successful change invalidates every *other*
  // session, so a cookie stolen before the change stops working. The caller's own session
  // is spared so changing your password doesn't log you out of the tab you did it in.
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    await repo.revokeOtherSessionsForAccount(accountId, hashSessionToken(token), new Date().toISOString());
  }
  return { ok: true };
});

/* ---------- platform: organizations ---------- */

app.get('/api/organizations', async (req) => {
  const accountId = await currentAccountId(req);
  return { organizations: accountId == null ? [] : await repo.listOrganizationsForAccount(accountId) };
});

app.post('/api/organizations', { schema: bodySchema({ name: str(120, 1) }, ['name']) }, async (req, reply) => {
  const check = await requireElevatedSession(req);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const { name } = req.body as { name: string };
  if (!name?.trim()) {
    reply.code(400);
    return { error: 'name is required' };
  }
  const creator = await repo.getAccount(check.accountId);
  // The creator becomes this org's first person too (Owner, top of the chart), not just
  // its admin — otherwise a brand-new individual (accounts and orgs are fully decoupled
  // now, see /api/auth/signup) would create an org and land in it with nobody in the
  // chart, including themselves.
  const { organization, person } = await repo.createOrganization(check.accountId, creator!.name, name.trim());
  // Every organization needs a policy revision to exist before anyone can be asked about —
  // seed it with the platform default grid, exactly like the very first org was seeded.
  await repo.insertInitialRevision(organization.id, structuredClone(DEFAULT_GRID));
  return { organization, person };
});

/* ---------- org access: real multi-admin RBAC ----------
   owner-only to invite/promote/remove; viewer+ to just see who has access. Inviting an
   admin who doesn't exist yet on the platform creates them with a one-time temp
   password — there's no transactional email sending in this app (Gmail is personal
   OAuth ingestion, not that), so it's returned once in the response, same "shown once"
   pattern ingest tokens already use in the UI. */

app.get('/api/organizations/:orgId/admins', async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const check = await requireOrgRole(req, orgId, 'viewer', 'not authorized for this organization');
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  return { admins: await repo.listOrgAdmins(orgId) };
});

app.post('/api/organizations/:orgId/admins', {
  schema: bodySchema({ email: EMAIL, name: str(120), role: ORG_ROLE }, ['email', 'role']),
}, async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const check = await requireOrgRole(req, orgId, 'owner', 'only an owner can invite admins', { elevated: true });
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }

  const { email, role } = req.body as { email?: string; role?: OrgRole };
  if (!email?.trim() || !role || !['owner', 'admin', 'viewer'].includes(role)) {
    reply.code(400);
    return { error: 'email and a valid role (owner/admin/viewer) are required' };
  }
  // The role takes effect only when an account with this email accepts the one-time link
  // (release audit SEC-08) — never by matching an account that happens to exist.
  const org = await repo.getOrganization(orgId);
  const invite = await issueInvitation({
    orgId, email: email.trim().toLowerCase(), kind: 'admin', personId: null, adminRole: role,
    invitedBy: check.accountId, roleDescription: `an admin (${role}) for ${org.name}`,
  });
  return { invite };
});

app.patch('/api/organizations/:orgId/admins/:adminId', { schema: bodySchema({ role: ORG_ROLE }, ['role']) }, async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const targetAdminId = Number((req.params as { adminId: string }).adminId);
  const check = await requireOrgRole(req, orgId, 'owner', 'only an owner can change roles', { elevated: true });
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }

  const { role } = req.body as { role?: OrgRole };
  if (!role || !['owner', 'admin', 'viewer'].includes(role)) {
    reply.code(400);
    return { error: 'a valid role (owner/admin/viewer) is required' };
  }
  const currentRole = await repo.getOrgRole(orgId, targetAdminId);
  if (currentRole === 'owner' && role !== 'owner' && (await repo.countOrgOwners(orgId)) <= 1) {
    reply.code(409);
    return { error: 'cannot demote the last owner — promote someone else first' };
  }
  await repo.setOrgAdminRole(orgId, targetAdminId, role);
  return { ok: true };
});

app.delete('/api/organizations/:orgId/admins/:adminId', async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const targetAdminId = Number((req.params as { adminId: string }).adminId);
  const check = await requireOrgRole(req, orgId, 'owner', 'only an owner can remove admins', { elevated: true });
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }

  const currentRole = await repo.getOrgRole(orgId, targetAdminId);
  if (currentRole === 'owner' && (await repo.countOrgOwners(orgId)) <= 1) {
    reply.code(409);
    return { error: 'cannot remove the last owner' };
  }
  await repo.removeOrgAdmin(orgId, targetAdminId);
  return { ok: true };
});

/* ---------- browser error reports (release audit OPS-06 / OPS-09) ----------
   The frontend's crash screen and global error listeners post here. Anonymous on purpose —
   a crash on the sign-in page matters as much as one behind it — so it's rate limited,
   size-bounded by schema, and never trusted for anything but a log line. Secrets that can
   appear in a browser path (invite, verification and reset tokens) are redacted server-side
   too, whatever the client already did. */
app.post('/api/client-errors', {
  config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
  schema: bodySchema({
    kind: { type: 'string', enum: ['render', 'error', 'unhandledrejection'] },
    message: str(1000, 1),
    stack: str(8000),
    componentStack: str(8000),
    path: str(500),
    release: str(100),
  }, ['kind', 'message']),
}, async (req, reply) => {
  const accountId = await currentAccountId(req).catch(() => null);
  reportBrowserError(req.body as BrowserErrorReport, {
    requestId: req.id,
    accountId,
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
  });
  return reply.code(204).send();
});

/* ---------- email verification and self-service password reset ----------
   Both are one-time links mailed to the account's address (repo.createEmailToken): random
   token, SHA-256 hash at rest, single-use, only the newest of each kind valid. Verification
   links last 24 hours, reset links 30 minutes (OWASP Forgot Password guidance). */

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const appUrl = (path: string) => `${FRONTEND_URL.replace(/\/+$/, '')}${path}`;

async function issueEmailToken(accountId: number, email: string, purpose: repo.EmailTokenPurpose): Promise<string> {
  const token = `${purpose === 'verify' ? 'aov_' : 'aor_'}${randomBytes(32).toString('base64url')}`;
  const now = new Date();
  await repo.createEmailToken({
    accountId, email, purpose, tokenHash: hashSessionToken(token), now: now.toISOString(),
    expiresAt: new Date(now.getTime() + (purpose === 'verify' ? VERIFY_TTL_MS : RESET_TTL_MS)).toISOString(),
  });
  return token;
}

async function sendVerificationLink(account: { id: number; name: string; email: string }): Promise<boolean> {
  try {
    const token = await issueEmailToken(account.id, account.email, 'verify');
    return await sendVerificationEmail({ to: account.email, name: account.name, verifyUrl: appUrl(`/verify-email/${token}`) });
  } catch (err) {
    console.error({ err }, 'verification email failed');
    return false;
  }
}

/** No session needed: the link may be opened on a different device from the signup. */
app.post('/api/auth/verify-email', {
  config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
  schema: bodySchema({ token: { type: 'string', pattern: '^aov_[A-Za-z0-9_-]{43}$' } }, ['token']),
}, async (req, reply) => {
  const { token } = req.body as { token: string };
  const result = await repo.verifyEmailWithToken(hashSessionToken(token), new Date().toISOString());
  if (!result.ok) {
    reply.code(result.code);
    return { error: result.error };
  }
  return { verified: true };
});

app.post('/api/auth/verify-email/resend', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const account = await repo.getAccount(accountId);
  if (!account) {
    reply.code(401);
    return { error: 'log in first' };
  }
  if (account.emailVerified) return { sent: false, alreadyVerified: true };
  return { sent: await sendVerificationLink(account) };
});

// Per-address throttle on reset emails, on top of the per-IP route limit, so nobody can flood
// one inbox by rotating addresses. Over the limit, the response is identical and nothing is sent.
const RESET_EMAILS_PER_HOUR = 3;
const resetRequests = new Map<string, number[]>();
function resetEmailAllowed(email: string): boolean {
  const now = Date.now();
  const recent = (resetRequests.get(email) ?? []).filter((t) => now - t < 60 * 60 * 1000);
  if (resetRequests.size > 10_000) {
    for (const [key, times] of resetRequests) if (times.every((t) => now - t >= 60 * 60 * 1000)) resetRequests.delete(key);
  }
  if (recent.length >= RESET_EMAILS_PER_HOUR) {
    resetRequests.set(email, recent);
    return false;
  }
  resetRequests.set(email, [...recent, now]);
  return true;
}

/** Always the same answer, returned before the lookup and send happen, so neither the body nor
 *  the response time says whether an account exists for this address. */
app.post('/api/auth/password-reset/request', {
  config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  schema: bodySchema({ email: str(254, 1) }, ['email']),
}, async (req) => {
  const email = (req.body as { email: string }).email.trim().toLowerCase();
  if (resetEmailAllowed(email)) {
    void (async () => {
      try {
        const account = await repo.getAccountByEmail(email);
        if (!account) return;
        const token = await issueEmailToken(account.id, account.email, 'reset');
        await sendPasswordResetEmail({ to: account.email, name: account.name, resetUrl: appUrl(`/reset-password/${token}`) });
      } catch (err) {
        console.error({ err }, 'password reset email failed');
      }
    })();
  }
  return { ok: true, message: 'If an account exists for that email, a password reset link is on its way.' };
});

app.post('/api/auth/password-reset/confirm', {
  config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  schema: bodySchema({ token: { type: 'string', pattern: '^aor_[A-Za-z0-9_-]{43}$' }, newPassword: NEW_PASSWORD }, ['token', 'newPassword']),
}, async (req, reply) => {
  const { token, newPassword } = req.body as { token: string; newPassword: string };
  const result = await repo.resetPasswordWithToken(hashSessionToken(token), hashPassword(newPassword), new Date().toISOString());
  if (!result.ok) {
    reply.code(result.code);
    return { error: result.error };
  }
  loginFailures.delete(result.email.toLowerCase());
  return { reset: true };
});

/* ---------- invitations (release audit SEC-08) ----------
   The only way an email turns into a chart identity or an admin role. The raw token appears
   once: in the returned link (shown to the inviting admin) and in the email when one can be
   sent. Only its SHA-256 hash is stored. */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INVITE_TOKEN_PARAMS = {
  params: { type: 'object', properties: { token: { type: 'string', pattern: '^aoi_[A-Za-z0-9_-]{43}$' } } },
} as const;

async function issueInvitation(input: {
  orgId: number;
  email: string;
  kind: 'person' | 'admin';
  personId: number | null;
  adminRole: OrgRole | null;
  invitedBy: number;
  roleDescription: string;
}): Promise<{ id: string; email: string; url: string; expiresAt: string; emailSent: boolean }> {
  const token = `aoi_${randomBytes(32).toString('base64url')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  const invitation = await repo.createInvitation({
    orgId: input.orgId, email: input.email, kind: input.kind, personId: input.personId, adminRole: input.adminRole,
    tokenHash: hashSessionToken(token), invitedBy: input.invitedBy, now: now.toISOString(), expiresAt,
  });
  const url = `${FRONTEND_URL.replace(/\/+$/, '')}/invite/${token}`;
  const inviter = await repo.getAccount(input.invitedBy);
  const emailSent = await sendInvitationEmail({
    to: input.email, invitedByName: inviter?.name ?? 'A teammate', orgName: invitation.orgName,
    roleDescription: input.roleDescription, acceptUrl: url, expiresAt,
  });
  if (emailSent) await repo.markInvitationEmailed(invitation.id, new Date().toISOString());
  return { id: invitation.id, email: input.email, url, expiresAt, emailSent };
}

function invitationStatus(inv: repo.Invitation): 'pending' | 'accepted' | 'revoked' | 'expired' {
  if (inv.revokedAt) return 'revoked';
  if (inv.acceptedAt) return 'accepted';
  return new Date(inv.expiresAt).getTime() <= Date.now() ? 'expired' : 'pending';
}

/** What the invite page shows its holder before they accept. Holding the link is what makes
 *  the invitee's own email and org name fair to show; nothing else about the org is exposed. */
app.get('/api/invitations/:token', {
  config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  schema: INVITE_TOKEN_PARAMS,
}, async (req, reply) => {
  const { token } = req.params as { token: string };
  const inv = await repo.getInvitationByTokenHash(hashSessionToken(token));
  if (!inv) {
    reply.code(404);
    return { error: 'this invitation link is not valid' };
  }
  return {
    invitation: {
      orgName: inv.orgName, kind: inv.kind, personName: inv.personName, personTitle: inv.personTitle,
      adminRole: inv.adminRole, email: inv.email, invitedByName: inv.invitedByName, expiresAt: inv.expiresAt,
      status: invitationStatus(inv),
    },
  };
});

app.post('/api/invitations/:token/accept', {
  config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
  schema: INVITE_TOKEN_PARAMS,
}, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const { token } = req.params as { token: string };
  const result = await repo.acceptInvitation(hashSessionToken(token), accountId, new Date().toISOString());
  if (!result.ok) {
    reply.code(result.code);
    return { error: result.error };
  }
  return { accepted: true, orgId: result.orgId, kind: result.kind };
});

app.get('/api/organizations/:orgId/invitations', async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const check = await requireOrgRole(req, orgId, 'admin', 'not authorized to see this organization’s invitations');
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const invitations = await repo.listPendingInvitations(orgId, new Date().toISOString());
  return {
    invitations: invitations.map((i) => ({
      id: i.id, email: i.email, kind: i.kind, personName: i.personName, adminRole: i.adminRole,
      createdAt: i.createdAt, expiresAt: i.expiresAt, emailSent: i.emailedAt != null,
    })),
  };
});

/** Revoking matches who may create: any admin for a chart invitation, only an owner for an
 *  admin-role invitation. */
app.delete('/api/organizations/:orgId/invitations/:invitationId', {
  schema: { params: { type: 'object', properties: { orgId: ID, invitationId: UUID } } },
}, async (req, reply) => {
  const { orgId, invitationId } = req.params as { orgId: number; invitationId: string };
  const inv = await repo.getInvitationById(orgId, invitationId);
  const check = await requireOrgRole(
    req, orgId, inv?.kind === 'admin' ? 'owner' : 'admin', 'not authorized to revoke this invitation', { elevated: true },
  );
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  if (!inv || !(await repo.revokeInvitation(orgId, invitationId, new Date().toISOString()))) {
    reply.code(404);
    return { error: 'no pending invitation with that id' };
  }
  return { ok: true };
});

/* ---------- org chart: people ---------- */

/** An optional `email` links this org-chart entry to a real login — resolve-or-create,
 *  same "temp password shown once" pattern as inviting an org admin above. Leaving email
 *  blank keeps today's behavior exactly: a structural chart entry with no login, reachable
 *  only through "My agent"'s free identity switcher. Giving an email that's already a
 *  registered account (say, someone already a person in a different org) is how the same
 *  human ends up with a second, independent org-chart identity — real multi-org
 *  membership, not a duplicate. */
app.post('/api/organizations/:orgId/people', {
  schema: bodySchema({
    name: str(120, 1), title: str(120, 1), team: str(120, 1),
    managerId: { type: ['integer', 'null'], minimum: 1, maximum: MAX_INT4 },
    agentDeployed: { type: 'boolean' },
    email: { anyOf: [EMAIL, { type: 'string', maxLength: 0 }, { type: 'null' }] },
  }, ['name', 'title', 'team']),
}, async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const check = await requireOrgRole(req, orgId, 'admin', 'not authorized to edit this organization');
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }

  const body = req.body as {
    name: string; title: string; team: string; managerId: number | null; agentDeployed: boolean; email?: string;
  };
  if (!body.name?.trim() || !body.title?.trim() || !body.team?.trim()) {
    reply.code(400);
    return { error: 'name, title, and team are required' };
  }
  // A manager from another organization would splice two orgs' charts together, and
  // deriveAllowedRoles would then grant cross-org "Direct manager" access (SEC-13).
  if (body.managerId != null && !(await repo.getPeople(orgId)).some((p) => p.id === body.managerId)) {
    reply.code(400);
    return { error: 'the manager must be someone already in this organization' };
  }

  // Enforced here, not just claimed on the pricing page — an org already at its plan's
  // seat limit can't add another person until it upgrades. No self-serve upgrade path
  // exists yet (see repo.ts's OrgPlan comment), so today that means talking to us.
  const org = await repo.getOrganization(orgId);
  const limit = repo.PLAN_LIMITS[org.plan];
  if (org.peopleCount >= limit) {
    reply.code(402);
    return { error: `This organization is on the ${org.plan} plan (${limit} people max) and is already at that limit. Upgrade to add more.` };
  }

  // An email never links or creates an account here (release audit SEC-08): anyone could have
  // signed up early with a future employee's address. It issues a one-time invitation that
  // only a logged-in account with that exact email, holding the link, can accept.
  const email = body.email?.trim().toLowerCase() || null;
  const person = await repo.createPerson(orgId, {
    name: body.name.trim(),
    title: body.title.trim(),
    team: body.team.trim(),
    managerId: body.managerId ?? null,
    agentDeployed: body.agentDeployed,
    accountId: null,
  });
  const invite = email
    ? await issueInvitation({
      orgId, email, kind: 'person', personId: person.id, adminRole: null, invitedBy: check.accountId,
      roleDescription: `${person.title} in ${org.name}'s org chart`,
    })
    : null;
  return { person, invite };
});

/** Admin-initiated password reset for a person in this org's chart — the no-email half of
 *  "I forgot my password" (see CLAUDE.md's auth notes). Issues a fresh temp password shown
 *  once to the admin, exactly like an invite, flags the account so its owner is forced to
 *  choose their own on next login, and revokes every session that account had (locking it
 *  out of anything already signed in is the point of a reset, not a side effect).
 *
 *  Deliberately refuses for an account that also belongs to another organization: an
 *  `accounts` row is a global login, not a tenant-owned identity, so minting a password
 *  for one would hand this org's admin a working login to someone else's org. See
 *  repo.accountBelongsToOtherOrgs for the full reasoning. Those accounts need a
 *  self-service reset instead — the email-token flow this project hasn't built yet. */
app.post('/api/organizations/:orgId/people/:personId/reset-password', async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const check = await requireOrgRole(req, orgId, 'admin', 'not authorized to edit this organization', { elevated: true });
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }

  const personId = Number((req.params as { personId: string }).personId);
  const person = await repo.getPerson(personId).catch(() => null);
  const personOrgId = person ? await repo.getOrgIdOfPerson(personId).catch(() => null) : null;
  if (!person || personOrgId !== orgId) {
    reply.code(404);
    return { error: 'no such person in this organization' };
  }
  if (person.accountId == null) {
    reply.code(400);
    return { error: `${person.name} has no login to reset — add an email for them first.` };
  }
  if (person.accountId === check.accountId) {
    reply.code(400);
    return { error: 'Use "Change password" for your own account rather than resetting it here.' };
  }
  if (await repo.accountBelongsToOtherOrgs(person.accountId, orgId)) {
    reply.code(409);
    return {
      error:
        `${person.name} also belongs to another organization, so their login isn't yours to reset — ` +
        'they need to reset it themselves.',
    };
  }

  const tempPassword = generateTempPassword();
  await repo.setAccountPassword(person.accountId, hashPassword(tempPassword), true);
  await repo.revokeAllSessionsForAccount(person.accountId, new Date().toISOString());
  const account = await repo.getAccount(person.accountId);
  return { tempPassword, email: account?.email ?? null };
});

app.delete('/api/organizations/:orgId/people/:personId', async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const check = await requireOrgRole(req, orgId, 'admin', 'not authorized to edit this organization', { elevated: true });
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }

  const personId = Number((req.params as { personId: string }).personId);
  const result = await repo.deletePerson(orgId, personId);
  if (!result.ok) {
    reply.code(409);
    return { error: result.error };
  }
  return { ok: true };
});

/* ---------- org ---------- */

app.get('/api/org', async (req, reply) => {
  const orgId = orgIdFromQuery(req);
  const access = await requireOrgAccess(req, orgId);
  if (!access.ok) {
    reply.code(access.code);
    return { error: access.error };
  }
  const [people, surfaces, neverIngested] = await Promise.all([
    repo.getPeople(orgId),
    repo.getSurfaces(),
    repo.getNeverIngested(),
  ]);
  return {
    people: people.map((p) => ({ ...p, coverage: computeCoverage(p, surfaces) })),
    surfaces,
    neverIngested,
  };
});

/** Admin-only — unlike /api/org and /api/policy (also reached by orgIdFromQuery), nothing
 *  in the self-service "My agent" surface calls this; only Overview.tsx does, inside the
 *  Admin panel. Found and closed during a security audit: this had no gate at all,
 *  exposing org-wide stats (query volume, refusal counts) to anyone who could guess an
 *  orgId. */
app.get('/api/overview', async (req, reply) => {
  const orgId = orgIdFromQuery(req);
  const check = await requireOrgRole(req, orgId, 'viewer', 'not authorized to view this organization\'s overview');
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const [people, surfaces, entries, current] = await Promise.all([
    repo.getPeople(orgId),
    repo.getSurfaces(),
    repo.listAuditEntries(orgId),
    repo.getCurrentRevision(orgId),
  ]);
  const org = computeOrgCoverage(people, surfaces);

  // Derived, never a literal. If it can't be computed it doesn't belong here.
  let wont = 0;
  let cant = 0;
  for (const entry of entries) {
    for (const item of entry.snapshot.items) {
      if (item.tier === 'WONT') wont += 1;
      if (item.tier === 'CANT') cant += 1;
    }
  }

  const silentGaps = entries.filter(
    (e) => e.snapshot.coverage.missingSurfaces.length > 0 && !e.snapshot.coverage.text.includes('Missing'),
  ).length;

  return {
    coverage: org,
    refusals: { total: wont + cant, wont, cant },
    silentGaps,
    queries: entries.length,
    policyRevision: current.id,
  };
});

type SelfCheck = { ok: true; orgId: number } | { ok: false; code: 401 | 403 | 404; error: string };

/** Every self-service endpoint keyed by a person id in the path (their own connections,
 *  ingest tokens, sub-agents, claims, export) — the session's own linked identity must be
 *  exactly that person. There is no anonymous or "accountless demo person" branch anymore:
 *  a person without a linked login has no self-service until an admin adds their email. */
async function requireSelf(req: { cookies: Record<string, string | undefined> }, id: number): Promise<SelfCheck> {
  // Authenticate before looking the person up, so an anonymous caller can't use 404 vs 401
  // to enumerate which person ids exist.
  if ((await currentAccountId(req)) == null) return { ok: false, code: 401, error: 'log in first' };
  const orgId = await orgIdOfPersonOrNull(id);
  if (orgId == null) return { ok: false, code: 404, error: 'no such person' };
  const check = await requireSessionPerson(req, orgId, 'you may only manage your own record');
  if (!check.ok) return check.code === 401 ? check : { ok: false, code: 403, error: check.error };
  if (check.personId !== id) return { ok: false, code: 403, error: 'you may only manage your own record' };
  return { ok: true, orgId };
}

/** Raw claims, not a policy-filtered synthesis — this is "what it knows", a self-view
 *  showing someone their own real claim objects (ids included, needed for correction),
 *  never a cross-person read. Used to return that to anyone who could name any id at all;
 *  now requires the caller to actually be that person (see verifySelfAccess) — found and
 *  closed during a security audit, since a raw, unauthenticated dump of even Sensitive-tier
 *  claims is exactly what the deterministic policy engine exists to prevent. */
app.get('/api/person/:id', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const person = await repo.getPerson(id);
  const [surfaces, claims] = await Promise.all([
    repo.getSurfaces(),
    repo.getClaims(check.orgId, id),
  ]);
  return {
    person,
    coverage: computeCoverage(person, surfaces),
    surfaces: surfaces.map((s) => ({
      ...s,
      state: person.surfaces[s.key],
      label: stateLabel(person.surfaces[s.key]),
    })),
    claims,
  };
});

/** A real export, not the decorative "Export requested — ready in ~2 min" button Controls
 *  used to show with nothing behind it (found during a later audit — same shape of bug as
 *  the claim-correction note that got silently discarded: a UI promising an action that
 *  never actually happened). Everything held about this person: their claims, only the
 *  evidence those claims actually reference (not the whole org's), and every audit entry
 *  where they were the subject — the "every query that touched your agent, and every
 *  refusal" the Controls page copy already promises. Same self-only gate as GET
 *  /api/person/:id above — this is strictly more sensitive (it includes evidence and full
 *  audit history), not less. */
app.get('/api/person/:id/export', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const orgId = check.orgId;
  const [person, claims, allEvidence, auditEntriesAsSubject] = await Promise.all([
    repo.getPerson(id),
    repo.getClaims(orgId, id),
    repo.getEvidence(orgId),
    repo.auditForSubject(id),
  ]);
  const evidence: Record<string, unknown> = {};
  for (const claim of claims) {
    if (claim.evidenceId && allEvidence[claim.evidenceId]) evidence[claim.evidenceId] = allEvidence[claim.evidenceId];
  }
  return {
    exportedAt: new Date().toISOString(),
    person,
    claims,
    evidence,
    auditEntriesAsSubject,
  };
});

/* ---------- self-service: correcting a claim ----------
   A correction supersedes rather than mutates (types.ts: Claim.supersededBy). The claim
   stays in history for "What it knows", but respond() already skips any claim with
   supersededBy set, so it drops out of every future answer immediately. */

app.post('/api/claim/:id/correct', { schema: bodySchema({ note: str(2000) }, ['note']) }, async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const { note } = req.body as { note?: string };
  if (!note?.trim()) {
    reply.code(400);
    return { error: 'note is required — what is actually true, and where can it be verified?' };
  }
  const existing = await repo.getClaimById(id);
  if (!existing) {
    reply.code(404);
    return { error: 'not found' };
  }
  const check = await requireSelf(req, existing.personId);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const claim = await repo.correctClaim(id, note.trim());
  if (!claim) return { error: 'not found' };
  return { claim };
});

/* ---------- escalations ---------- */

/** Admin-only, same rationale as /api/overview above — no self-service caller, only
 *  Escalations.tsx/OrgGraph.tsx inside the Admin panel. Found and closed during a
 *  security audit: escalation detail text and full manager-chain paths (real names,
 *  personIds) were reachable with no auth at all. */
app.get('/api/escalations', async (req, reply) => {
  const orgId = orgIdFromQuery(req);
  const check = await requireOrgRole(req, orgId, 'viewer', 'not authorized to view this organization\'s escalations');
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  return { escalations: await repo.getEscalations(orgId) };
});

/** Who may act on an escalation: anyone on its path, or anyone whose real relationship to
 *  the escalated person (deriveAllowedRoles — the org graph, never asserted) is IT admin
 *  or Executive. Same authorization primitive /api/agent/ask already uses to verify a
 *  claimed role — no second mechanism invented for this. */
async function canActOnEscalation(escalation: { personId: number; path: { personId: number }[] }, actorPersonId: number, orgId: number): Promise<boolean> {
  if (escalation.path.some((p) => p.personId === actorPersonId)) return true;
  const people = await repo.getPeople(orgId);
  const roles = deriveAllowedRoles(actorPersonId, escalation.personId, people);
  return roles.includes('IT admin') || roles.includes('Executive');
}

app.post('/api/escalations/:id/acknowledge', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const escalation = await repo.getEscalationById(id);
  if (!escalation) {
    reply.code(404);
    return { error: 'not found' };
  }
  const orgId = await repo.getOrgIdOfPerson(escalation.personId);
  const actor = await requireSessionPerson(req, orgId, 'you need a place in this organization’s chart to act on escalations');
  if (!actor.ok) {
    reply.code(actor.code);
    return { error: actor.error };
  }
  const actorPersonId = actor.personId;
  if (!(await canActOnEscalation(escalation, actorPersonId, orgId))) {
    reply.code(403);
    return { error: 'you are not on this escalation\'s path and are not IT admin or Executive for this person' };
  }
  const updated = await repo.acknowledgeEscalation(id, actorPersonId, new Date().toISOString());
  if (!updated) {
    reply.code(409);
    return { error: 'this escalation is not open' };
  }
  return { escalation: updated };
});

app.post('/api/escalations/:id/resolve', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const escalation = await repo.getEscalationById(id);
  if (!escalation) {
    reply.code(404);
    return { error: 'not found' };
  }
  const orgId = await repo.getOrgIdOfPerson(escalation.personId);
  const actor = await requireSessionPerson(req, orgId, 'you need a place in this organization’s chart to act on escalations');
  if (!actor.ok) {
    reply.code(actor.code);
    return { error: actor.error };
  }
  const actorPersonId = actor.personId;
  if (!(await canActOnEscalation(escalation, actorPersonId, orgId))) {
    reply.code(403);
    return { error: 'you are not on this escalation\'s path and are not IT admin or Executive for this person' };
  }
  const updated = await repo.resolveEscalation(id, actorPersonId, new Date().toISOString());
  if (!updated) {
    reply.code(409);
    return { error: 'this escalation is already resolved' };
  }
  return { escalation: updated };
});

/* ---------- connections ---------- */

/** Admin-only, same rationale as /api/overview above — no self-service caller, only
 *  Connections.tsx inside the Admin panel. Found and closed during a security audit. */
app.get('/api/connections', async (req, reply) => {
  const orgId = orgIdFromQuery(req);
  const check = await requireOrgRole(req, orgId, 'viewer', 'not authorized to view this organization\'s connections');
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const [surfaces, people, neverIngested] = await Promise.all([
    repo.getSurfaces(),
    repo.getPeople(orgId),
    repo.getNeverIngested(),
  ]);
  return { connectors: computeConnectorStats(surfaces, people), neverIngested };
});

/* ---------- self-service: an employee's own agent surfaces ----------
   Cycling your own surface is not a write to a connected system — it changes what the
   mesh is permitted to read, the same class of mutation as a policy-grid edit. */

app.post('/api/person/:id/surface/cycle', { schema: bodySchema({ surfaceKey: str(40, 1) }, ['surfaceKey']) }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const { surfaceKey } = req.body as { surfaceKey: SurfaceKey };
  const before = await repo.getPerson(id);
  if (!Object.prototype.hasOwnProperty.call(before.surfaces, surfaceKey)) {
    reply.code(400);
    return { error: 'unknown surface' };
  }
  const current = before.surfaces[surfaceKey];
  // Resuming needs something real behind it: a stored credential, or (for the push-based
  // tools, whose status handler just reads this same surface state) a pushed event on record.
  const hasRealConnection = current !== 'absent' ? false
    : (INGEST_SOURCES as readonly string[]).includes(surfaceKey)
      ? (await repo.getIngestedEventsSince(id, surfaceKey, new Date(0))).length > 0
      : (await STATUS_HANDLERS[surfaceKey]?.(id))?.connected ?? false;
  const next = nextSurfaceState(current, hasRealConnection);
  if (current === 'absent' && next === 'absent') {
    const surfaces = await repo.getSurfaces();
    const name = surfaces.find((s) => s.key === surfaceKey)?.name ?? surfaceKey;
    reply.code(409);
    return { error: `${name} isn't connected yet. Connect it in Set up my agent first.` };
  }
  const person = await repo.updatePersonSurface(id, surfaceKey, next);
  const surfaces = await repo.getSurfaces();
  return { person, coverage: computeCoverage(person, surfaces) };
});

/* ---------- self-service: agent runtimes ----------
   Registering or disconnecting a sub-agent is the same class of mutation as cycling a
   surface — it changes what's permitted to read on your behalf, not a write to a
   connected system. Unapproved catalog entries register as 'pending', never 'full';
   blocked entries cannot be registered at all.

   Two registration paths, deliberately separate: the org's one main/aggregator agent
   (set by an org admin below, in "platform: organizations") is the only registration
   connected to the org — it carries scope, and it's what everyone's queries reach.
   Everything a person registers here is a sub-agent — a personal tool the org's main
   agent can query for a status summary, but structurally never touches org surfaces. */

// Deterministic, clearly-labelled placeholder content for the "query a sub-agent" demo —
// never persisted, never treated as a claim. See the AskUserQuestion decision this
// feature shipped under: simulated response, no write to claims/audit.
// claude-code deliberately has no entry here — the query handler below always returns
// early for it (real log-based digest, now also a live CLI ask), so a sample here would
// be dead, unreachable code.
const TASK_SAMPLES: Record<string, string[]> = {
  copilot: ['suggested completions across 14 files', 'flagged 2 unused imports in payments-core'],
  gemini: ['summarised the Q3 planning document', 'drafted release notes for the 4.3 cut'],
  'llama-local': ['indexed 40 pages in Confluence', 'answered 3 questions about the deploy runbook'],
  'claude-sonnet': ["answered 5 cross-team questions", 'summarised this week’s escalations'],
  chatgpt: ['drafted a customer follow-up email', 'outlined next sprint’s tickets'],
};

app.get('/api/runtimes', async () => ({ catalog: await repo.getRuntimeCatalog() }));

app.get('/api/person/:id/runtimes', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const [catalog, registered] = await Promise.all([repo.getRuntimeCatalog(), repo.getPersonRuntimes(id)]);
  return { catalog, registered };
});

async function checkCatalogEntry(runtimeKey: string, reply: { code: (n: number) => void }) {
  const catalog = await repo.getRuntimeCatalog();
  const entry = catalog.find((r) => r.key === runtimeKey);
  if (!entry) {
    reply.code(404);
    return { error: 'not found' } as const;
  }
  if (entry.blocked) {
    reply.code(403);
    return { error: 'blocked — no data-processing agreement on file' } as const;
  }
  return { entry };
}

/** Strips a stored org_main_agent row down to what's safe to send over the wire — the
 *  encrypted API key becomes a plain boolean, never the ciphertext or (obviously) the
 *  decrypted value. baseUrl/model aren't secrets, so an admin can see them to edit them. */
function sanitizeOrgMainAgent(registered: OrgMainAgent | null) {
  if (!registered) return null;
  return {
    runtimeKey: registered.runtimeKey,
    scope: registered.scope,
    addedAt: registered.addedAt,
    hasCustomApiKey: registered.apiKeyEncrypted !== null,
    baseUrl: registered.baseUrl,
    model: registered.model,
  };
}

/** Read the org's one main/aggregator agent — members see it read-only in "Set up my
 *  agent", admins edit it; either needs a real place in this org. */
app.get('/api/organizations/:orgId/main-agent', async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const access = await requireOrgAccess(req, orgId);
  if (!access.ok) {
    reply.code(access.code);
    return { error: access.error };
  }
  const [catalog, registered] = await Promise.all([repo.getRuntimeCatalog(), repo.getOrgMainAgent(orgId)]);
  return { catalog, registered: sanitizeOrgMainAgent(registered) };
});

/** Set or switch the org's one main/aggregator agent — admin-only (CLAUDE.md: "the main
 *  agent will be at the organization level... only the admin can set up the main agent").
 *  Same runtimeKey as the current one updates its scope in place; a different runtimeKey
 *  replaces it outright — org_main_agent has one row per org, so there's never an old
 *  registration to demote the way person-level switching used to need.
 *
 *  Which keys are eligible is read from the catalog itself (checkCatalogEntry below), not
 *  a hardcoded list — two orthogonal fields both have to hold: `apiFamily !== 'unsupported'`
 *  (a real ModelProvider adapter exists — currently 'anthropic' or 'openai-compatible':
 *  Claude, ChatGPT, or a self-hosted/open-source model behind the same wire protocol) AND
 *  `mainEligible` (this entry is a sensible org-facing aggregator at all — claude-code has
 *  a real adapter but is a dev tool scoped to GitHub/Jira, so it stays sub-agent-only on
 *  mainEligible alone). See integrations/runtimeProvider.ts and domain/types.ts's
 *  AgentRuntime doc comment.
 *
 *  apiKey/baseUrl/model let the org bring its own provider credentials instead of sharing
 *  this deployment's platform-wide env var default — e.g. its own Anthropic/OpenAI
 *  billing, or a self-hosted endpoint (runtimeKey 'llama-local', any OpenAI-compatible
 *  server). Each is optional and independently tri-state: omitted (undefined) leaves
 *  whatever's already stored untouched, `null` (or an empty string) clears it back to the
 *  platform default, a non-empty string sets it. The key is encrypted before it's ever
 *  written to Postgres (domain/crypto.ts) and never returned by any response afterward —
 *  see sanitizeOrgMainAgent above. */
app.post('/api/organizations/:orgId/main-agent', {
  schema: bodySchema({
    runtimeKey: str(60, 1), scope: { type: 'string', enum: ['full', 'narrow'] },
    apiKey: nullableStr(500), baseUrl: nullableStr(500), model: nullableStr(120),
  }, ['runtimeKey']),
}, async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const check = await requireOrgRole(req, orgId, 'admin', 'not authorized to set this organization\'s main agent', { elevated: true });
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const { runtimeKey, scope: requestedScope, apiKey, baseUrl, model } = req.body as {
    runtimeKey: string;
    scope?: RuntimeScope;
    apiKey?: string | null;
    baseUrl?: string | null;
    model?: string | null;
  };
  if (requestedScope != null && requestedScope !== 'full' && requestedScope !== 'narrow') {
    reply.code(400);
    return { error: 'scope must be full or narrow — pending is assigned automatically, never chosen' };
  }
  const checked = await checkCatalogEntry(runtimeKey, reply);
  if ('error' in checked) return checked;
  if (!checked.entry.mainEligible || checked.entry.apiFamily === 'unsupported') {
    reply.code(400);
    return { error: `"${checked.entry.name}" can't be a main agent — connect it as a sub-agent instead` };
  }
  const existing = await repo.getOrgMainAgent(orgId);
  let apiKeyEncrypted = existing?.apiKeyEncrypted ?? null;
  if (apiKey !== undefined) {
    if (!apiKey) {
      apiKeyEncrypted = null;
    } else {
      try {
        apiKeyEncrypted = encryptSecret(apiKey);
      } catch {
        reply.code(500);
        return { error: 'this server is not configured to store a custom credential right now — contact your platform admin' };
      }
    }
  }
  // SSRF guard: a custom baseUrl is fetched server-side on every ask for this org
  // (openaiCompatible.ts's callOpenAI). Found during a security audit: nothing previously
  // stopped an org admin from pointing this at Railway's private network, localhost, or a
  // cloud-metadata-style address. Only validated when actually being set to a new,
  // non-empty value — clearing it back to null, or leaving it untouched, needs no check.
  if (baseUrl) {
    const safety = await isSafeExternalUrl(baseUrl);
    if (!safety.ok) {
      reply.code(400);
      return { error: `endpoint URL rejected: ${safety.reason}` };
    }
  }
  const resolvedBaseUrl = baseUrl === undefined ? (existing?.baseUrl ?? null) : (baseUrl || null);
  const resolvedModel = model === undefined ? (existing?.model ?? null) : (model || null);
  const scope: RuntimeScope = checked.entry.approved ? (requestedScope ?? 'full') : 'pending';
  const addedAt = new Date().toISOString().slice(0, 10);
  await repo.setOrgMainAgent(orgId, runtimeKey, scope, addedAt, apiKeyEncrypted, resolvedBaseUrl, resolvedModel);
  return { registered: sanitizeOrgMainAgent(await repo.getOrgMainAgent(orgId)) };
});

function sanitizeAccountMainAgent(registered: AccountMainAgent | null) {
  if (!registered) return null;
  return {
    runtimeKey: registered.runtimeKey,
    addedAt: registered.addedAt,
    hasCustomApiKey: registered.apiKeyEncrypted !== null,
    baseUrl: registered.baseUrl,
    model: registered.model,
  };
}

/** Read your own personal main agent — the counterpart to the org GET above, for an
 *  account with no organization. Session-gated only (must be logged in as yourself); no
 *  org role to check, since this never touches org data. */
app.get('/api/accounts/me/main-agent', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const [catalog, registered] = await Promise.all([repo.getRuntimeCatalog(), repo.getAccountMainAgent(accountId)]);
  return { catalog, registered: sanitizeAccountMainAgent(registered) };
});

/** Set or switch your own personal main agent — the counterpart to the admin-gated org
 *  endpoint above, minus the admin gate: this only ever touches your own account's row,
 *  so being logged in as yourself is the whole authorization story. Same eligibility
 *  check (mainEligible, a real ModelProvider adapter), same encrypt-before-write and
 *  SSRF-guarded baseUrl as the org version — no `scope`/approval workflow, since there's
 *  no IT/Security gate for your own individual credential. */
app.post('/api/accounts/me/main-agent', {
  schema: bodySchema({
    runtimeKey: str(60, 1), apiKey: nullableStr(500), baseUrl: nullableStr(500), model: nullableStr(120),
  }, ['runtimeKey']),
}, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const { runtimeKey, apiKey, baseUrl, model } = req.body as {
    runtimeKey: string;
    apiKey?: string | null;
    baseUrl?: string | null;
    model?: string | null;
  };
  const checked = await checkCatalogEntry(runtimeKey, reply);
  if ('error' in checked) return checked;
  if (!checked.entry.mainEligible || checked.entry.apiFamily === 'unsupported') {
    reply.code(400);
    return { error: `"${checked.entry.name}" can't be a main agent — connect it as a sub-agent instead` };
  }
  const existing = await repo.getAccountMainAgent(accountId);
  let apiKeyEncrypted = existing?.apiKeyEncrypted ?? null;
  if (apiKey !== undefined) {
    if (!apiKey) {
      apiKeyEncrypted = null;
    } else {
      try {
        apiKeyEncrypted = encryptSecret(apiKey);
      } catch {
        reply.code(500);
        return { error: 'this server is not configured to store a custom credential right now — contact your platform admin' };
      }
    }
  }
  if (baseUrl) {
    const safety = await isSafeExternalUrl(baseUrl);
    if (!safety.ok) {
      reply.code(400);
      return { error: `endpoint URL rejected: ${safety.reason}` };
    }
  }
  const resolvedBaseUrl = baseUrl === undefined ? (existing?.baseUrl ?? null) : (baseUrl || null);
  const resolvedModel = model === undefined ? (existing?.model ?? null) : (model || null);
  const addedAt = new Date().toISOString().slice(0, 10);
  await repo.setAccountMainAgent(accountId, runtimeKey, addedAt, apiKeyEncrypted, resolvedBaseUrl, resolvedModel);
  return { registered: sanitizeAccountMainAgent(await repo.getAccountMainAgent(accountId)) };
});

/** Register a sub-agent — always a personal tool, never connected to org surfaces.
 *
 *  One exception to "never touches org surfaces": 'claude-code' is also a real
 *  resourceProviders.ts claim source (unlike copilot/gemini/llama-local/claude-sonnet/
 *  chatgpt, which are simulated sub-agents with no real provider behind them at all).
 *  For that one key, registering it here IS the self-service act of connecting the
 *  surface — same principle as GitHub/Jira's PAT save and codex/gemini-cli's first
 *  pushed event, just triggered by a local sub-agent registration instead of a
 *  credential. Without this, the surface stayed stuck at its 'outOfScope' default
 *  forever (Controls' cycle button refuses to move it), so a newly registered Claude
 *  Code sub-agent could answer direct queries but silently never feed "Ask yourself" —
 *  found live testing a fresh self-serve org. */
app.post('/api/person/:id/runtimes', { schema: bodySchema({ runtimeKey: str(60, 1) }, ['runtimeKey']) }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const selfCheck = await requireSelf(req, id);
  if (!selfCheck.ok) {
    reply.code(selfCheck.code);
    return { error: selfCheck.error };
  }
  const { runtimeKey } = req.body as { runtimeKey: string };
  const checked = await checkCatalogEntry(runtimeKey, reply);
  if ('error' in checked) return checked;
  const existing = await repo.getPersonRuntimes(id);
  if (existing.some((r) => r.runtimeKey === runtimeKey)) {
    reply.code(409);
    return { error: 'already registered' };
  }
  const scope: RuntimeScope = checked.entry.approved ? 'full' : 'pending';
  const addedAt = new Date().toISOString().slice(0, 10);
  await repo.insertPersonRuntime(id, runtimeKey, scope, addedAt);
  if (runtimeKey === 'claude-code') {
    const before = await repo.getPerson(id);
    if (before.surfaces['claude-code'] !== 'connected') {
      await repo.updatePersonSurface(id, 'claude-code', 'connected');
    }
  }
  return { registered: await repo.getPersonRuntimes(id) };
});

app.delete('/api/person/:id/runtimes/:key', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const key = (req.params as { key: string }).key;
  await repo.deletePersonRuntime(id, key);
  if (key === 'claude-code') {
    const before = await repo.getPerson(id);
    if (before.surfaces['claude-code'] === 'connected') {
      await repo.updatePersonSurface(id, 'claude-code', 'absent');
    }
  }
  return { registered: await repo.getPersonRuntimes(id) };
});

/** The main agent asking a sub-agent what it's been up to. 'claude-code' is real: today's
 *  local session transcripts, summarized by a real Claude API call. Every other runtime
 *  stays a clearly-labelled simulated demo — there's no real integration path for those
 *  yet. Nothing here is persisted or treated as a claim. */
app.get('/api/person/:id/runtimes/:key/query', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const key = (req.params as { key: string }).key;
  const list = await repo.getPersonRuntimes(id);
  const reg = list.find((r) => r.runtimeKey === key);
  if (!reg) {
    reply.code(404);
    return { error: 'not found' };
  }
  if (reg.scope === 'pending') {
    reply.code(409);
    return { error: 'awaiting IT approval — nothing to query yet' };
  }

  if (key === 'claude-code') {
    const activity = await getTodaysClaudeCodeActivity(id);
    const digest = formatClaudeCodeDigest(activity);
    if (!digest) {
      return { text: 'No Claude Code activity found for today in this project.', real: true };
    }
    if (!anthropicConfigured()) {
      const raw = rawActivityDigest([{ source: 'Claude Code (today, this project)', digest }]);
      return { text: `${raw}\n\n(Raw data — no ANTHROPIC_API_KEY configured, so this isn't AI-summarized.)`, real: true };
    }
    const person = await repo.getPerson(id);
    const text = await summarizeDailyActivity(person.name, [{ source: 'Claude Code (today, this project)', digest }]);
    return { text, real: true };
  }

  const catalog = await repo.getRuntimeCatalog();
  const name = catalog.find((r) => r.key === key)?.name ?? key;
  const tasks = TASK_SAMPLES[key] ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const summary = tasks.length
    ? `${name} reports for ${today}: ${tasks.join('; ')}.`
    : `${name} has nothing to report for ${today}.`;
  return { text: `${summary} (Simulated — ${name} isn't actually connected; this doesn't reflect real activity.)`, real: false };
});

/** A genuinely live question, answered by shelling out to the person's own already-
 *  authenticated `claude` CLI (subscription login, no ANTHROPIC_API_KEY needed) — a fresh,
 *  read-only investigation of this project directory right now, not a summary of past
 *  session logs. Different from the endpoint above: that one reports what already
 *  happened; this one looks live. Claude-code only — there's no equivalent CLI to shell
 *  out to for the other catalog runtimes. */
app.post('/api/person/:id/runtimes/claude-code/ask-live', {
  config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
  schema: bodySchema({ question: QUESTION }, ['question']),
}, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const { question } = req.body as { question?: string };
  if (!question?.trim()) {
    reply.code(400);
    return { error: 'question is required' };
  }
  const list = await repo.getPersonRuntimes(id);
  const reg = list.find((r) => r.runtimeKey === 'claude-code');
  if (!reg) {
    reply.code(400);
    return { error: 'register claude-code as a sub-agent first' };
  }
  if (reg.scope === 'pending') {
    reply.code(409);
    return { error: 'awaiting IT approval — nothing to ask yet' };
  }
  if (!(await claudeCliAvailable())) {
    reply.code(503);
    return { error: 'the claude CLI is not installed or not on PATH on this machine — run `claude login` first' };
  }
  try {
    const { text } = await askClaudeCli(question.trim(), PROJECT_ROOT);
    return { text, real: true, live: true };
  } catch (err) {
    reply.code(502);
    return { error: err instanceof Error ? err.message : 'the claude CLI failed' };
  }
});

/* ---------- real integrations: Gmail OAuth + the daily summary ---------- */

app.get('/api/oauth/gmail/start', async (req, reply) => {
  const personId = Number((req.query as { personId?: string }).personId);
  if (!Number.isFinite(personId) || personId <= 0) {
    reply.code(400);
    return { error: 'personId is required' };
  }
  const check = await requireSelf(req, personId);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  if (!googleConfigured()) {
    reply.code(503);
    return { error: 'Google OAuth is not configured on the backend — see backend/.env.example' };
  }
  // CSRF state (release audit SEC-09): Google only ever sees a random nonce. The person id it
  // belongs to stays server-side in a short-lived httpOnly cookie, so the callback can't be
  // pointed at someone else's person id, or completed by anyone who didn't start it.
  const nonce = generateSessionToken();
  reply.setCookie(OAUTH_STATE_COOKIE, `${personId}.${nonce}`, {
    path: '/api/oauth/gmail', httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 10 * 60,
  });
  return reply.redirect(buildAuthUrl(nonce));
});

app.get('/api/oauth/gmail/callback', async (req, reply) => {
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  reply.type('text/html');
  const page = (message: string) =>
    `<!doctype html><meta charset="utf-8"><title>Gmail</title><p>${escapeHtml(message)} <a href="${escapeHtml(FRONTEND_URL)}">Return to the app</a>.</p>`;

  const stored = req.cookies[OAUTH_STATE_COOKIE];
  reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/oauth/gmail' });

  if (error || !code || !state) {
    reply.code(400);
    return page(`Gmail connection failed: ${error ?? 'missing code'}.`);
  }
  const [storedPersonId, storedNonce] = (stored ?? '').split('.');
  const nonceMatches = !!storedNonce && storedNonce.length === state.length
    && timingSafeEqual(Buffer.from(storedNonce), Buffer.from(state));
  if (!nonceMatches) {
    reply.code(400);
    return page('Gmail connection failed: this sign-in link expired or was not started from this browser. Start again from "Set up my agent".');
  }
  const personId = Number(storedPersonId);
  const self = await requireSelf(req, personId);
  if (!self.ok) {
    reply.code(self.code);
    return page('Gmail connection failed: log in as the person connecting Gmail, then start again.');
  }
  try {
    const tokens = await exchangeCode(code);
    await saveGmailConnection(personId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresIn: tokens.expires_in,
    });
    // Connecting Gmail also enables Calendar — same OAuth token, an added scope — and the
    // catalog's own helpText has always said so, but nothing ever actually flipped this
    // surface: a real, previously-invisible bug found while unifying every connector into
    // one dropdown (CLAUDE.md), since Calendar had never been shown in a UI that would
    // have exposed it not actually updating.
    const person = await repo.getPerson(personId);
    if (person.surfaces.calendar !== 'connected') {
      await repo.updatePersonSurface(personId, 'calendar', 'connected');
    }
  } catch (err) {
    console.error({ err }, 'gmail oauth callback failed');
    reply.code(502);
    return page('Gmail connection failed: Google did not accept the sign-in. Start again from "Set up my agent".');
  }
  // A meta refresh, not an inline script — helmet's CSP blocks inline scripts in production.
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2;url=${escapeHtml(FRONTEND_URL)}"><title>Gmail connected</title><p>Gmail connected. Returning to the app&hellip; <a href="${escapeHtml(FRONTEND_URL)}">Continue</a>.</p>`;
});

app.get('/api/person/:id/gmail/status', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  return getGmailStatus(id);
});

app.delete('/api/person/:id/gmail', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  await disconnectGmail(id);
  const before = await repo.getPerson(id);
  if (before.surfaces.calendar === 'connected') {
    await repo.updatePersonSurface(id, 'calendar', 'absent');
  }
  return { ok: true };
});

/* ---------- real integrations: GitHub, via a pasted personal access token ----------
   No OAuth app to register (unlike Gmail) — a person generates their own token at
   github.com/settings/tokens and pastes it in. The raw token is stored (person_oauth_
   tokens, fully owned by the person, same as the Gmail row) so this backend can poll on
   their behalf; it is never echoed back to the frontend after saving. */

app.post('/api/person/:id/github', { schema: bodySchema({ token: str(500) }, ['token']) }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const { token } = req.body as { token?: string };
  if (!token?.trim()) {
    reply.code(400);
    return { error: 'token is required' };
  }
  const result = await saveGithubConnection(id, token.trim());
  if (!result.ok) {
    reply.code(400);
    return { error: result.error };
  }
  // A real, working token is the self-service act of connecting the surface — the same
  // state Controls' manual cycle button would eventually reach, just driven by a real
  // credential instead of a click.
  await repo.updatePersonSurface(id, 'github', 'connected');
  return { connected: true, login: result.login };
});

app.get('/api/person/:id/github/status', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  return getGithubStatus(id);
});

app.delete('/api/person/:id/github', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  await disconnectGithub(id);
  const before = await repo.getPerson(id);
  if (before.surfaces.github === 'connected') {
    await repo.updatePersonSurface(id, 'github', 'absent');
  }
  return { ok: true };
});

/* ---------- real integrations: Jira, via a pasted API token ----------
   Same shape as GitHub's PAT connection, plus a site URL — Jira Cloud API tokens are
   scoped to a specific Atlassian site (https://yourteam.atlassian.net), and there's no
   endpoint that derives it from the token alone. UNVERIFIED against a real instance — see
   jira.ts's module comment and CLAUDE.md's "where to go next". */

app.post('/api/person/:id/jira', {
  schema: bodySchema({ siteUrl: str(500), email: str(254), apiToken: str(500) }, ['siteUrl', 'email', 'apiToken']),
}, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const { siteUrl, email, apiToken } = req.body as { siteUrl?: string; email?: string; apiToken?: string };
  if (!siteUrl?.trim() || !email?.trim() || !apiToken?.trim()) {
    reply.code(400);
    return { error: 'siteUrl, email, and apiToken are all required' };
  }
  const result = await saveJiraConnection(id, siteUrl.trim(), email.trim(), apiToken.trim());
  if (!result.ok) {
    reply.code(400);
    return { error: result.error };
  }
  await repo.updatePersonSurface(id, 'jira', 'connected');
  return { connected: true, displayName: result.displayName };
});

app.get('/api/person/:id/jira/status', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  return getJiraStatus(id);
});

app.delete('/api/person/:id/jira', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  await disconnectJira(id);
  const before = await repo.getPerson(id);
  if (before.surfaces.jira === 'connected') {
    await repo.updatePersonSurface(id, 'jira', 'absent');
  }
  return { ok: true };
});

/* ---------- generic connector catalog ----------
   The plug-and-play framework for every tool beyond GitHub/Jira/Gmail (which keep their
   own bespoke, working endpoints above/below, untouched): one catalog (connectorCatalog.ts)
   drives one generic connect/disconnect/status flow instead of a bespoke route set per
   tool. Adding a 21st connector with simple PAT/token auth is: one catalog entry, one
   client module (linear.ts's shape), one line in each dispatch table below — never a new
   endpoint. */

type ConnectHandler = (personId: number, fields: Record<string, string>) => Promise<{ ok: true; label: string } | { ok: false; error: string }>;
type StatusHandler = (personId: number) => Promise<{ connected: boolean; label: string | null }>;

const CONNECT_HANDLERS: Partial<Record<SurfaceKey, ConnectHandler>> = {
  // Unified into the same generic dispatch the dropdown drives through — github/jira also
  // keep their own bespoke /api/person/:id/github|jira endpoints (already reachable a
  // second way, same underlying save/status/disconnect functions, so behavior is
  // identical either path is used).
  github: async (id, f) => {
    const r = await saveGithubConnection(id, f.token);
    return r.ok ? { ok: true, label: r.login } : r;
  },
  jira: async (id, f) => {
    const r = await saveJiraConnection(id, f.siteUrl, f.email, f.apiToken);
    return r.ok ? { ok: true, label: r.displayName } : r;
  },
  linear: (id, f) => saveLinearConnection(id, f.apiKey),
  notion: (id, f) => saveNotionConnection(id, f.token),
  confluence: (id, f) => saveConfluenceConnection(id, f.siteUrl, f.email, f.apiToken),
  asana: (id, f) => saveAsanaConnection(id, f.token),
  gitlab: (id, f) => saveGitlabConnection(id, f.token, f.siteUrl?.trim() || null),
  hubspot: (id, f) => saveHubspotConnection(id, f.token),
  zendesk: (id, f) => saveZendeskConnection(id, f.siteUrl, f.email, f.apiToken),
  trello: (id, f) => saveTrelloConnection(id, f.apiKey, f.token),
  airtable: (id, f) => saveAirtableConnection(id, f.token),
  monday: (id, f) => saveMondayConnection(id, f.token),
  figma: (id, f) => saveFigmaConnection(id, f.token),
  discord: (id, f) => saveDiscordConnection(id, f.token),
  airflow: (id, f) => saveAirflowConnection(id, f.siteUrl, f.username, f.password),
  dbt: (id, f) => saveDbtConnection(id, f.token, f.accountId, f.siteUrl?.trim() || null),
  snowflake: (id, f) => saveSnowflakeConnection(id, f.account, f.username, f.privateKey, f.warehouse?.trim() || null),
  databricks: (id, f) => saveDatabricksConnection(id, f.workspaceUrl, f.clientId, f.clientSecret),
};

const DISCONNECT_HANDLERS: Partial<Record<SurfaceKey, (personId: number) => Promise<void>>> = {
  github: disconnectGithub,
  jira: disconnectJira,
  linear: disconnectLinear,
  notion: disconnectNotion,
  confluence: disconnectConfluence,
  asana: disconnectAsana,
  gitlab: disconnectGitlab,
  hubspot: disconnectHubspot,
  zendesk: disconnectZendesk,
  trello: disconnectTrello,
  airtable: disconnectAirtable,
  monday: disconnectMonday,
  figma: disconnectFigma,
  discord: disconnectDiscord,
  airflow: disconnectAirflow,
  dbt: disconnectDbt,
  snowflake: disconnectSnowflake,
  databricks: disconnectDatabricks,
};

// Real per-source signal for the three ingest-token tools — person.surfaces[key] only
// ever flips to 'connected' once a real event for that exact source has landed
// (POST /api/ingest/:source), never merely because a token exists. Shared by claude-code/
// codex/gemini-cli below since they're otherwise identical one-line handlers.
const ingestSourceStatus = async (id: number, key: SurfaceKey): Promise<{ connected: boolean; label: string | null }> => {
  const person = await repo.getPerson(id);
  return { connected: person.surfaces[key] === 'connected', label: null };
};

const STATUS_HANDLERS: Partial<Record<SurfaceKey, StatusHandler>> = {
  github: async (id) => { const s = await getGithubStatus(id); return { connected: s.connected, label: s.login }; },
  jira: async (id) => { const s = await getJiraStatus(id); return { connected: s.connected, label: s.email }; },
  linear: getLinearStatus,
  notion: getNotionStatus,
  confluence: async (id) => { const s = await getConfluenceStatus(id); return { connected: s.connected, label: s.email }; },
  asana: getAsanaStatus,
  gitlab: getGitlabStatus,
  hubspot: getHubspotStatus,
  zendesk: async (id) => { const s = await getZendeskStatus(id); return { connected: s.connected, label: s.email }; },
  trello: getTrelloStatus,
  airtable: getAirtableStatus,
  monday: getMondayStatus,
  figma: getFigmaStatus,
  discord: getDiscordStatus,
  airflow: getAirflowStatus,
  dbt: getDbtStatus,
  snowflake: getSnowflakeStatus,
  databricks: getDatabricksStatus,
  // Found live, reported directly: generating a Claude Code token made Codex CLI and
  // Gemini CLI both show as "connected" too — this used to read "has ≥1 active ingest
  // token" (true the moment any one of the three tools has a token, since one token
  // authenticates a push to any of them), not "is this specific tool actually connected."
  // Now reads the same real, per-source signal every other connector's status already
  // uses: person.surfaces[key], which POST /api/ingest/:source only ever flips to
  // 'connected' once a real event for that exact source has landed — never on token
  // generation alone. The "N active token(s)" count in the panel still comes straight
  // from the token list, unaffected by this — a token remains manageable (Manage button,
  // opened via the same detail panel) whether or not it's ever actually been used yet.
  'claude-code': (id) => ingestSourceStatus(id, 'claude-code'),
  codex: (id) => ingestSourceStatus(id, 'codex'),
  'gemini-cli': (id) => ingestSourceStatus(id, 'gemini-cli'),
};

/** No auth needed — same posture as GET /api/runtimes: this is catalog metadata, not
 *  anyone's connection state. */
app.get('/api/connectors/catalog', async () => {
  // The catalog is static product surface, but whether a connector can *actually* be
  // connected on this deployment isn't: the Google-backed ones need GOOGLE_CLIENT_ID/
  // SECRET/REDIRECT_URI set by whoever runs the platform, exactly like the 'coming-soon'
  // tier's "needs a developer app registered with that vendor first". Found live on the
  // real deployment, which has no Google credentials at all: the dropdown offered Google
  // Calendar as 'live' and Gmail as a plain link, and clicking either opened a new tab
  // showing the raw JSON `{"error":"Google OAuth is not configured on the backend — see
  // backend/.env.example"}`. Reporting the real per-deployment status here reuses the
  // disabled-option path the catalog already drives, instead of offering a button that
  // cannot work and blaming a .env file the person reading it has never heard of.
  const google = googleConfigured();
  const catalog = google
    ? CONNECTOR_CATALOG
    : CONNECTOR_CATALOG.map((c) => (c.authType === 'oauth-google' ? { ...c, status: 'coming-soon' as const } : c));
  return { catalog, oauth: { google } };
});

/** Status for every connector at once — the ConnectorsPanel's one fetch on load. GitHub
 *  and Jira also keep their own bespoke status endpoints (kept for backward
 *  compatibility, unused by the frontend now that ConnectorsPanel is the one dropdown
 *  everything lives in) — both paths hit the exact same underlying status functions, so
 *  they can never disagree. Calendar has no connection of its own and mirrors Gmail's. */
app.get('/api/person/:id/connectors', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const statuses: Record<string, { connected: boolean; label: string | null }> = {};
  for (const def of CONNECTOR_CATALOG) {
    if (def.status === 'coming-soon') {
      statuses[def.key] = { connected: false, label: null };
      continue;
    }
    if (def.key === 'calendar') {
      const gmail = await getGmailStatus(id);
      statuses[def.key] = { connected: gmail.connected, label: gmail.email };
      continue;
    }
    const handler = STATUS_HANDLERS[def.key];
    statuses[def.key] = handler ? await handler(id) : { connected: false, label: null };
  }
  return { statuses };
});

app.post('/api/person/:id/connectors/:key', {
  // Fields vary per connector (connectorCatalog.ts); every value is a bounded string.
  schema: { body: { type: 'object', additionalProperties: str(8192) } },
}, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const key = (req.params as { key: string }).key as SurfaceKey;
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const def = CONNECTOR_CATALOG.find((c) => c.key === key);
  if (!def) {
    reply.code(404);
    return { error: 'unknown connector' };
  }
  if (def.status === 'coming-soon') {
    reply.code(400);
    return { error: `${def.name} isn't configured on this platform yet — it needs a developer app registered by the operator first.` };
  }
  const handler = CONNECT_HANDLERS[key];
  if (!handler) {
    reply.code(400);
    return { error: `${def.name} can't be connected from here.` };
  }
  const fields = (req.body ?? {}) as Record<string, string>;
  for (const f of def.fields) {
    if (!f.optional && !fields[f.key]?.trim()) {
      reply.code(400);
      return { error: `${f.label} is required` };
    }
  }
  const result = await handler(id, fields);
  if (!result.ok) {
    reply.code(400);
    return { error: result.error };
  }
  await repo.updatePersonSurface(id, key, 'connected');
  return { connected: true, label: result.label };
});

app.delete('/api/person/:id/connectors/:key', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const key = (req.params as { key: string }).key as SurfaceKey;
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const handler = DISCONNECT_HANDLERS[key];
  if (handler) await handler(id);
  const before = await repo.getPerson(id);
  if (before.surfaces[key] === 'connected') {
    await repo.updatePersonSurface(id, key, 'absent');
  }
  return { ok: true };
});

/** A real, on-demand "is this still working" check — see verifyProvider's own module
 *  comment (resourceProviders.ts) for the gap this closes: every status check above is
 *  DB-existence only, never a live ping. */
app.post('/api/person/:id/connectors/:key/verify', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const key = (req.params as { key: string }).key;
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const orgId = await repo.getOrgIdOfPerson(id);
  return verifyProvider(orgId, id, key);
});

/* ---------- generic connector catalog: personal (no-org) account variant ----------
   Same catalog, same ConnectorsPanel component, same three-endpoint shape as the
   person-keyed routes just above — but scoped to the logged-in account itself (no :id
   param at all, same posture as GET/POST /api/accounts/me/main-agent) since a personal
   account has no `people` row to key off of. Calendar is excluded — it rides on Gmail's
   OAuth token, which personal accounts don't have (Gmail was never extended there). */
app.get('/api/accounts/me/connectors', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const statuses: Record<string, { connected: boolean; label: string | null }> = {};
  for (const def of CONNECTOR_CATALOG) {
    if (def.key === 'calendar') continue;
    if (def.status === 'coming-soon') {
      statuses[def.key] = { connected: false, label: null };
      continue;
    }
    const handler = ACCOUNT_STATUS_HANDLERS[def.key];
    statuses[def.key] = handler ? await handler(accountId) : { connected: false, label: null };
  }
  return { statuses };
});

app.post('/api/accounts/me/connectors/:key', {
  schema: { body: { type: 'object', additionalProperties: str(8192) } },
}, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const key = (req.params as { key: string }).key as SurfaceKey;
  const def = CONNECTOR_CATALOG.find((c) => c.key === key);
  if (!def || def.key === 'calendar') {
    reply.code(404);
    return { error: 'unknown connector' };
  }
  if (def.status === 'coming-soon') {
    reply.code(400);
    return { error: `${def.name} isn't configured on this platform yet — it needs a developer app registered by the operator first.` };
  }
  const handler = ACCOUNT_CONNECT_HANDLERS[key];
  if (!handler) {
    reply.code(400);
    return { error: `${def.name} can't be connected from here.` };
  }
  const fields = (req.body ?? {}) as Record<string, string>;
  for (const f of def.fields) {
    if (!f.optional && !fields[f.key]?.trim()) {
      reply.code(400);
      return { error: `${f.label} is required` };
    }
  }
  const result = await handler(accountId, fields);
  if (!result.ok) {
    reply.code(400);
    return { error: result.error };
  }
  return { connected: true, label: result.label };
});

app.delete('/api/accounts/me/connectors/:key', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const key = (req.params as { key: string }).key as SurfaceKey;
  const handler = ACCOUNT_DISCONNECT_HANDLERS[key];
  if (handler) await handler(accountId);
  return { ok: true };
});

/** Account-keyed sibling of POST /api/person/:id/connectors/:key/verify above — see
 *  verifyAccountProvider's own module comment (personalConnectors.ts). */
app.post('/api/accounts/me/connectors/:key/verify', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const key = (req.params as { key: string }).key;
  return verifyAccountProvider(accountId, key);
});

/* ---------- personal account: GitHub, Jira, sub-agents, ingest tokens ----------
   The rest of what OrgSetUpMyAgent gets, made reachable for an account with no
   organization at all — found live, reported directly: these tools "should be there
   along with the previous ones" (GitHub/Jira/Claude Code/Codex/Gemini CLI), not just the
   generic connector catalog. Same underlying save/status/disconnect functions as the
   org-mode routes just above (githubConnection.ts/jiraConnection.ts's own Account
   variants), gated the same way every other /api/accounts/me/* route is — logged in as
   yourself, nothing else, since there's no org role to check. */

app.post('/api/accounts/me/github', { schema: bodySchema({ token: str(500) }, ['token']) }, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const { token } = req.body as { token?: string };
  if (!token?.trim()) {
    reply.code(400);
    return { error: 'token is required' };
  }
  const result = await saveGithubAccountConnection(accountId, token.trim());
  if (!result.ok) {
    reply.code(400);
    return { error: result.error };
  }
  return { connected: true, login: result.login };
});
app.get('/api/accounts/me/github/status', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  return getGithubAccountStatus(accountId);
});
app.delete('/api/accounts/me/github', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  await disconnectGithubAccount(accountId);
  return { ok: true };
});

app.post('/api/accounts/me/jira', {
  schema: bodySchema({ siteUrl: str(500), email: str(254), apiToken: str(500) }, ['siteUrl', 'email', 'apiToken']),
}, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const { siteUrl, email, apiToken } = req.body as { siteUrl?: string; email?: string; apiToken?: string };
  if (!siteUrl?.trim() || !email?.trim() || !apiToken?.trim()) {
    reply.code(400);
    return { error: 'siteUrl, email, and apiToken are all required' };
  }
  const result = await saveJiraAccountConnection(accountId, siteUrl.trim(), email.trim(), apiToken.trim());
  if (!result.ok) {
    reply.code(400);
    return { error: result.error };
  }
  return { connected: true, displayName: result.displayName };
});
app.get('/api/accounts/me/jira/status', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  return getJiraAccountStatus(accountId);
});
app.delete('/api/accounts/me/jira', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  await disconnectJiraAccount(accountId);
  return { ok: true };
});

app.get('/api/accounts/me/runtimes', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const [catalog, registered] = await Promise.all([repo.getRuntimeCatalog(), repo.getAccountRuntimes(accountId)]);
  return { catalog, registered };
});
app.post('/api/accounts/me/runtimes', { schema: bodySchema({ runtimeKey: str(60, 1) }, ['runtimeKey']) }, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const { runtimeKey } = req.body as { runtimeKey: string };
  const checked = await checkCatalogEntry(runtimeKey, reply);
  if ('error' in checked) return checked;
  const existing = await repo.getAccountRuntimes(accountId);
  if (existing.some((r) => r.runtimeKey === runtimeKey)) {
    reply.code(409);
    return { error: 'already registered' };
  }
  const scope: RuntimeScope = checked.entry.approved ? 'full' : 'pending';
  const addedAt = new Date().toISOString().slice(0, 10);
  await repo.insertAccountRuntime(accountId, runtimeKey, scope, addedAt);
  return { registered: await repo.getAccountRuntimes(accountId) };
});
app.delete('/api/accounts/me/runtimes/:key', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const key = (req.params as { key: string }).key;
  await repo.deleteAccountRuntime(accountId, key);
  return { registered: await repo.getAccountRuntimes(accountId) };
});

app.post('/api/accounts/me/ingest-tokens', { schema: bodySchema({ label: str(80) }, ['label']) }, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const { label } = req.body as { label?: string };
  if (!label?.trim()) {
    reply.code(400);
    return { error: 'label is required' };
  }
  const created = await generateAccountToken(accountId, label.trim());
  return { id: created.id, token: created.token };
});
app.get('/api/accounts/me/ingest-tokens', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  return { tokens: await listAccountTokens(accountId) };
});
app.delete('/api/accounts/me/ingest-tokens/:tokenId', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const tokenId = (req.params as { tokenId: string }).tokenId;
  await revokeAccountToken(accountId, tokenId);
  return { tokens: await listAccountTokens(accountId) };
});

/** Register/list/remove your own freely-named custom sub-agent — a finance agent, a
 *  marketing agent, anything you describe for yourself — generalizing the fixed
 *  claude-code/codex/gemini-cli ingest sources into an open-ended one. Registering just
 *  reserves a source_key to push under; it authenticates with the SAME ingest tokens
 *  generated above, not a new secret of its own. Account-only, same as every other
 *  personal-agent piece — see account_custom_agents' own 0001_baseline.sql comment for why this
 *  never touches SurfaceKey or the claims/policy pipeline. */
app.post('/api/accounts/me/custom-agents', {
  schema: bodySchema({ name: str(80), purpose: str(500) }, ['name', 'purpose']),
}, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const { name, purpose } = req.body as { name?: string; purpose?: string };
  if (!name?.trim() || !purpose?.trim()) {
    reply.code(400);
    return { error: 'name and purpose are required' };
  }
  const agent = await repo.createAccountCustomAgent(accountId, name.trim(), purpose.trim());
  return { agent };
});
app.get('/api/accounts/me/custom-agents', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  return { agents: await repo.listAccountCustomAgents(accountId) };
});
app.delete('/api/accounts/me/custom-agents/:id', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const id = (req.params as { id: string }).id;
  await repo.deleteAccountCustomAgent(accountId, id);
  return { agents: await repo.listAccountCustomAgents(accountId) };
});

/* ---------- self-service: connect your own tool ----------
   The general, non-hardcoded mechanism (docs/agent-to-agent-communication.md §13): a
   person generates a token here, pastes it into their own tool's native hook/telemetry
   config (Claude Code's `http`-type PostToolUse hook, Codex CLI's [otel]/[hooks], Gemini
   CLI's telemetry config), and that tool pushes its own real activity straight to
   POST /api/ingest/:source from wherever it actually runs. Identity comes from the
   token — never from anything the request body claims — the same lesson deriveAllowedRoles
   already enforces for a claimed org-chart relationship. */

const INGEST_SOURCES = ['claude-code', 'codex', 'gemini-cli'];

app.post('/api/person/:id/ingest-tokens', { schema: bodySchema({ label: str(80) }, ['label']) }, async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const { label } = req.body as { label?: string };
  if (!label?.trim()) {
    reply.code(400);
    return { error: 'label is required' };
  }
  const created = await generateToken(id, label.trim());
  // The raw token is returned exactly once — only its hash is ever stored.
  return { id: created.id, token: created.token };
});

app.get('/api/person/:id/ingest-tokens', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  return { tokens: await listTokens(id) };
});

app.delete('/api/person/:id/ingest-tokens/:tokenId', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const check = await requireSelf(req, id);
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const tokenId = (req.params as { tokenId: string }).tokenId;
  await revokeToken(id, tokenId);
  return { tokens: await listTokens(id) };
});

/** The receiving end. Auth is Bearer-token only — the :source path segment says which tool
 *  is talking, the token says who it's talking for. Unrecognized tool-call shapes (most
 *  hook firings — anything outside NARRATIVE_TOOLS) are accepted and silently dropped, not
 *  errored, since a hook fires on every single tool call. Tries a person's token first,
 *  then a personal account's — the two token spaces are disjoint (one hashed value can
 *  never match both tables), so trying both costs one extra lookup only on the account
 *  path, never a real ambiguity. */
app.post('/api/ingest/:source', {
  // Per token, not per IP: a leaked token must not be able to flood someone's activity (and
  // later prompts) from many addresses. A hook fires per tool call, so 120 a minute is generous.
  config: {
    rateLimit: {
      max: 120,
      timeWindow: '1 minute',
      keyGenerator: (req: { headers: Record<string, unknown>; ip: string }) => {
        const auth = req.headers.authorization;
        return typeof auth === 'string' && auth.startsWith('Bearer ') ? `ingest:${hashSessionToken(auth.slice(7).trim())}` : `ingest-ip:${req.ip}`;
      },
    },
  },
}, async (req, reply) => {
  const source = (req.params as { source: string }).source;
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
  if (!token) {
    reply.code(401);
    return { error: 'missing bearer token' };
  }
  const resolved = await resolveToken(token);
  const resolvedAccount = resolved ? null : await resolveAccountToken(token);
  if (!resolved && !resolvedAccount) {
    reply.code(401);
    return { error: 'invalid or revoked token' };
  }

  // Beyond the three fixed sources, the only other valid case is a real custom agent this
  // same account registered for itself (custom agents are account-only — a person's own
  // token never resolves one). A source_key that doesn't resolve to one, or resolves to a
  // different account's, is rejected exactly like an unrecognized fixed source — this is
  // the ownership check, not just "does this string look like a real source."
  if (!INGEST_SOURCES.includes(source)) {
    const agent = resolvedAccount ? await repo.getAccountCustomAgentBySourceKey(source) : null;
    if (!agent || agent.accountId !== resolvedAccount?.accountId) {
      reply.code(404);
      return { error: `unknown source — must be one of: ${INGEST_SOURCES.join(', ')}, or one of your own registered custom agents` };
    }
  }

  const normalized = normalizeIngestPayload(req.body);
  if (!normalized) {
    reply.code(202);
    return { recorded: false };
  }

  if (resolved) {
    await recordEvent(resolved.personId, source, normalized);
    // The first real pushed event IS the self-service act of connecting the surface —
    // same principle as GitHub's PAT-save flipping its surface, just triggered by real
    // activity arriving instead of a credential being validated (a token alone doesn't
    // prove anything is actually being pushed yet; a landed event does).
    const person = await repo.getPerson(resolved.personId);
    if (person.surfaces[source as SurfaceKey] !== 'connected') {
      await repo.updatePersonSurface(resolved.personId, source as SurfaceKey, 'connected');
    }
  } else if (resolvedAccount) {
    // A personal account has no `surfaces` state to flip — connected-ness for it is
    // derived purely from whether any events exist, same as every other account-scoped
    // digest provider (personalConnectors.ts).
    await recordAccountEvent(resolvedAccount.accountId, source, normalized);
  }

  reply.code(202);
  return { recorded: true };
});

/* ---------- policy ---------- */

// Members see the grid governing them (OrgStructure.tsx); admins edit it (PolicyMatrix.tsx).
app.get('/api/policy', async (req, reply) => {
  const orgId = orgIdFromQuery(req);
  const access = await requireOrgAccess(req, orgId);
  if (!access.ok) {
    reply.code(access.code);
    return { error: access.error };
  }
  const [revision, history] = await Promise.all([repo.getCurrentRevision(orgId), repo.listRevisions(orgId)]);
  return { revision, history: history.map((r) => ({ id: r.id, createdAt: r.createdAt, note: r.note })) };
});

/** Editing writes a NEW revision. Nothing updates in place. The single most sensitive
 *  mutating action in the app — it changes what's disclosed org-wide — so it requires
 *  'admin'+, same bar as adding/removing people. */
app.post('/api/policy/cycle', {
  schema: bodySchema({ role: ROLE, dataClass: { type: 'string', enum: [...CONFIGURABLE_CLASSES] } }, ['role', 'dataClass']),
}, async (req, reply) => {
  const orgId = orgIdFromQuery(req);
  const check = await requireOrgRole(req, orgId, 'admin', 'not authorized to edit this organization\'s policy', { elevated: true });
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const { role, dataClass } = req.body as { role: RequesterRole; dataClass: ConfigurableClass };
  const prev = await repo.getCurrentRevision(orgId);
  const grid = structuredClone(prev.grid);
  grid[role][dataClass] = nextDisposition(grid[role][dataClass]);

  const revision = await repo.insertRevision({
    orgId,
    grid,
    createdBy: 'admin',
    note: `${role} × ${dataClass} → ${grid[role][dataClass]}`,
    now: new Date().toISOString(),
  });
  return { revision };
});

/* ---------- query: the whole point ---------- */

/**
 * Never trust a client-asserted requesterRole for a real (persisted) ask — verify it
 * against the org graph first. Closes the "identity spoofing" failure class documented
 * in inter-agent-trust security research (docs/agent-to-agent-communication.md §12):
 * without this, any caller can claim to be "Executive" or "Direct manager" about anyone,
 * and the deterministic grid downstream enforces nothing because its input was forged.
 * Preview and the policy test panel never call this — they never persist, so there's no
 * real disclosure event to protect against; role is validated exactly where auditability
 * begins.
 */
async function verifyRequesterRole(orgId: number, requesterId: number, targetId: number, claimedRole: RequesterRole): Promise<boolean> {
  const people = await repo.getPeople(orgId);
  return deriveAllowedRoles(requesterId, targetId, people).includes(claimedRole);
}

app.post('/api/query', {
  schema: bodySchema({ targetId: ID, role: ROLE, question: QUESTION, persist: { type: 'boolean' } }, ['targetId', 'role']),
}, async (req, reply) => {
  const body = req.body as {
    targetId: number;
    role: RequesterRole;
    question?: string;
    requesterId?: number;
    persist?: boolean;
  };
  // Identity comes only from the session. Anonymous callers get nothing — not even a
  // preview (SEC-02: a "self-preview" used to be satisfied by typing the same id twice) —
  // and are refused before any lookup, so they can't enumerate person ids either.
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const orgId = await orgIdOfPersonOrNull(body.targetId);
  if (orgId == null) {
    reply.code(404);
    return { error: 'no such person' };
  }
  const requesterId = (await repo.getPeopleForAccount(accountId)).find((p) => p.orgId === orgId)?.id;

  if (body.persist) {
    if (requesterId == null || !(await verifyRequesterRole(orgId, requesterId, body.targetId, body.role))) {
      reply.code(403);
      return { error: `you may not ask as "${body.role}" about this person — that relationship doesn't hold in the org chart` };
    }
  } else {
    // Preview/simulation mode deliberately bypasses org-graph role-truthfulness — that's
    // the whole point of "what would an Executive see" (My agent → Preview, Admin → Policy
    // Matrix). It is allowed for your own record, or for a real org viewer+ testing the grid.
    const isSelfPreview = requesterId != null && requesterId === body.targetId;
    if (!isSelfPreview) {
      const check = await requireOrgRole(req, orgId, 'viewer', 'not authorized to preview this organization\'s policy');
      if (!check.ok) {
        reply.code(check.code);
        return { error: check.error };
      }
    }
  }

  // Real ingestion (docs/agent-to-agent-communication.md §6) — fans out to every real,
  // connected resource provider the target has (today: Claude Code) and turns their
  // activity into real Claims before the deterministic policy engine ever sees them.
  // No-op for anyone who hasn't connected a real source. Best-effort at this call site:
  // a single provider hiccup must never break someone's ability to ask a normal question.
  try {
    await gatherAll(orgId, body.targetId, undefined, body.question);
  } catch (err) {
    app.log.error({ err }, 'real claim ingestion failed — continuing with existing claims');
  }

  const [target, claims, surfaces, revision] = await Promise.all([
    repo.getPerson(body.targetId),
    repo.getClaims(orgId, body.targetId),
    repo.getSurfaces(),
    repo.getCurrentRevision(orgId),
  ]);
  const now = new Date().toISOString();

  const snapshot = respond({
    target,
    claims,
    surfaces,
    requesterRole: body.role,
    revision,
    now,
  });

  // Preview and the policy test panel do not write to the log — they are simulations,
  // not reads. Only an actual query is recorded.
  if (body.persist) {
    await repo.appendAuditEntry({
      orgId,
      requesterId: requesterId ?? 0,
      requesterRole: body.role,
      targetPersonId: body.targetId,
      question: body.question ?? '(no question)',
      snapshot,
      now,
    });

    // Escalation detection (docs/escalation-triage.md) — only ever runs off a real,
    // audited ask, same as the audit write above; a preview never crystallizes one.
    // Best-effort: one detection rule erroring must never break a normal ask.
    try {
      const people = await repo.getPeople(orgId);
      await runEscalationChecks({ orgId, requesterId: requesterId ?? 0, target, people, surfaces, claims, now: new Date(now) });
    } catch (err) {
      app.log.error({ err }, 'escalation checks failed — continuing');
    }
  }

  // Scoped strictly to what respond() actually disclosed in `snapshot.items` — never the
  // whole org's evidence table. Found and closed during a security audit: this used to
  // return repo.getEvidence(orgId) unfiltered, so every evidence record in the
  // organization (regardless of tier or whether anything referencing it was actually
  // authorized) rode along with every response, persisted or not, authenticated or not.
  const referencedEvidenceIds = new Set(snapshot.items.map((i) => i.evidenceId).filter((id): id is string => id != null));
  const allEvidence = await repo.getEvidence(orgId);
  const evidence: Record<string, unknown> = {};
  for (const id of referencedEvidenceIds) {
    if (allEvidence[id]) evidence[id] = allEvidence[id];
  }

  return { response: snapshot, evidence };
});

/**
 * The manager-asks-employee scenario from docs/agent-to-agent-communication.md, made
 * real: an arbitrary free-text question, answered by gathering the target's real
 * connected resources, running the SAME unmodified deterministic policy engine used
 * everywhere else, and only then handing the *already-authorized* subset to an LLM to
 * write up as a direct answer. See orchestrator.ts's allowedTextOnly — WONT/CANT text
 * never reaches the model, only a count of how much was withheld.
 */
app.post('/api/agent/ask', {
  schema: bodySchema(
    { targetId: ID, role: ROLE, question: QUESTION, persist: { type: 'boolean' }, conversationId: UUID },
    ['targetId', 'role', 'question'],
  ),
}, async (req, reply) => {
  const body = req.body as {
    targetId: number;
    role: RequesterRole;
    question?: string;
    requesterId?: number;
    persist?: boolean;
    /** Groups this ask into a chat thread with the target — My agent → Ask yourself
     *  (requesterId === targetId) or a real cross-person Ask thread (e.g. a manager's own
     *  chat with one employee). See conversationId handling below. Omitted (Preview-style
     *  non-persisted calls, or the very first ask in a thread) means "not part of a chat"
     *  or "start a new one" respectively — nothing about existing behavior changes when
     *  it's absent. */
    conversationId?: string;
  };
  if (!body.question?.trim()) {
    reply.code(400);
    return { error: 'question is required' };
  }
  const question = body.question.trim();

  if ((await currentAccountId(req)) == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const orgId = await orgIdOfPersonOrNull(body.targetId);
  if (orgId == null) {
    reply.code(404);
    return { error: 'no such person' };
  }

  // The requester is the session's own identity in this org — never body.requesterId
  // (SEC-01: an anonymous caller could previously ask as the CEO about anyone).
  const session = await requireSessionPerson(req, orgId);
  if (!session.ok) {
    reply.code(session.code);
    return { error: session.error };
  }
  const requesterId = session.personId;

  // Role truthfulness is verified unconditionally, persisted or not — the response body is
  // exactly as disclosive either way.
  {
    const ok = await verifyRequesterRole(orgId, requesterId, body.targetId, body.role);
    if (!ok) {
      reply.code(403);
      return { error: `you may not ask as "${body.role}" about this person — that relationship doesn't hold in the org chart` };
    }
  }

  // Which surface keys the router actually decided to call for this question — becomes
  // part of `consultedSources` below, real proof of the routing rather than a fire-and-
  // forget side effect. No manual "since" here anymore — gatherAll's own router now infers
  // a window per surface from the question itself (see its doc comment); the old fixed
  // "Today / This week" toggle this used to thread through was found live not to scale to
  // hundreds of connected tools, and removed rather than left alongside the router.
  let usedSurfaceKeys: string[] = [];
  try {
    usedSurfaceKeys = await gatherAll(orgId, body.targetId, undefined, question);
  } catch (err) {
    app.log.error({ err }, 'real claim ingestion failed — continuing with existing claims');
  }

  const [target, claims, surfaces, revision] = await Promise.all([
    repo.getPerson(body.targetId),
    repo.getClaims(orgId, body.targetId),
    repo.getSurfaces(),
    repo.getCurrentRevision(orgId),
  ]);
  const now = new Date().toISOString();

  // A real chat: any persisted ask from an identified requester — themselves (My agent →
  // Ask yourself, requesterId === targetId) or a real cross-person Ask thread (e.g. a
  // manager's own chat with one employee). A Preview-style non-persisted call behaves
  // exactly as before — conversationId stays undefined and nothing below runs.
  const conversational = body.persist && !!requesterId;
  let conversationId: string | undefined;
  let priorTurns: { question: string; answer: string }[] | undefined;
  if (conversational) {
    conversationId = body.conversationId ?? randomUUID();
    if (body.conversationId) {
      // Existing chat — pull its real prior turns for context. Reuses auditForSubject
      // rather than a new query; each answer here already passed through
      // allowedTextOnly() when it was first produced, so replaying it as context here
      // introduces no new raw or withheld data into the prompt. Also scoped to turns
      // asked under the SAME role as this question: role governs what's authorized
      // (domain/policy.ts), and unlike Self-chat (role always locked to 'Self') a
      // cross-person Ask thread can have its role changed between turns — feeding a
      // broader-access turn's answer back in as context for a narrower-access turn would
      // leak information across that boundary, so a role change starts this turn with no
      // prior context rather than risk that.
      const history = await repo.auditForSubject(body.targetId);
      priorTurns = history
        .filter((e) => e.requesterId === requesterId && e.conversationId === body.conversationId && e.requesterRole === body.role)
        .map((e) => ({ question: e.question, answer: e.snapshot.synthesizedAnswer ?? '' }))
        .filter((t) => t.answer);
    }
  }

  // The PDP — identical call to /api/query. This is the one thing that must never
  // change shape between the two endpoints: what's authorized doesn't depend on whether
  // someone wants a synthesized answer or a raw list of it.
  const snapshot = respond({ target, claims, surfaces, requesterRole: body.role, revision, now });

  const { allowed, withheldCount } = allowedTextOnly(snapshot.items);
  const sections: { source: string; digest: string }[] = [];
  if (allowed.length > 0) {
    sections.push({
      source: `Authorized claims about ${target.name}`,
      digest: allowed.map((i) => `- ${i.text}`).join('\n'),
    });
  }

  // The org's one main agent does the synthesizing — the same org whose tools gatherAll()
  // just invoked above. Claude, ChatGPT, or a self-hosted model all resolve identically.
  // Resolved before the Gmail bridge below (moved earlier than it used to be) since that
  // bridge needs the same provider for its own relevance check.
  const { provider, runtimeName, configEnvVar } = await getMainProvider(orgId);
  const consultedSources: string[] = surfaces.filter((s) => usedSurfaceKeys.includes(s.key)).map((s) => s.name);

  // Ephemeral, self-ask-only Gmail bridge. Gmail is deliberately NOT a resourceProviders.ts
  // provider — its content must never become a claims-table row a manager could later see
  // through cross-person Ask (see that file's module comment). This only ever runs when
  // the requester is asking about themselves, feeds directly into *this turn's* prompt,
  // and is never persisted as anything but the label "Gmail" in consultedSources — the
  // digest itself lives only in this request's memory. Real code, same fail-open shape as
  // every other integration call site here; UNVERIFIED against a live Gmail account (see
  // CLAUDE.md) since completing Google's own consent screen needs a real person's action.
  const isSelfAsk = body.role === 'Self' && requesterId === body.targetId;
  if (isSelfAsk && provider?.configured()) {
    try {
      const gmailToken = await getValidGmailAccessToken(body.targetId);
      if (gmailToken) {
        const relevant = await provider.selectRelevantSurfaces(question, [
          { surfaceKey: 'gmail', reads: 'Your own inbox — sender, subject, snippet, read-only' },
        ]);
        if (relevant.has('gmail')) {
          const gmailSince = new Date();
          gmailSince.setUTCDate(gmailSince.getUTCDate() - (relevant.get('gmail') ?? DEFAULT_SINCE_DAYS));
          const digest = formatGmailDigest(await getEmailsSince(gmailToken, gmailSince));
          if (digest) {
            sections.push({ source: 'Your Gmail', digest });
            consultedSources.push('Gmail');
          }
        }
      }
    } catch (err) {
      app.log.error({ err }, 'gmail self-ask bridge failed — continuing without it');
    }
  }

  let answer: string;
  if (sections.length === 0) {
    answer = `Nothing about ${target.name} is disclosable to you right now.`;
  } else if (provider?.configured()) {
    try {
      answer = await provider.synthesize(target.name, question, sections, priorTurns);
    } catch (err) {
      // Configured doesn't mean reachable — Ollama not running, a network blip, a real
      // provider outage. Unlike selectRelevantSurfaces (which fails open internally,
      // since "gather everything" is always a safe default), synthesize has no
      // equivalent safe default of its own to fall back to — only the caller has the
      // raw sections to hand back instead. Must degrade the same way "not configured"
      // already does, not throw: an ask must never hard-fail (and skip its own audit
      // entry) just because the model happened to be unreachable this one time.
      app.log.error({ err }, 'model provider synthesis failed — falling back to raw authorized data');
      answer = `${runtimeName ?? 'The configured model'} could not be reached to answer this, so this is the raw authorized data rather than a direct answer to "${question}":\n\n${rawActivityDigest(sections)}`;
    }
  } else {
    const whoMissing = runtimeName && configEnvVar
      ? `No ${configEnvVar} configured for ${target.name}'s main agent (${runtimeName})`
      : `No main agent is configured for ${target.name}`;
    answer = `${whoMissing}, so this is the raw authorized data rather than a direct answer to "${question}":\n\n${rawActivityDigest(sections)}`;
  }

  const fullSnapshot = { ...snapshot, synthesizedAnswer: answer, consultedSources };
  if (body.persist) {
    await repo.appendAuditEntry({
      orgId,
      requesterId: requesterId ?? 0,
      requesterRole: body.role,
      targetPersonId: body.targetId,
      question,
      snapshot: fullSnapshot,
      now,
      conversationId,
    });

    try {
      const people = await repo.getPeople(orgId);
      await runEscalationChecks({ orgId, requesterId: requesterId ?? 0, target, people, surfaces, claims, now: new Date(now) });
    } catch (err) {
      app.log.error({ err }, 'escalation checks failed — continuing');
    }
  }

  return { answer, items: snapshot.items, withheldCount, coverage: snapshot.coverage, conversationId, consultedSources };
});

/** Ask the same free-text question about several freely-chosen people at once and get
 *  one rolled-up update — the multi-target extension of /api/agent/ask above. The set of
 *  people is a real, open choice (a CEO picking the Eng manager and the Fin manager, say),
 *  not derived from the org chart the way an earlier version of this endpoint restricted
 *  it to direct reports only — so, unlike that version, `targetIds` genuinely is
 *  client-supplied here. The trust boundary that matters doesn't move for that: exactly
 *  like a single /api/agent/ask, one claimed `role` is checked per target against
 *  deriveAllowedRoles, and a target the claimed role isn't truthful for is never silently
 *  dropped — it comes back as its own explicit, visible rejection in `perPerson`, same
 *  "withholding is always visible" rule the rest of this system follows. Each target that
 *  *does* pass still goes through its own real gatherAll → respond() call and gets its own
 *  real audit row — asking about several people is that many real disclosure events, not
 *  one, and each of them still sees exactly and only what was told about them, never
 *  another selected person's data folded in. The one combined answer is built a second
 *  time, from each accepted target's own already-synthesized (never raw) answer, so
 *  nothing reaches that final call that wasn't already independently authorized. */
app.post('/api/agent/ask-multi', {
  // Each target is its own gather + model call, so the selection is capped.
  schema: bodySchema(
    { targetIds: { type: 'array', minItems: 1, maxItems: 20, items: ID }, role: ROLE, question: QUESTION, persist: { type: 'boolean' } },
    ['targetIds', 'role', 'question'],
  ),
}, async (req, reply) => {
  const body = req.body as { requesterId?: number; role?: RequesterRole; targetIds?: number[]; question?: string; persist?: boolean };
  if (!body.question?.trim()) {
    reply.code(400);
    return { error: 'question is required' };
  }
  if (!body.role) {
    reply.code(400);
    return { error: 'role is required' };
  }
  const targetIds = [...new Set((body.targetIds ?? []).filter((id) => Number.isInteger(id)))];
  if (targetIds.length === 0) {
    reply.code(400);
    return { error: 'select at least one person to ask about' };
  }
  const question = body.question.trim();
  const role = body.role;

  if ((await currentAccountId(req)) == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  // The org is the first selected person's; every other target is checked against that
  // same org's chart below (someone from another org comes back as "not found").
  const orgId = await orgIdOfPersonOrNull(targetIds[0]);
  if (orgId == null) {
    reply.code(404);
    return { error: 'no such person' };
  }
  const session = await requireSessionPerson(req, orgId);
  if (!session.ok) {
    reply.code(session.code);
    return { error: session.error };
  }
  const requesterId = session.personId;

  const people = await repo.getPeople(orgId);
  const requester = people.find((p) => p.id === requesterId);
  const requesterName = requester?.name ?? 'the requester';

  const [{ provider, runtimeName, configEnvVar }, surfaces, revision] = await Promise.all([
    getMainProvider(orgId),
    repo.getSurfaces(),
    repo.getCurrentRevision(orgId),
  ]);
  const now = new Date().toISOString();

  // At most 4 people at once — each one fans out again across that person's connected tools.
  const perPerson = await mapWithConcurrency(targetIds, 4, async (targetId) => {
    const target = people.find((p) => p.id === targetId);
    if (!target) {
      return { personId: targetId, name: null, ok: false as const, reason: 'not found in this org chart' };
    }
    if (!deriveAllowedRoles(requesterId, targetId, people).includes(role)) {
      return { personId: targetId, name: target.name, ok: false as const, reason: `you may not ask as "${role}" about ${target.name} — that relationship doesn't hold in the org chart` };
    }

    let usedSurfaceKeys: string[] = [];
    try {
      usedSurfaceKeys = await gatherAll(orgId, target.id, undefined, question);
    } catch (err) {
      app.log.error({ err }, 'real claim ingestion failed for a multi-ask target — continuing with existing claims');
    }

    const claims = await repo.getClaims(orgId, target.id);
    const snapshot = respond({ target, claims, surfaces, requesterRole: role, revision, now });
    const { allowed, withheldCount } = allowedTextOnly(snapshot.items);
    const sections = allowed.length > 0
      ? [{ source: `Authorized claims about ${target.name}`, digest: allowed.map((i) => `- ${i.text}`).join('\n') }]
      : [];
    const consultedSources = surfaces.filter((s) => usedSurfaceKeys.includes(s.key)).map((s) => s.name);

    let answer: string;
    if (sections.length === 0) {
      answer = `Nothing about ${target.name} is disclosable to you right now.`;
    } else if (provider?.configured()) {
      try {
        answer = await provider.synthesize(target.name, question, sections);
      } catch (err) {
        app.log.error({ err }, 'model provider synthesis failed for a multi-ask target — falling back to raw authorized data');
        answer = `${runtimeName ?? 'The configured model'} could not be reached to answer this, so this is the raw authorized data rather than a direct answer to "${question}":\n\n${rawActivityDigest(sections)}`;
      }
    } else {
      const whoMissing = runtimeName && configEnvVar
        ? `No ${configEnvVar} configured for ${target.name}'s main agent (${runtimeName})`
        : `No main agent is configured for ${target.name}`;
      answer = `${whoMissing}, so this is the raw authorized data rather than a direct answer to "${question}":\n\n${rawActivityDigest(sections)}`;
    }

    if (body.persist) {
      const fullSnapshot = { ...snapshot, synthesizedAnswer: answer, consultedSources };
      await repo.appendAuditEntry({
        orgId,
        requesterId,
        requesterRole: role,
        targetPersonId: target.id,
        question,
        snapshot: fullSnapshot,
        now,
      });
      try {
        await runEscalationChecks({ orgId, requesterId, target, people, surfaces, claims, now: new Date(now) });
      } catch (err) {
        app.log.error({ err }, 'escalation checks failed for a multi-ask target — continuing');
      }
    }

    return { personId: target.id, name: target.name, ok: true as const, answer, withheldCount, coverage: snapshot.coverage, consultedSources };
  });

  const accepted = perPerson.filter((p): p is Extract<typeof p, { ok: true }> => p.ok);
  const rejected = perPerson.filter((p) => !p.ok);

  // One rollup call, built only from each accepted target's own already-safe answer text
  // — never raw claim sentences a second time. Not persisted anywhere of its own: audit
  // rows are per (requester, target) pair by schema, and each accepted target's own row
  // above already carries exactly what was told about them, nothing about anyone else
  // selected folded in. A rejected target contributes only its honest rejection reason,
  // visibly, same "never silently drop" rule as everywhere else in this system.
  const rollupSections = [
    ...accepted.map((p) => ({ source: p.name, digest: p.answer })),
    ...rejected.map((p) => ({ source: p.name ?? `person #${p.personId}`, digest: `Not asked — ${p.reason}` })),
  ];
  let combinedAnswer: string;
  if (accepted.length === 0) {
    combinedAnswer = `None of the selected people could be asked as "${role}": ${rejected.map((p) => p.reason).join('; ')}`;
  } else if (provider?.configured()) {
    try {
      combinedAnswer = await provider.synthesize(`${requesterName}'s selected people`, question, rollupSections);
    } catch (err) {
      app.log.error({ err }, 'model provider rollup synthesis failed for a multi-ask — falling back to a plain list');
      combinedAnswer = rawActivityDigest(rollupSections);
    }
  } else {
    combinedAnswer = rawActivityDigest(rollupSections);
  }

  return { answer: combinedAnswer, perPerson, askedCount: accepted.length, rejectedCount: rejected.length };
});

/* ---------- audit ---------- */

/** The org-wide feed — every entry across every person, admin-only. `/api/audit/subject/:id`
 *  below is deliberately different: it's one person's own record, read by self-service
 *  pages ("Who asked about me"), and stays unauthenticated along with the rest of that
 *  self-service surface (see CLAUDE.md's auth-model note). */
app.get('/api/audit', async (req, reply) => {
  const orgId = orgIdFromQuery(req);
  const check = await requireOrgRole(req, orgId, 'viewer', 'not authorized to view this organization\'s audit log');
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const [entries, current, integrity] = await Promise.all([
    repo.listAuditEntries(orgId),
    repo.getCurrentRevision(orgId),
    repo.verifyAudit(orgId),
  ]);
  return {
    entries: entries.map((e) => ({ ...e, policyChangedSince: e.policyRevisionId !== current.id })),
    currentRevision: current.id,
    integrity,
  };
});

/** Disclosures about one person. The subject ("Who asked about me") and the org's admins
 *  see every row; any other member sees only the rows they asked themselves (Ask.tsx's
 *  chat history about someone else). Closes release-audit SEC-03: this was public, and
 *  person ids are sequential. */
app.get('/api/audit/subject/:id', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if ((await currentAccountId(req)) == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const orgId = await orgIdOfPersonOrNull(id);
  if (orgId == null) {
    reply.code(404);
    return { error: 'no such person' };
  }
  const access = await requireOrgAccess(req, orgId);
  if (!access.ok) {
    reply.code(access.code);
    return { error: access.error };
  }
  const entries = await repo.auditForSubject(id);
  if (access.personId === id || access.orgRole != null) return { entries };
  return { entries: entries.filter((e) => e.requesterId === access.personId) };
});

/** "Someone asked about you" — the bell in the top bar. Every persisted ask by someone else
 *  about any of this account's own people, across every org it belongs to, newest first. */
app.get('/api/notifications', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  return repo.listAskedAboutYou(accountId);
});

app.post('/api/notifications/seen', {
  schema: bodySchema({ through: { type: 'string', format: 'date-time', maxLength: 40 } }, ['through']),
}, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  await repo.markAskedAboutYouSeen(accountId, (req.body as { through: string }).through);
  return { ok: true };
});

/** Chats for one (requester, target) pair — My agent → Ask yourself (requesterId ===
 *  targetId) or a real cross-person Ask thread — derived from that pair's own real audit
 *  rows (listConversationsForPair groups them; nothing new is stored). */
app.get('/api/agent/conversations', async (req, reply) => {
  const { targetId } = req.query as { targetId?: string };
  if ((await currentAccountId(req)) == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const targetIdNum = Number(targetId);
  // The frontend fires this with targetId=0 whenever nothing's selected yet (a brand-new
  // org with nobody else in the chart to ask about, or the picker just hasn't loaded) —
  // not a real person id. getOrgIdOfPerson throws on any id with no matching row, which
  // this always was for 0; that unhandled throw was surfacing as a raw 500 to the
  // browser instead of the empty history this genuinely is.
  if (!Number.isInteger(targetIdNum) || targetIdNum <= 0) return { conversations: [] };
  const orgId = await repo.getOrgIdOfPerson(targetIdNum).catch(() => null);
  if (orgId == null) return { conversations: [] };
  const session = await requireSessionPerson(req, orgId);
  if (!session.ok) {
    reply.code(session.code);
    return { error: session.error };
  }
  return { conversations: await repo.listConversationsForPair(session.personId, targetIdNum) };
});

/** Turns a router-inferred `sinceDays` back into words for the honest "connected, nothing
 *  found" note below — the same rough buckets the router prompt itself was told to use. */
function daysLabel(days: number): string {
  if (days <= 1) return 'today';
  if (days <= 7) return 'the past week';
  if (days <= 31) return 'the past month';
  return `the past ${days} days`;
}

/** The personal counterpart to POST /api/agent/ask, for an account with no organization.
 *  Deliberately much smaller than the org path: no targetId/role/requesterId (the
 *  requester *is* the target, always — there's no relationship to verify), no claims, no
 *  policy engine, no coverage — none of that has anything to do with a private chat
 *  nobody else could ever ask about. Same "never hard-fail" shape as the org ask: a
 *  missing or unreachable provider degrades to a real, textual answer explaining why,
 *  never a thrown error that would skip persisting the turn. */
app.post('/api/agent/ask-personal', {
  schema: bodySchema({ question: str(4000), conversationId: UUID }, ['question']),
}, async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const body = req.body as { question?: string; conversationId?: string };
  if (!body.question?.trim()) {
    reply.code(400);
    return { error: 'question is required' };
  }
  const question = body.question.trim();

  let priorTurns: { question: string; answer: string }[] | undefined;
  if (body.conversationId) {
    const turns = await repo.getPersonalConversation(accountId, body.conversationId);
    priorTurns = turns.map((t) => ({ question: t.question, answer: t.answer }));
  }

  const [account, { provider, runtimeName, configEnvVar }] = await Promise.all([
    repo.getAccount(accountId),
    getPersonalMainProvider(accountId),
  ]);

  // Personal counterpart to gatherAll()'s router (resourceProviders.ts): narrow the
  // account's own connected tools (connectorCatalog.ts, account-keyed since a personal
  // account has no `people` row) to whichever are plausibly relevant to this question,
  // then fetch a real digest from each — fed into *this turn's* converse() call only,
  // never persisted anywhere but the answer and this row's own consulted_sources column.
  // Same fail-open shape as the org path's Gmail bridge: any failure here just means the
  // chat continues ungrounded, never a hard error.
  const consultedSources: string[] = [];
  const sections: { source: string; digest: string }[] = [];
  if (provider?.configured()) {
    try {
      const statuses = await Promise.all(
        ACCOUNT_DIGEST_PROVIDERS.map((p) => ACCOUNT_STATUS_HANDLERS[p.surfaceKey]?.(accountId)),
      );
      const connectedProviders = ACCOUNT_DIGEST_PROVIDERS.filter((_, i) => statuses[i]?.connected);
      // This account's own freely-named custom agents (a finance agent, a marketing
      // agent, ...) — the open-ended counterpart to the fixed list above. Merged into the
      // exact same router/gather/fallback logic below rather than a parallel code path,
      // so a custom agent behaves identically to any other connected source from here on.
      const customProviders = await accountCustomAgentProviders(accountId);
      const allProviders: { surfaceKey: string; label: string; fetchDigest: (id: number, since: Date) => Promise<string | null> }[] = [
        ...connectedProviders,
        ...customProviders,
      ];
      if (allProviders.length > 0) {
        const surfaces = await repo.getSurfaces();
        const candidates = [
          ...connectedProviders.map((p) => ({
            surfaceKey: p.surfaceKey as string,
            reads: surfaces.find((s) => s.key === p.surfaceKey)?.reads ?? p.surfaceKey,
          })),
          ...customProviders.map((p) => ({ surfaceKey: p.surfaceKey, reads: p.reads })),
        ];
        // The router now decides both which surfaces are relevant *and* how many days
        // back each one should look, inferred from the question itself — replacing a fixed
        // "Today / This week" toggle a person had to pick by hand before every ask. Found
        // live, reported directly: that doesn't scale to hundreds of connected tools, and
        // couldn't express anything more specific than those two options anyway. See
        // modelProvider.ts's selectRelevantSurfaces doc and orchestrator.ts's
        // DEFAULT_SINCE_DAYS for the exact inference/fail-open behavior.
        const relevant = await provider.selectRelevantSurfaces(question, candidates);
        const toRun = allProviders.filter((p) => relevant.has(p.surfaceKey));
        const sinceFor = (surfaceKey: string) => {
          const d = new Date();
          d.setUTCDate(d.getUTCDate() - (relevant.get(surfaceKey) ?? DEFAULT_SINCE_DAYS));
          return d;
        };
        const results = await settleWithConcurrency(toRun, 6, (p) => p.fetchDigest(accountId, sinceFor(p.surfaceKey)));
        results.forEach((r, i) => {
          if (r.status === 'fulfilled' && r.value) {
            sections.push({ source: toRun[i].label, digest: r.value });
            consultedSources.push(toRun[i].label);
          } else if (r.status === 'fulfilled') {
            // Connected and genuinely checked, just nothing to report for this window —
            // found live: leaving this case silent left converse() with zero signal that
            // the tool exists at all, so a bare Claude call answered "I don't have access
            // to your GitHub account" for a real, connected GitHub with no PR/review
            // activity today. Telling the model what got checked, and what that connector
            // actually reads (candidates[i].reads — the same surfaces_catalog description
            // the router itself saw), turns that into an honest, specific answer instead.
            const cand = candidates.find((c) => c.surfaceKey === toRun[i].surfaceKey);
            const windowLabel = daysLabel(relevant.get(toRun[i].surfaceKey) ?? DEFAULT_SINCE_DAYS);
            sections.push({
              source: toRun[i].label,
              digest: `Connected — reads: ${cand?.reads ?? 'recent activity'}. No matching activity found in ${windowLabel}.`,
            });
            consultedSources.push(toRun[i].label);
          } else {
            // One connector failing (a revoked token, a real provider outage, a genuine bug
            // in that connector's own code) never blocks the rest — same Promise.allSettled
            // resilience as gatherAll(). Found live: this used to be silent-logged only,
            // which reproduced the exact same "zero signal → false denial" bug the empty-
            // digest fix above already closed, just for a different trigger (an error,
            // instead of a real empty result) — a genuinely connected, genuinely relevant
            // tool that happened to error still left converse() with nothing telling it the
            // tool existed, so the model denied the connection outright instead of saying a
            // real error occurred. Now it gets the same honest, specific section (never the
            // raw error text — that's for logs, not the model or the person asking) as the
            // empty case, and still counts as consulted, since it genuinely was checked.
            const cand = candidates.find((c) => c.surfaceKey === toRun[i].surfaceKey);
            sections.push({
              source: toRun[i].label,
              digest: `Connected — reads: ${cand?.reads ?? 'recent activity'}. Checking it just now failed with a real error, so this answer doesn't include anything from it.`,
            });
            consultedSources.push(toRun[i].label);
            app.log.error({ err: r.reason, tool: toRun[i].label }, 'personal connector digest fetch failed');
          }
        });
      }
    } catch (err) {
      app.log.error({ err }, 'personal connector digest bridge failed — continuing ungrounded');
    }
  }

  let answer: string;
  if (provider?.configured()) {
    try {
      // converse, not synthesize — a personal ask has no "answer only from this" contract
      // the way an org self-ask does (see modelProvider.ts's ModelProvider.converse doc);
      // `sections`, when non-empty, just enriches an otherwise-plain conversation.
      answer = await provider.converse(account!.name, question, priorTurns, undefined, sections);
    } catch (err) {
      app.log.error({ err }, 'personal ask synthesis failed');
      answer = `${runtimeName ?? 'The configured model'} could not be reached to answer this — try again in a moment.`;
    }
  } else {
    const whoMissing = runtimeName && configEnvVar
      ? `No ${configEnvVar} configured for your personal main agent (${runtimeName})`
      : 'No personal main agent is set yet';
    answer = `${whoMissing} — connect one in "Set up my agent," then ask again.`;
  }

  const conversationId = body.conversationId ?? randomUUID();
  await repo.insertPersonalAsk(accountId, conversationId, question, answer, new Date().toISOString(), consultedSources);
  return { answer, conversationId, consultedSources };
});

/** Every one of your own personal asks — the counterpart to /api/audit/subject/:id,
 *  scoped to the logged-in account rather than an org-chart person id. Session-gated
 *  (unlike that one): a personal ask has no org-wide transparency story to serve the way
 *  "who asked about me" does, it's just your own private history. */
app.get('/api/accounts/me/asks', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  return { entries: await repo.listPersonalAsks(accountId) };
});

/** Chats for your own personal asks — the counterpart to GET /api/agent/conversations. */
app.get('/api/accounts/me/conversations', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  return { conversations: await repo.listPersonalConversations(accountId) };
});

/** Real, permanent delete for one of your own personal chats — safe to offer here (unlike
 *  the org self-ask/cross-person Ask threads GET /api/agent/conversations serves, which
 *  are audit_log rows and structurally can never be deleted, rule 2) because personal_asks
 *  carries no one else's disclosure evidence and mesh_app holds a real DELETE grant on it.
 *  Scoped to the logged-in account via repo.deletePersonalConversation — no way to delete
 *  a conversation that isn't your own, even by guessing its id. */
app.delete('/api/accounts/me/conversations/:conversationId', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const { conversationId } = req.params as { conversationId: string };
  await repo.deletePersonalConversation(accountId, conversationId);
  return { deleted: true };
});

/* ---------- serve the built frontend (production only) ----------
   Local dev keeps the two dev servers (Vite on :5173 proxying /api to this one on
   :3001) — this block only matters for a real deployment, where this one process serves
   both the API and the built frontend from the same origin (see the CORS/cookie notes
   above for why that's deliberate, not incidental). */
if (isProduction) {
  const frontendDist = path.join(PROJECT_ROOT, 'frontend', 'dist');
  await app.register(staticFiles, { root: frontendDist });

  // SPA fallback: App.tsx's router is real pushState/popstate URLs (e.g. /me/setup), so
  // a hard refresh on one of those has to still resolve to index.html rather than 404 —
  // client-side routing takes it from there. Scoped to non-API GETs only: a genuine
  // /api/* 404 must stay a real JSON 404, never get silently swallowed into this.
  app.setNotFoundHandler((req, reply) => {
    if (req.raw.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.sendFile('index.html', frontendDist);
    }
    reply.code(404);
    return { error: 'not found' };
  });
}

/* ---------- go ---------- */

// Exported for the route-level authorization suite (src/authz.api.test.ts), which drives
// the real app through app.inject() — Vitest sets VITEST, so no port is bound there.
export { app };

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`agent-org-mesh api → http://localhost:${port}`);
  // Deletes pushed tool activity older than the privacy policy's retention period.
  startActivityRetention();
}
