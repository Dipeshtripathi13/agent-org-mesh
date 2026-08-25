import { randomUUID } from 'node:crypto';
import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
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
import { DEFAULT_GRID, deriveAllowedRoles, nextDisposition, respond } from './domain/policy.js';
import type { ConfigurableClass, RequesterRole, RuntimeScope, SurfaceKey } from './domain/types.js';
import * as repo from './db/repo.js';
import type { OrgRole } from './db/repo.js';
import { anthropicConfigured, summarizeDailyActivity } from './integrations/anthropic.js';
import { rawActivityDigest } from './integrations/modelProvider.js';
import { getMainProvider } from './integrations/runtimeProvider.js';
import { formatClaudeCodeDigest, getTodaysClaudeCodeActivity, PROJECT_ROOT } from './integrations/claudeCodeActivity.js';
import { askClaudeCli, claudeCliAvailable } from './integrations/claudeCli.js';
import { disconnectGmail, getGmailStatus, getValidGmailAccessToken, saveGmailConnection } from './integrations/gmailConnection.js';
import { formatGmailDigest, getEmailsSince } from './integrations/gmail.js';
import { buildAuthUrl, exchangeCode, googleConfigured } from './integrations/googleOAuth.js';
import { disconnectGithub, getGithubStatus, saveGithubConnection } from './integrations/githubConnection.js';
import { disconnectJira, getJiraStatus, saveJiraConnection } from './integrations/jiraConnection.js';
import { normalizeIngestPayload, recordEvent } from './integrations/eventIngestion.js';
import { runEscalationChecks } from './integrations/escalationEngine.js';
import { generateToken, listTokens, resolveToken, revokeToken } from './integrations/ingestTokens.js';
import { allowedTextOnly } from './integrations/orchestrator.js';
import { gatherAll } from './integrations/resourceProviders.js';
import { sendInviteEmail } from './integrations/resendEmail.js';

const isProduction = process.env.NODE_ENV === 'production';

// trustProxy: this sits behind Railway's own reverse proxy in production, so req.ip has
// to come from the forwarded header or every request looks like it's from the same
// address — both for rate limiting below and for anything else that ever keys on IP.
const app = Fastify({ logger: false, trustProxy: true });
// Same-origin once frontend and API are served from this one process (see the static
// registration below) — cross-origin requests have no legitimate reason to hit this API
// in production, so CORS is disabled outright there rather than left permissively open.
// Local dev keeps `origin: true` since the Vite dev server (:5173) is a different origin
// from the API (:3001).
await app.register(cors, { origin: isProduction ? false : true, credentials: true });
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
  console.error({ err, url: req.url, method: req.method }, 'unhandled request error');
  const status = err.statusCode ?? 500;
  if (status < 500) {
    reply.code(status).send({ error: err.message });
    return;
  }
  reply.code(500).send({ error: 'internal server error' });
});

// Where the browser lands to sign in — used both for post-Gmail-OAuth redirects (already
// existed) and now for the login link in invite emails.
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

function orgIdFromQuery(req: { query: unknown }): number {
  const q = req.query as { orgId?: string };
  const parsed = Number(q.orgId);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/* ---------- platform: real account authentication + RBAC ----------
   Server-side sessions (backend/src/db/repo.ts's sessions table), not JWTs — a random
   token in an httpOnly/sameSite cookie, looked up by its SHA-256 hash, exactly the
   pattern ingest_tokens already established. `secure` follows `isProduction`: off for
   local dev (plain http, matching person_oauth_tokens' plaintext-token comment in
   schema.sql — honest about the dev-only posture, not pretending otherwise), on for a
   real deployment (always served over HTTPS there — a `secure` cookie over plain http
   is simply never sent, so this must flip the moment it's actually running anywhere
   real).

   One account, two independent facts: whether it administers any orgs (org_admins) and
   whether it's linked to any org-chart identities (people.account_id, resolved via
   getPeopleForAccount). Login is the same for both — the Admin panel and "My agent" are
   different *views*, not different accounts. */

const SESSION_COOKIE = 'aom_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function setSessionCookie(reply: { setCookie: (...a: any[]) => void }, accountId: number): Promise<void> {
  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await repo.createSession(accountId, hashSessionToken(token), now.toISOString(), expiresAt.toISOString());
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: isProduction, expires: expiresAt,
  });
}

/** The entire authentication boundary for this app — identity comes from the session
 *  cookie's hash, never from anything a request body or query string claims. Returns
 *  null (never throws) so every route decides its own 401 vs. "treat as logged out"
 *  response shape. */
async function currentAccountId(req: { cookies: Record<string, string | undefined> }): Promise<number | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await repo.resolveSession(hashSessionToken(token), new Date().toISOString());
  return session?.accountId ?? null;
}

const ROLE_RANK: Record<OrgRole, number> = { viewer: 1, admin: 2, owner: 3 };

type OrgRoleCheck = { ok: true; accountId: number } | { ok: false; code: 401 | 403; error: string };

/** Resolves the session, then checks its role for this specific org is at least
 *  `minRole`. Returns a discriminated result rather than mutating `reply` and having
 *  callers re-read its status code back out — every call site sets its own reply.code
 *  from `result.code` and returns `{ error: result.error }` directly. Mirrors
 *  verifyRequesterRole's shape below (the analogous check for a *person's* claimed
 *  org-chart role on /api/agent/ask). */
async function requireOrgRole(
  req: { cookies: Record<string, string | undefined> },
  orgId: number,
  minRole: OrgRole,
  deniedMessage: string,
): Promise<OrgRoleCheck> {
  const accountId = await currentAccountId(req);
  if (accountId == null) return { ok: false, code: 401, error: 'log in first' };
  const role = await repo.getOrgRole(orgId, accountId);
  if (role == null || ROLE_RANK[role] < ROLE_RANK[minRole]) return { ok: false, code: 403, error: deniedMessage };
  return { ok: true, accountId };
}

// Fixed, never-logged-into hash — burned in a scrypt comparison below whenever an email
// doesn't resolve to a real account, so a nonexistent email takes the same real scrypt
// time as a wrong password on a real one. Without this, verifyPassword was only ever
// called on the "account exists" branch, so response time alone told an attacker which
// emails have real accounts — same class of bug as a different error message would be,
// just via a timing channel instead of response content.
const DUMMY_PASSWORD_HASH = hashPassword(randomUUID());

app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req, reply) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email?.trim() || !password) {
    reply.code(400);
    return { error: 'email and password are required' };
  }
  const account = await repo.getAccountByEmail(email.trim().toLowerCase());
  const ok = verifyPassword(password, account?.passwordHash ?? DUMMY_PASSWORD_HASH);
  if (!account?.passwordHash || !ok) {
    reply.code(401);
    return { error: 'invalid email or password' };
  }
  await setSessionCookie(reply, account.id);
  return { account: { id: account.id, name: account.name, email: account.email } };
});

/** Self-serve org creation — the "team can set up their own org" path, no existing admin
 *  required. Rejects emails that already have a real (password-holding) account rather
 *  than doing something ambiguous with them; someone re-using an email should log in
 *  instead, possibly to then get invited into a *second* org for real multi-org
 *  membership. See repo.ts's signUpWithNewOrganization for the atomic account+org+
 *  person+owner sequence this wraps. */
app.post('/api/auth/signup', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req, reply) => {
  const { name, email, password, organizationName } = req.body as {
    name?: string; email?: string; password?: string; organizationName?: string;
  };
  if (!name?.trim() || !email?.trim() || !password || !organizationName?.trim()) {
    reply.code(400);
    return { error: 'name, email, password, and an organization name are required' };
  }
  if (password.length < 8) {
    reply.code(400);
    return { error: 'password must be at least 8 characters' };
  }
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await repo.getAccountByEmail(normalizedEmail);
  if (existing?.passwordHash) {
    reply.code(409);
    return { error: 'an account already exists for this email — log in instead' };
  }
  const { account, organization, person } = await repo.signUpWithNewOrganization({
    name: name.trim(),
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    orgName: organizationName.trim(),
  });
  await repo.insertInitialRevision(organization.id, structuredClone(DEFAULT_GRID));
  await setSessionCookie(reply, account.id);
  return { account, organization, person };
});

app.post('/api/auth/logout', async (req, reply) => {
  const token = req.cookies[SESSION_COOKIE];
  if (token) await repo.revokeSession(hashSessionToken(token), new Date().toISOString());
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

app.get('/api/auth/me', async (req) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) return { account: null, orgRoles: {}, people: [] };
  const [account, orgRoles, people] = await Promise.all([
    repo.getAccount(accountId),
    repo.getOrgRolesForAccount(accountId),
    repo.getPeopleForAccount(accountId),
  ]);
  return { account, orgRoles, people };
});

app.post('/api/auth/change-password', async (req, reply) => {
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
  await repo.setAccountPassword(accountId, hashPassword(newPassword));
  return { ok: true };
});

/* ---------- platform: organizations ---------- */

app.get('/api/organizations', async (req) => {
  const accountId = await currentAccountId(req);
  return { organizations: accountId == null ? [] : await repo.listOrganizationsForAccount(accountId) };
});

/** Every org, unfiltered — feeds "My agent"'s identity switcher (MeContext.tsx), which is
 *  intentionally open regardless of login (CLAUDE.md rule 7). Deliberately separate
 *  from the admin-scoped listing above rather than reusing it with a flag — the two have
 *  different authorization stories and shouldn't share a code path that could later grow
 *  a bug where one accidentally inherits the other's filtering (or lack of it). */
app.get('/api/org-directory', async () => ({ organizations: await repo.listAllOrganizations() }));

app.post('/api/organizations', async (req, reply) => {
  const accountId = await currentAccountId(req);
  if (accountId == null) {
    reply.code(401);
    return { error: 'log in first' };
  }
  const { name } = req.body as { name: string };
  if (!name?.trim()) {
    reply.code(400);
    return { error: 'name is required' };
  }
  const org = await repo.createOrganization(accountId, name.trim());
  // Every organization needs a policy revision to exist before anyone can be asked about —
  // seed it with the platform default grid, exactly like the very first org was seeded.
  await repo.insertInitialRevision(org.id, structuredClone(DEFAULT_GRID));
  return { organization: org };
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

app.post('/api/organizations/:orgId/admins', async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const check = await requireOrgRole(req, orgId, 'owner', 'only an owner can invite admins');
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }

  const { email, name, role } = req.body as { email?: string; name?: string; role?: OrgRole };
  if (!email?.trim() || !role || !['owner', 'admin', 'viewer'].includes(role)) {
    reply.code(400);
    return { error: 'email and a valid role (owner/admin/viewer) are required' };
  }
  const normalizedEmail = email.trim().toLowerCase();
  let target = await repo.getAccountByEmail(normalizedEmail);
  let tempPassword: string | null = null;
  let emailSent = false;
  if (!target) {
    tempPassword = generateTempPassword();
    const created = await repo.insertAccount(name?.trim() || normalizedEmail, normalizedEmail, hashPassword(tempPassword));
    target = { ...created, passwordHash: null };
  }
  await repo.addOrgAdmin(orgId, target.id, role, new Date().toISOString());
  if (tempPassword) {
    const [inviter, org] = await Promise.all([repo.getAccount(check.accountId), repo.getOrganization(orgId)]);
    emailSent = await sendInviteEmail({
      to: target.email,
      recipientName: target.name,
      invitedByName: inviter?.name ?? 'A teammate',
      orgName: org.name,
      roleDescription: `an admin (${role}) for ${org.name}`,
      tempPassword,
      loginUrl: FRONTEND_URL,
    });
  }
  return { admin: { accountId: target.id, name: target.name, email: target.email, role }, tempPassword, emailSent };
});

app.patch('/api/organizations/:orgId/admins/:adminId', async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const targetAdminId = Number((req.params as { adminId: string }).adminId);
  const check = await requireOrgRole(req, orgId, 'owner', 'only an owner can change roles');
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
  const check = await requireOrgRole(req, orgId, 'owner', 'only an owner can remove admins');
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

/* ---------- org chart: people ---------- */

/** An optional `email` links this org-chart entry to a real login — resolve-or-create,
 *  same "temp password shown once" pattern as inviting an org admin above. Leaving email
 *  blank keeps today's behavior exactly: a structural chart entry with no login, reachable
 *  only through "My agent"'s free identity switcher. Giving an email that's already a
 *  registered account (say, someone already a person in a different org) is how the same
 *  human ends up with a second, independent org-chart identity — real multi-org
 *  membership, not a duplicate. */
app.post('/api/organizations/:orgId/people', async (req, reply) => {
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

  let accountId: number | null = null;
  let tempPassword: string | null = null;
  const email = body.email?.trim().toLowerCase();
  if (email) {
    const existing = await repo.getAccountByEmail(email);
    if (existing) {
      accountId = existing.id;
    } else {
      tempPassword = generateTempPassword();
      const created = await repo.insertAccount(body.name.trim(), email, hashPassword(tempPassword));
      accountId = created.id;
    }
  }

  const person = await repo.createPerson(orgId, {
    name: body.name.trim(),
    title: body.title.trim(),
    team: body.team.trim(),
    managerId: body.managerId ?? null,
    agentDeployed: body.agentDeployed,
    accountId,
  });

  let emailSent = false;
  if (tempPassword && email) {
    const [inviter, org] = await Promise.all([repo.getAccount(check.accountId), repo.getOrganization(orgId)]);
    emailSent = await sendInviteEmail({
      to: email,
      recipientName: body.name.trim(),
      invitedByName: inviter?.name ?? 'A teammate',
      orgName: org.name,
      roleDescription: `${body.title.trim()} in ${org.name}'s org chart`,
      tempPassword,
      loginUrl: FRONTEND_URL,
    });
  }
  return { person, tempPassword, emailSent };
});

app.delete('/api/organizations/:orgId/people/:personId', async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const check = await requireOrgRole(req, orgId, 'admin', 'not authorized to edit this organization');
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

app.get('/api/org', async (req) => {
  const orgId = orgIdFromQuery(req);
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

app.get('/api/overview', async (req) => {
  const orgId = orgIdFromQuery(req);
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

/** Resolves who's *really* asking for a self-view endpoint like this one: prefers the
 *  logged-in session's own linked identity in `id`'s org over whatever `requesterId` the
 *  query string claims (exact same pattern /api/agent/ask uses), then requires the result
 *  to actually equal `id` — this is a self-view, never a way to read anyone else's raw
 *  claims. Returns false (never throws) so callers can turn that into a clean 403; no
 *  session and no matching requesterId both fail closed, not open. */
async function verifySelfAccess(req: { query: unknown; cookies: Record<string, string | undefined> }, id: number): Promise<boolean> {
  const { requesterId } = req.query as { requesterId?: string };
  let effectiveRequesterId = requesterId != null ? Number(requesterId) : undefined;
  const sessionAccountId = await currentAccountId(req);
  if (sessionAccountId != null) {
    const orgId = await repo.getOrgIdOfPerson(id);
    const sessionPeople = await repo.getPeopleForAccount(sessionAccountId);
    const sessionPerson = sessionPeople.find((p) => p.orgId === orgId);
    if (sessionPerson) effectiveRequesterId = sessionPerson.id;
  }
  return effectiveRequesterId === id;
}

/** Raw claims, not a policy-filtered synthesis — this is "what it knows", a self-view
 *  showing someone their own real claim objects (ids included, needed for correction),
 *  never a cross-person read. Used to return that to anyone who could name any id at all;
 *  now requires the caller to actually be that person (see verifySelfAccess) — found and
 *  closed during a security audit, since a raw, unauthenticated dump of even Sensitive-tier
 *  claims is exactly what the deterministic policy engine exists to prevent. */
app.get('/api/person/:id', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  if (!(await verifySelfAccess(req, id))) {
    reply.code(403);
    return { error: 'you may only view your own record here' };
  }
  const person = await repo.getPerson(id);
  const [surfaces, claims] = await Promise.all([
    repo.getSurfaces(),
    repo.getClaims(await repo.getOrgIdOfPerson(id), id),
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
  if (!(await verifySelfAccess(req, id))) {
    reply.code(403);
    return { error: 'you may only export your own record here' };
  }
  const orgId = await repo.getOrgIdOfPerson(id);
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

app.post('/api/claim/:id/correct', async (req, reply) => {
  const id = (req.params as { id: string }).id;
  const { note } = req.body as { note?: string };
  if (!note?.trim()) {
    reply.code(400);
    return { error: 'note is required — what is actually true, and where can it be verified?' };
  }
  const claim = await repo.correctClaim(id, note.trim());
  if (!claim) return { error: 'not found' };
  return { claim };
});

/* ---------- escalations ---------- */

app.get('/api/escalations', async (req) => ({ escalations: await repo.getEscalations(orgIdFromQuery(req)) }));

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
  const { actorPersonId } = req.body as { actorPersonId?: number };
  if (!actorPersonId) {
    reply.code(400);
    return { error: 'actorPersonId is required' };
  }
  const escalation = await repo.getEscalationById(id);
  if (!escalation) {
    reply.code(404);
    return { error: 'not found' };
  }
  const orgId = await repo.getOrgIdOfPerson(escalation.personId);
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
  const { actorPersonId } = req.body as { actorPersonId?: number };
  if (!actorPersonId) {
    reply.code(400);
    return { error: 'actorPersonId is required' };
  }
  const escalation = await repo.getEscalationById(id);
  if (!escalation) {
    reply.code(404);
    return { error: 'not found' };
  }
  const orgId = await repo.getOrgIdOfPerson(escalation.personId);
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

app.get('/api/connections', async (req) => {
  const orgId = orgIdFromQuery(req);
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

app.post('/api/person/:id/surface/cycle', async (req) => {
  const id = Number((req.params as { id: string }).id);
  const { surfaceKey } = req.body as { surfaceKey: SurfaceKey };
  const before = await repo.getPerson(id);
  const person = await repo.updatePersonSurface(id, surfaceKey, nextSurfaceState(before.surfaces[surfaceKey]));
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

app.get('/api/person/:id/runtimes', async (req) => {
  const id = Number((req.params as { id: string }).id);
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

/** Read the org's one main/aggregator agent — no auth gate, same as the sub-agent GET
 *  above, since "My agent"'s free identity switcher (MeContext.tsx, CLAUDE.md rule 7)
 *  needs to show this even when nobody's logged in. Setting it is a separate,
 *  admin-gated endpoint just below. */
app.get('/api/organizations/:orgId/main-agent', async (req) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const [catalog, registered] = await Promise.all([repo.getRuntimeCatalog(), repo.getOrgMainAgent(orgId)]);
  return { catalog, registered };
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
 *  AgentRuntime doc comment. */
app.post('/api/organizations/:orgId/main-agent', async (req, reply) => {
  const orgId = Number((req.params as { orgId: string }).orgId);
  const check = await requireOrgRole(req, orgId, 'admin', 'not authorized to set this organization\'s main agent');
  if (!check.ok) {
    reply.code(check.code);
    return { error: check.error };
  }
  const { runtimeKey, scope: requestedScope } = req.body as { runtimeKey: string; scope?: RuntimeScope };
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
  const scope: RuntimeScope = checked.entry.approved ? (requestedScope ?? 'full') : 'pending';
  const addedAt = new Date().toISOString().slice(0, 10);
  await repo.setOrgMainAgent(orgId, runtimeKey, scope, addedAt);
  return { registered: await repo.getOrgMainAgent(orgId) };
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
app.post('/api/person/:id/runtimes', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
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

app.delete('/api/person/:id/runtimes/:key', async (req) => {
  const id = Number((req.params as { id: string }).id);
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
app.post('/api/person/:id/runtimes/claude-code/ask-live', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
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
  if (!googleConfigured()) {
    reply.code(503);
    return { error: 'Google OAuth is not configured on the backend — see backend/.env.example' };
  }
  return reply.redirect(buildAuthUrl(String(personId)));
});

app.get('/api/oauth/gmail/callback', async (req, reply) => {
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
  const frontendUrl = FRONTEND_URL;
  reply.type('text/html');

  if (error || !code || !state) {
    return `<p>Gmail connection failed: ${error ?? 'missing code'}. <a href="${frontendUrl}">Return to the app</a>.</p>`;
  }
  try {
    const tokens = await exchangeCode(code);
    await saveGmailConnection(Number(state), {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresIn: tokens.expires_in,
    });
  } catch (err) {
    return `<p>Gmail connection failed: ${err instanceof Error ? err.message : String(err)}. <a href="${frontendUrl}">Return to the app</a>.</p>`;
  }
  return `<p>Gmail connected. You can close this tab and return to the app.</p>
    <script>setTimeout(() => { location.href = ${JSON.stringify(frontendUrl)}; }, 1200);</script>`;
});

app.get('/api/person/:id/gmail/status', async (req) => {
  const id = Number((req.params as { id: string }).id);
  return getGmailStatus(id);
});

app.delete('/api/person/:id/gmail', async (req) => {
  const id = Number((req.params as { id: string }).id);
  await disconnectGmail(id);
  return { ok: true };
});

/* ---------- real integrations: GitHub, via a pasted personal access token ----------
   No OAuth app to register (unlike Gmail) — a person generates their own token at
   github.com/settings/tokens and pastes it in. The raw token is stored (person_oauth_
   tokens, fully owned by the person, same as the Gmail row) so this backend can poll on
   their behalf; it is never echoed back to the frontend after saving. */

app.post('/api/person/:id/github', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
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

app.get('/api/person/:id/github/status', async (req) => {
  const id = Number((req.params as { id: string }).id);
  return getGithubStatus(id);
});

app.delete('/api/person/:id/github', async (req) => {
  const id = Number((req.params as { id: string }).id);
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

app.post('/api/person/:id/jira', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
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

app.get('/api/person/:id/jira/status', async (req) => {
  const id = Number((req.params as { id: string }).id);
  return getJiraStatus(id);
});

app.delete('/api/person/:id/jira', async (req) => {
  const id = Number((req.params as { id: string }).id);
  await disconnectJira(id);
  const before = await repo.getPerson(id);
  if (before.surfaces.jira === 'connected') {
    await repo.updatePersonSurface(id, 'jira', 'absent');
  }
  return { ok: true };
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

app.post('/api/person/:id/ingest-tokens', async (req, reply) => {
  const id = Number((req.params as { id: string }).id);
  const { label } = req.body as { label?: string };
  if (!label?.trim()) {
    reply.code(400);
    return { error: 'label is required' };
  }
  const created = await generateToken(id, label.trim());
  // The raw token is returned exactly once — only its hash is ever stored.
  return { id: created.id, token: created.token };
});

app.get('/api/person/:id/ingest-tokens', async (req) => {
  const id = Number((req.params as { id: string }).id);
  return { tokens: await listTokens(id) };
});

app.delete('/api/person/:id/ingest-tokens/:tokenId', async (req) => {
  const id = Number((req.params as { id: string }).id);
  const tokenId = (req.params as { tokenId: string }).tokenId;
  await revokeToken(id, tokenId);
  return { tokens: await listTokens(id) };
});

/** The receiving end. Auth is Bearer-token only — the :source path segment says which tool
 *  is talking, the token says who it's talking for. Unrecognized tool-call shapes (most
 *  hook firings — anything outside NARRATIVE_TOOLS) are accepted and silently dropped, not
 *  errored, since a hook fires on every single tool call. */
app.post('/api/ingest/:source', async (req, reply) => {
  const source = (req.params as { source: string }).source;
  if (!INGEST_SOURCES.includes(source)) {
    reply.code(404);
    return { error: `unknown source — must be one of: ${INGEST_SOURCES.join(', ')}` };
  }
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
  if (!token) {
    reply.code(401);
    return { error: 'missing bearer token' };
  }
  const resolved = await resolveToken(token);
  if (!resolved) {
    reply.code(401);
    return { error: 'invalid or revoked token' };
  }

  const normalized = normalizeIngestPayload(req.body);
  if (!normalized) {
    reply.code(202);
    return { recorded: false };
  }
  await recordEvent(resolved.personId, source, normalized);

  // The first real pushed event IS the self-service act of connecting the surface — same
  // principle as GitHub's PAT-save flipping its surface, just triggered by real activity
  // arriving instead of a credential being validated (a token alone doesn't prove
  // anything is actually being pushed yet; a landed event does).
  const person = await repo.getPerson(resolved.personId);
  if (person.surfaces[source as SurfaceKey] !== 'connected') {
    await repo.updatePersonSurface(resolved.personId, source as SurfaceKey, 'connected');
  }

  reply.code(202);
  return { recorded: true };
});

/* ---------- policy ---------- */

app.get('/api/policy', async (req) => {
  const orgId = orgIdFromQuery(req);
  const [revision, history] = await Promise.all([repo.getCurrentRevision(orgId), repo.listRevisions(orgId)]);
  return { revision, history: history.map((r) => ({ id: r.id, createdAt: r.createdAt, note: r.note })) };
});

/** Editing writes a NEW revision. Nothing updates in place. The single most sensitive
 *  mutating action in the app — it changes what's disclosed org-wide — so it requires
 *  'admin'+, same bar as adding/removing people. */
app.post('/api/policy/cycle', async (req, reply) => {
  const orgId = orgIdFromQuery(req);
  const check = await requireOrgRole(req, orgId, 'admin', 'not authorized to edit this organization\'s policy');
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

app.post('/api/query', async (req, reply) => {
  const body = req.body as {
    targetId: number;
    role: RequesterRole;
    question?: string;
    requesterId?: number;
    persist?: boolean;
  };
  const orgId = await repo.getOrgIdOfPerson(body.targetId);

  if (body.persist) {
    const ok = await verifyRequesterRole(orgId, body.requesterId ?? 0, body.targetId, body.role);
    if (!ok) {
      reply.code(403);
      return { error: `you may not ask as "${body.role}" about this person — that relationship doesn't hold in the org chart` };
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
      requesterId: body.requesterId ?? 0,
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
      await runEscalationChecks({ orgId, requesterId: body.requesterId ?? 0, target, people, surfaces, claims, now: new Date(now) });
    } catch (err) {
      app.log.error({ err }, 'escalation checks failed — continuing');
    }
  }

  return { response: snapshot, evidence: await repo.getEvidence(orgId) };
});

/**
 * The manager-asks-employee scenario from docs/agent-to-agent-communication.md, made
 * real: an arbitrary free-text question, answered by gathering the target's real
 * connected resources, running the SAME unmodified deterministic policy engine used
 * everywhere else, and only then handing the *already-authorized* subset to an LLM to
 * write up as a direct answer. See orchestrator.ts's allowedTextOnly — WONT/CANT text
 * never reaches the model, only a count of how much was withheld.
 */
app.post('/api/agent/ask', async (req, reply) => {
  const body = req.body as {
    targetId: number;
    role: RequesterRole;
    question?: string;
    requesterId?: number;
    window?: 'today' | 'week';
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

  const orgId = await repo.getOrgIdOfPerson(body.targetId);

  // Session-trust hardening (CLAUDE.md rule 7): prefer the logged-in account's own
  // person-identity in this org over whatever requesterId the request body claims,
  // whenever a session exists and is actually linked to a person here. This is the piece
  // real login didn't close by existing — verifyRequesterRole below has always checked
  // whether a claimed role is *truthful for the org chart*, but nothing previously checked
  // whether the browser making the request is really logged in as that requester. Falls
  // back to the client-asserted id when there's no session, or the account has no linked
  // identity in this org — most of the seeded roster has no linked account and never will
  // in a demo context, so their behavior is unchanged.
  const sessionAccountId = await currentAccountId(req);
  let requesterId = body.requesterId;
  if (sessionAccountId != null) {
    const sessionPeople = await repo.getPeopleForAccount(sessionAccountId);
    const sessionPerson = sessionPeople.find((p) => p.orgId === orgId);
    if (sessionPerson) requesterId = sessionPerson.id;
  }

  if (body.persist) {
    const ok = await verifyRequesterRole(orgId, requesterId ?? 0, body.targetId, body.role);
    if (!ok) {
      reply.code(403);
      return { error: `you may not ask as "${body.role}" about this person — that relationship doesn't hold in the org chart` };
    }
  }

  const since = new Date();
  if (body.window === 'week') since.setUTCDate(since.getUTCDate() - 7);
  else since.setUTCHours(0, 0, 0, 0);

  // Which surface keys the router actually decided to call for this question — becomes
  // part of `consultedSources` below, real proof of the routing rather than a fire-and-
  // forget side effect.
  let usedSurfaceKeys: string[] = [];
  try {
    usedSurfaceKeys = await gatherAll(orgId, body.targetId, since, question);
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
          const digest = formatGmailDigest(await getEmailsSince(gmailToken, since));
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

app.get('/api/audit/subject/:id', async (req) => {
  const id = Number((req.params as { id: string }).id);
  return { entries: await repo.auditForSubject(id) };
});

/** Chats for one (requester, target) pair — My agent → Ask yourself (requesterId ===
 *  targetId) or a real cross-person Ask thread — derived from that pair's own real audit
 *  rows (listConversationsForPair groups them; nothing new is stored). */
app.get('/api/agent/conversations', async (req) => {
  const { requesterId, targetId } = req.query as { requesterId?: string; targetId?: string };
  return { conversations: await repo.listConversationsForPair(Number(requesterId), Number(targetId)) };
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

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: '0.0.0.0' });
console.log(`agent-org-mesh api → http://localhost:${port}`);
