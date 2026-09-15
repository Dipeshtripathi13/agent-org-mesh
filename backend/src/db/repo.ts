import { randomBytes, randomUUID } from 'node:crypto';
import { hashEntry, verifyChain } from '../domain/audit.js';
import { computeEscalationAge } from '../domain/escalations.js';
import { decryptCredential, encryptCredential } from '../domain/credentials.js';
import type {
  AccountMainAgent,
  AgentRuntime,
  AuditEntry,
  Claim,
  Escalation,
  EscalationDraft,
  Evidence,
  OrgMainAgent,
  Person,
  PersonRuntime,
  PolicyRevision,
  RequesterRole,
  RuntimeScope,
  Surface,
  SurfaceKey,
  SurfaceState,
} from '../domain/types.js';
import { pool } from './pool.js';

/* ---------- platform types (not part of the domain core — tenancy, not correctness) ---------- */

/** The one real login identity in this app — a human, not a role. The same account can
 *  hold an org_admins row (platform governance) and/or be linked from one or more
 *  `people` rows (an org-chart identity, one per org) at the same time. */
export interface Account {
  id: number;
  name: string;
  email: string;
  /** True while this account's password is a system-generated temp one it never chose —
   *  see the column's own comment in 0001_baseline.sql. The app forces a change before anything
   *  else is usable and clears it on success. */
  mustChangePassword: boolean;
  /** Ownership of `email` has been proven — today only by accepting an invitation that was
   *  actually delivered there. Recorded, not yet required (0001_baseline.sql). */
  emailVerified: boolean;
  /** A self-serve signup that hasn't verified yet — the API refuses everything but the
   *  verification and account routes until it does (server.ts's verification gate). */
  emailVerificationPending: boolean;
}

export type OrgRole = 'owner' | 'admin' | 'viewer';

export interface OrgAdmin {
  accountId: number;
  name: string;
  email: string;
  role: OrgRole;
  addedAt: string;
}

// No real billing integration exists yet (see CLAUDE.md's "Where to go next") — an org's
// plan is a plain column, starting everyone on 'starter' at signup. Until Stripe lands,
// moving an org to 'business'/'enterprise' is a manual operational step (an admin runs
// an UPDATE after collecting payment outside the app), not something any endpoint here
// does automatically. PLAN_LIMITS is what actually gets enforced regardless of how the
// column got set.
export type OrgPlan = 'starter' | 'business' | 'enterprise';
export const PLAN_LIMITS: Record<OrgPlan, number> = { starter: 10, business: 200, enterprise: Infinity };

export interface Organization {
  id: number;
  slug: string;
  name: string;
  createdAt: string;
  plan: OrgPlan;
  peopleCount: number;
}

/* ---------- row → domain mappers ---------- */

const iso = (d: Date) => d.toISOString();
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function toPerson(row: any): Person {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    team: row.team,
    managerId: row.manager_id,
    agentDeployed: row.agent_deployed,
    surfaces: row.surfaces,
    accountId: row.account_id,
  };
}

function toSurface(row: any): Surface {
  return {
    key: row.key,
    name: row.name,
    feedsTier: row.feeds_tier,
    reads: row.reads,
    doesNotRead: row.does_not_read,
  };
}

function toEvidence(row: any): Evidence {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    connector: row.connector,
    recordedAt: iso(row.recorded_at),
    excerpt: row.excerpt,
    note: row.note,
    externalRef: row.external_ref,
  };
}

function toClaim(row: any): Claim {
  return {
    id: row.id,
    personId: row.person_id,
    tier: row.tier,
    dataClass: row.data_class,
    text: row.text,
    evidenceId: row.evidence_id,
    sourceSurface: row.source_surface,
    derivedAt: iso(row.derived_at),
    supersededBy: row.superseded_by,
  };
}

function toEscalation(row: any, now: Date = new Date()): Escalation {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    personId: row.person_id,
    evidenceId: row.evidence_id,
    rule: row.rule,
    ageDays: computeEscalationAge(iso(row.created_at), now),
    status: row.status,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at ? iso(row.acknowledged_at) : null,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
    path: row.path,
  };
}

function toRevision(row: any): PolicyRevision {
  return {
    id: row.id,
    orgId: String(row.org_id),
    grid: row.grid,
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
    note: row.note,
  };
}

function toAuditEntry(row: any): AuditEntry {
  return {
    id: row.id,
    orgId: String(row.org_id),
    requesterId: row.requester_id,
    requesterRole: row.requester_role,
    targetPersonId: row.target_person_id,
    question: row.question,
    snapshot: row.snapshot,
    policyRevisionId: row.policy_revision_id,
    subjectNotifiedAt: iso(row.subject_notified_at),
    createdAt: iso(row.created_at),
    prevHash: row.prev_hash,
    rowHash: row.row_hash,
    conversationId: row.conversation_id,
  };
}

function toRuntime(row: any): AgentRuntime {
  return {
    key: row.key,
    name: row.name,
    vendor: row.vendor,
    contextWindow: row.context_window,
    host: row.host,
    approved: row.approved,
    blocked: row.blocked,
    reads: row.reads,
    note: row.note,
    apiFamily: row.api_family,
    mainEligible: row.main_eligible,
  };
}

function toPersonRuntime(row: any): PersonRuntime {
  return { runtimeKey: row.runtime_key, scope: row.scope, addedAt: isoDate(row.added_at) };
}

function toOrgMainAgent(row: any): OrgMainAgent {
  return {
    runtimeKey: row.runtime_key,
    scope: row.scope,
    addedAt: isoDate(row.added_at),
    apiKeyEncrypted: row.api_key_encrypted ?? null,
    baseUrl: row.base_url ?? null,
    model: row.model ?? null,
  };
}

function toOrganization(row: any): Organization {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: iso(row.created_at),
    plan: row.plan as OrgPlan,
    peopleCount: Number(row.people_count ?? 0),
  };
}

function toOrgAdmin(row: any): OrgAdmin {
  return { accountId: row.account_id, name: row.name, email: row.email, role: row.role, addedAt: iso(row.added_at) };
}

/* ---------- platform: accounts, organizations, and org_admins (real multi-admin RBAC) ----------
   An org can have several admins (org_admins: owner/admin/viewer), and one account can
   belong to several orgs — createOrganization makes its creator that org's 'owner';
   everything else about who can see/do what for a given org is resolved through
   org_admins, not a single ownership column. The same account can also be linked from
   one or more `people` rows (getPeopleForAccount, near createPerson above) — "admin" and
   "org-chart identity" are independent facts about one account, not different account
   types. */

function toAccount(row: any): Account {
  return {
    id: row.id, name: row.name, email: row.email,
    mustChangePassword: row.must_change_password, emailVerified: row.email_verified_at != null,
    emailVerificationPending: row.email_verification_required === true && row.email_verified_at == null,
  };
}

export async function getAccount(id: number): Promise<Account | null> {
  const { rows } = await pool.query(
    'SELECT id, name, email, must_change_password, email_verified_at, email_verification_required FROM accounts WHERE id = $1',
    [id],
  );
  return rows.length ? toAccount(rows[0]) : null;
}

export async function getAccountByEmail(email: string): Promise<(Account & { passwordHash: string | null }) | null> {
  const { rows } = await pool.query(
    'SELECT id, name, email, password_hash, must_change_password, email_verified_at, email_verification_required FROM accounts WHERE email = $1',
    [email],
  );
  if (rows.length === 0) return null;
  return { ...toAccount(rows[0]), passwordHash: rows[0].password_hash };
}

/** Creates the account row itself — putting it to work as an org admin (addOrgAdmin) or
 *  linking it to an org-chart entry (createPerson's accountId) are separate steps, since
 *  the same account might end up doing either or both, in more than one org.
 *  `mustChangePassword` is true for every invite/reset-issued temp password and false for
 *  a self-serve signup, whose password its owner actually chose. */
export async function insertAccount(
  name: string,
  email: string,
  passwordHash: string | null,
  mustChangePassword = false,
  emailVerificationRequired = false,
): Promise<Account> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (name, email, password_hash, must_change_password, email_verification_required) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, name, email, must_change_password, email_verified_at, email_verification_required`,
    [name, email, passwordHash, mustChangePassword, emailVerificationRequired],
  );
  return toAccount(rows[0]);
}

/** Clears `must_change_password` alongside the new hash — this is the one path that ends
 *  a forced-change state, and it can only be reached by someone who proved the current
 *  password (change-password) so there's no way to clear the flag without actually
 *  choosing a password. `mustChange` is set true only by an admin-initiated reset, which
 *  hands out another temp password. */
export async function setAccountPassword(
  accountId: number,
  passwordHash: string,
  mustChange = false,
): Promise<void> {
  await pool.query('UPDATE accounts SET password_hash = $2, must_change_password = $3 WHERE id = $1', [
    accountId,
    passwordHash,
    mustChange,
  ]);
}

/** Does this account belong to any organization other than `orgId` — as a chart person, an
 *  admin, or both?
 *
 *  This gates admin-initiated password resets, and it exists because an `accounts` row is
 *  a *global* login, not a tenant-owned identity: the same human can be an employee here
 *  and an owner somewhere else (that's the whole point of people.account_id not being
 *  unique). A managed-tenant product like Google Workspace can let an admin reset any of
 *  its users because those identities belong to the tenant; here, letting an admin of org
 *  A mint a new password for an account that also owns org B would hand them a login to
 *  org B — a real cross-tenant takeover, not a theoretical one. So a reset is only offered
 *  for accounts whose entire footprint is this one org; anyone else has to go through a
 *  self-service reset instead. */
export async function accountBelongsToOtherOrgs(accountId: number, orgId: number): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM people     WHERE account_id = $1 AND org_id <> $2
       UNION ALL
       SELECT 1 FROM org_admins WHERE account_id = $1 AND org_id <> $2
     ) AS present`,
    [accountId, orgId],
  );
  return rows[0].present === true;
}

export async function listOrganizationsForAccount(accountId: number): Promise<Organization[]> {
  const { rows } = await pool.query(
    `SELECT o.*, count(p.id)::int AS people_count
     FROM organizations o
     JOIN org_admins oa ON oa.org_id = o.id AND oa.account_id = $1
     LEFT JOIN people p ON p.org_id = o.id
     GROUP BY o.id
     ORDER BY o.id`,
    [accountId],
  );
  return rows.map(toOrganization);
}

export async function getOrganization(id: number): Promise<Organization> {
  const { rows } = await pool.query(
    `SELECT o.*, count(p.id)::int AS people_count
     FROM organizations o
     LEFT JOIN people p ON p.org_id = o.id
     WHERE o.id = $1
     GROUP BY o.id`,
    [id],
  );
  if (rows.length === 0) throw new Error(`No organization ${id}`);
  return toOrganization(rows[0]);
}

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'org';
}

async function uniqueSlug(client: { query: (...a: any[]) => Promise<any> }, name: string): Promise<string> {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; ; n++) {
    const { rows } = await client.query('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    slug = `${base}-${n}`;
  }
}

/** The creating account becomes this org's sole 'owner' *and* its first person (top of
 *  the chart, no manager) — atomically, so an org can never briefly exist with no admin
 *  able to manage it, and the founder can see their own agent immediately rather than
 *  landing in an org with zero people. Accounts and organizations are otherwise fully
 *  decoupled (see server.ts's `POST /api/auth/signup`, which no longer bundles an org at
 *  all): signing up only ever creates an account, and this — reached through its own
 *  step-up-gated Admin action — is the one, deliberate place an organization gets
 *  created, whether that's a brand-new individual's very first org or an existing admin
 *  adding another one. */
export async function createOrganization(
  creatorAccountId: number,
  creatorName: string,
  name: string,
): Promise<{ organization: Organization; person: Person }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const slug = await uniqueSlug(client, name);
    const now = new Date().toISOString();
    const { rows: orgRows } = await client.query(
      `INSERT INTO organizations (slug, name, created_at) VALUES ($1,$2,$3) RETURNING *`,
      [slug, name, now],
    );
    const orgId = orgRows[0].id;
    await client.query(
      `INSERT INTO org_admins (org_id, account_id, role, added_at) VALUES ($1,$2,'owner',$3)`,
      [orgId, creatorAccountId, now],
    );
    const { rows: personRows } = await client.query(
      `INSERT INTO people (org_id, name, title, team, manager_id, agent_deployed, surfaces, account_id)
       VALUES ($1,$2,'Owner','Leadership',NULL,true,$3,$4) RETURNING *`,
      [orgId, creatorName, JSON.stringify(EMPTY_SURFACES), creatorAccountId],
    );
    await client.query('COMMIT');
    return {
      organization: toOrganization({ ...orgRows[0], people_count: 1 }),
      person: toPerson(personRows[0]),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getOrgRole(orgId: number, accountId: number): Promise<OrgRole | null> {
  const { rows } = await pool.query('SELECT role FROM org_admins WHERE org_id = $1 AND account_id = $2', [orgId, accountId]);
  return rows.length ? rows[0].role : null;
}

/** Every org an account administers, and their role in each — what the frontend uses to
 *  decide which actions to even show as available, per org. */
export async function getOrgRolesForAccount(accountId: number): Promise<Record<number, OrgRole>> {
  const { rows } = await pool.query('SELECT org_id, role FROM org_admins WHERE account_id = $1', [accountId]);
  const out: Record<number, OrgRole> = {};
  for (const row of rows) out[row.org_id] = row.role;
  return out;
}

export async function listOrgAdmins(orgId: number): Promise<OrgAdmin[]> {
  const { rows } = await pool.query(
    `SELECT ac.id AS account_id, ac.name, ac.email, oa.role, oa.added_at
     FROM org_admins oa JOIN accounts ac ON ac.id = oa.account_id
     WHERE oa.org_id = $1
     ORDER BY oa.added_at`,
    [orgId],
  );
  return rows.map(toOrgAdmin);
}

export async function addOrgAdmin(orgId: number, accountId: number, role: OrgRole, now: string): Promise<void> {
  await pool.query(
    `INSERT INTO org_admins (org_id, account_id, role, added_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id, account_id) DO UPDATE SET role = EXCLUDED.role`,
    [orgId, accountId, role, now],
  );
}

export async function setOrgAdminRole(orgId: number, accountId: number, role: OrgRole): Promise<void> {
  await pool.query('UPDATE org_admins SET role = $3 WHERE org_id = $1 AND account_id = $2', [orgId, accountId, role]);
}

export async function countOrgOwners(orgId: number): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM org_admins WHERE org_id = $1 AND role = 'owner'`, [orgId]);
  return Number(rows[0].n);
}

export async function removeOrgAdmin(orgId: number, accountId: number): Promise<void> {
  await pool.query('DELETE FROM org_admins WHERE org_id = $1 AND account_id = $2', [orgId, accountId]);
}

/* ---------- invitations (release audit SEC-08) ----------
   An email typed by an admin never binds an existing account anymore. It creates an
   invitation; the chart entry or admin role is bound only when a logged-in account whose
   email matches presents the one-time token (acceptInvitation). */

export interface Invitation {
  id: string;
  orgId: number;
  orgName: string;
  email: string;
  kind: 'person' | 'admin';
  personId: number | null;
  personName: string | null;
  personTitle: string | null;
  adminRole: OrgRole | null;
  invitedByName: string | null;
  createdAt: string;
  expiresAt: string;
  emailedAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
}

const INVITATION_SELECT = `
  SELECT i.*, o.name AS org_name, p.name AS person_name, p.title AS person_title, ac.name AS invited_by_name
  FROM invitations i
  JOIN organizations o ON o.id = i.org_id
  LEFT JOIN people p ON p.id = i.person_id
  LEFT JOIN accounts ac ON ac.id = i.invited_by`;

function toInvitation(row: any): Invitation {
  return {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    email: row.email,
    kind: row.kind,
    personId: row.person_id,
    personName: row.person_name ?? null,
    personTitle: row.person_title ?? null,
    adminRole: row.admin_role,
    invitedByName: row.invited_by_name ?? null,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    emailedAt: row.emailed_at ? iso(row.emailed_at) : null,
    acceptedAt: row.accepted_at ? iso(row.accepted_at) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
  };
}

export async function createInvitation(input: {
  orgId: number;
  email: string;
  kind: 'person' | 'admin';
  personId: number | null;
  adminRole: OrgRole | null;
  tokenHash: string;
  invitedBy: number;
  now: string;
  expiresAt: string;
}): Promise<Invitation> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO invitations (id, org_id, email, kind, person_id, admin_role, token_hash, invited_by, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, input.orgId, input.email, input.kind, input.personId, input.adminRole, input.tokenHash, input.invitedBy, input.now, input.expiresAt],
  );
  return (await getInvitationById(input.orgId, id))!;
}

export async function markInvitationEmailed(id: string, now: string): Promise<void> {
  await pool.query('UPDATE invitations SET emailed_at = $2 WHERE id = $1', [id, now]);
}

export async function getInvitationById(orgId: number, id: string): Promise<Invitation | null> {
  const { rows } = await pool.query(`${INVITATION_SELECT} WHERE i.org_id = $1 AND i.id = $2`, [orgId, id]);
  return rows.length ? toInvitation(rows[0]) : null;
}

export async function getInvitationByTokenHash(tokenHash: string): Promise<Invitation | null> {
  const { rows } = await pool.query(`${INVITATION_SELECT} WHERE i.token_hash = $1`, [tokenHash]);
  return rows.length ? toInvitation(rows[0]) : null;
}

export async function listPendingInvitations(orgId: number, now: string): Promise<Invitation[]> {
  const { rows } = await pool.query(
    `${INVITATION_SELECT}
     WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > $2
     ORDER BY i.created_at DESC`,
    [orgId, now],
  );
  return rows.map(toInvitation);
}

/** What an organization's admins see about each person in its chart: their login email (or
 *  the email a still-pending invitation went to), whether they've signed in, their admin role
 *  here, and their raw tool states. Admin-only (server.ts gates the route) — emails are
 *  personal data the org chart itself never exposed. */
export interface PersonAdminDetails {
  personId: number;
  accountEmail: string | null;
  lastSignInAt: string | null;
  adminRole: OrgRole | null;
  invitation: { email: string; sentAt: string; expiresAt: string; emailed: boolean } | null;
  surfaces: Record<string, SurfaceState>;
}

export async function listPeopleAdminDetails(orgId: number): Promise<PersonAdminDetails[]> {
  const { rows } = await pool.query(
    `SELECT p.id AS person_id, p.surfaces, a.email AS account_email, oa.role AS admin_role,
            s.last_sign_in, inv.email AS invite_email, inv.created_at AS invited_at,
            inv.expires_at AS invite_expires_at, inv.emailed_at AS invite_emailed_at
       FROM people p
       LEFT JOIN accounts a ON a.id = p.account_id
       LEFT JOIN org_admins oa ON oa.org_id = p.org_id AND oa.account_id = p.account_id
       LEFT JOIN LATERAL (SELECT max(created_at) AS last_sign_in FROM sessions WHERE account_id = p.account_id) s ON true
       LEFT JOIN LATERAL (
         SELECT email, created_at, expires_at, emailed_at FROM invitations
          WHERE person_id = p.id AND kind = 'person' AND accepted_at IS NULL AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1
       ) inv ON true
      WHERE p.org_id = $1
      ORDER BY p.id`,
    [orgId],
  );
  return rows.map((r) => ({
    personId: r.person_id,
    accountEmail: r.account_email ?? null,
    lastSignInAt: r.last_sign_in ? iso(r.last_sign_in) : null,
    adminRole: (r.admin_role as OrgRole | null) ?? null,
    invitation: r.invite_email
      ? { email: r.invite_email, sentAt: iso(r.invited_at), expiresAt: iso(r.invite_expires_at), emailed: r.invite_emailed_at != null }
      : null,
    surfaces: r.surfaces,
  }));
}

/** Only a still-pending invitation can be revoked; returns whether one was. */
export async function revokeInvitation(orgId: number, id: string, now: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE invitations SET revoked_at = $3
     WHERE org_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [orgId, id, now],
  );
  return (rowCount ?? 0) > 0;
}

export type AcceptInvitationResult =
  | { ok: true; orgId: number; kind: 'person' | 'admin' }
  | { ok: false; code: 403 | 404 | 409 | 410; error: string };

/** Binds an invitation to the logged-in account, in one transaction with the rows locked, so
 *  a token can't be used twice concurrently. The account's email must match the invitation:
 *  holding the link alone isn't enough, and neither is merely owning an account with that
 *  address. An admin role is never downgraded by accepting a lesser invitation. */
export async function acceptInvitation(tokenHash: string, accountId: number, now: string): Promise<AcceptInvitationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM invitations WHERE token_hash = $1 FOR UPDATE', [tokenHash]);
    const inv = rows[0];
    const fail = async (code: 403 | 404 | 409 | 410, error: string): Promise<AcceptInvitationResult> => {
      await client.query('ROLLBACK');
      return { ok: false, code, error };
    };
    if (!inv) return fail(404, 'this invitation link is not valid');
    if (inv.revoked_at) return fail(410, 'this invitation was revoked — ask for a new one');
    if (inv.accepted_at) return fail(410, 'this invitation has already been used');
    if (new Date(inv.expires_at).getTime() <= new Date(now).getTime()) return fail(410, 'this invitation has expired — ask for a new one');

    const { rows: accountRows } = await client.query('SELECT email, email_verified_at FROM accounts WHERE id = $1', [accountId]);
    if (!accountRows[0] || accountRows[0].email.toLowerCase() !== inv.email.toLowerCase()) {
      return fail(403, `this invitation is for ${inv.email} — sign in with that account to accept it`);
    }
    // An emailed invitation proves the inbox by itself. One that was only shared by hand
    // doesn't, so an account that merely claims this address must verify it first.
    if (!accountRows[0].email_verified_at && !inv.emailed_at) {
      return fail(403, 'verify your email address before accepting this invitation');
    }

    if (inv.kind === 'person') {
      const { rows: personRows } = await client.query(
        'SELECT account_id FROM people WHERE id = $1 AND org_id = $2 FOR UPDATE',
        [inv.person_id, inv.org_id],
      );
      if (!personRows[0]) return fail(404, 'that person is no longer in this organization');
      if (personRows[0].account_id != null) return fail(409, 'that place in the chart is already linked to a login');
      const { rowCount } = await client.query('SELECT 1 FROM people WHERE org_id = $1 AND account_id = $2', [inv.org_id, accountId]);
      if (rowCount) return fail(409, 'you already have a place in this organization’s chart');
      await client.query('UPDATE people SET account_id = $1 WHERE id = $2', [accountId, inv.person_id]);
    } else {
      await client.query(
        `INSERT INTO org_admins (org_id, account_id, role, added_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (org_id, account_id) DO UPDATE SET role = CASE
           WHEN (CASE EXCLUDED.role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END)
              > (CASE org_admins.role WHEN 'owner' THEN 3 WHEN 'admin' THEN 2 ELSE 1 END)
           THEN EXCLUDED.role ELSE org_admins.role END`,
        [inv.org_id, accountId, inv.admin_role, now],
      );
    }

    await client.query('UPDATE invitations SET accepted_at = $2, accepted_by = $3 WHERE id = $1', [inv.id, now, accountId]);
    // Only an invitation that really reached this inbox proves the address belongs to them.
    if (inv.emailed_at) {
      await client.query('UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1', [accountId, now]);
    }
    await client.query('COMMIT');
    return { ok: true, orgId: inv.org_id, kind: inv.kind };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* ---------- platform: sessions ----------
   Real server-side sessions, not JWTs — revocable by setting revoked_at (mirrors
   ingest_tokens' revoke pattern), inspectable in the DB. Only a token's SHA-256 hash is
   ever stored (domain/auth.ts's hashSessionToken); the raw token lives in an httpOnly
   cookie and nowhere else. One session type for every login, admin or employee or both. */

export async function createSession(accountId: number, tokenHash: string, now: string, expiresAt: string): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (id, account_id, token_hash, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), accountId, tokenHash, now, expiresAt],
  );
}

export async function resolveSession(
  tokenHash: string,
  now: string,
): Promise<{ accountId: number; elevatedUntil: string | null; verificationPending: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT s.account_id, s.elevated_until,
            (a.email_verification_required AND a.email_verified_at IS NULL) AS verification_pending
     FROM sessions s JOIN accounts a ON a.id = s.account_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
    [tokenHash, now],
  );
  return rows.length
    ? { accountId: rows[0].account_id, elevatedUntil: rows[0].elevated_until, verificationPending: rows[0].verification_pending === true }
    : null;
}

/* ---------- email links: verification and password reset ---------- */

export type EmailTokenPurpose = 'verify' | 'reset';

/** Only the newest link of each purpose works: issuing one retires the account's older ones. */
export async function createEmailToken(input: {
  accountId: number;
  email: string;
  purpose: EmailTokenPurpose;
  tokenHash: string;
  now: string;
  expiresAt: string;
}): Promise<void> {
  await pool.query(
    'UPDATE email_tokens SET used_at = $3 WHERE account_id = $1 AND purpose = $2 AND used_at IS NULL',
    [input.accountId, input.purpose, input.now],
  );
  await pool.query(
    `INSERT INTO email_tokens (id, account_id, purpose, email, token_hash, created_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), input.accountId, input.purpose, input.email, input.tokenHash, input.now, input.expiresAt],
  );
}

export type EmailTokenResult =
  | { ok: true; accountId: number; email: string }
  | { ok: false; code: 404 | 410; error: string };

/** Locks and spends one link inside the caller's transaction. A link sent to an address the
 *  account no longer has is dead, so changing an email can't be undone by an old link. */
async function spendEmailToken(
  client: import('pg').PoolClient,
  tokenHash: string,
  purpose: EmailTokenPurpose,
  now: string,
): Promise<EmailTokenResult> {
  const { rows } = await client.query(
    `SELECT t.id, t.account_id, t.email, t.expires_at, t.used_at, a.email AS account_email
     FROM email_tokens t JOIN accounts a ON a.id = t.account_id
     WHERE t.token_hash = $1 AND t.purpose = $2
     FOR UPDATE OF t`,
    [tokenHash, purpose],
  );
  const t = rows[0];
  if (!t) return { ok: false, code: 404, error: 'this link is not valid' };
  if (t.used_at) return { ok: false, code: 410, error: 'this link has already been used, or a newer one was sent' };
  if (new Date(t.expires_at).getTime() <= new Date(now).getTime()) {
    return { ok: false, code: 410, error: 'this link has expired — request a new one' };
  }
  if (t.account_email.toLowerCase() !== t.email.toLowerCase()) {
    return { ok: false, code: 410, error: 'this link was sent to an address this account no longer uses' };
  }
  await client.query('UPDATE email_tokens SET used_at = $2 WHERE id = $1', [t.id, now]);
  return { ok: true, accountId: t.account_id, email: t.email };
}

export async function verifyEmailWithToken(tokenHash: string, now: string): Promise<EmailTokenResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await spendEmailToken(client, tokenHash, 'verify', now);
    if (!result.ok) {
      await client.query('ROLLBACK');
      return result;
    }
    await client.query('UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1', [result.accountId, now]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** OWASP Forgot Password: one transaction sets the new password, spends the link and every
 *  other outstanding reset link, and revokes every session — so whoever held the account
 *  before (including someone who registered this email first) is signed out. Receiving the
 *  link proves the inbox, so the email counts as verified. */
export async function resetPasswordWithToken(tokenHash: string, passwordHash: string, now: string): Promise<EmailTokenResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await spendEmailToken(client, tokenHash, 'reset', now);
    if (!result.ok) {
      await client.query('ROLLBACK');
      return result;
    }
    await client.query(
      `UPDATE accounts SET password_hash = $2, must_change_password = false, email_verified_at = COALESCE(email_verified_at, $3)
       WHERE id = $1`,
      [result.accountId, passwordHash, now],
    );
    await client.query('UPDATE sessions SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL', [result.accountId, now]);
    await client.query(
      "UPDATE email_tokens SET used_at = $2 WHERE account_id = $1 AND purpose = 'reset' AND used_at IS NULL",
      [result.accountId, now],
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeSession(tokenHash: string, now: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1', [tokenHash, now]);
}

/** Every other live session for this account — OWASP's Forgot Password guidance is that a
 *  successful password change invalidates all *other* sessions, so a stolen cookie stops
 *  working the moment the real owner changes their password. The caller's own session is
 *  deliberately spared (`exceptTokenHash`) so changing your password doesn't log you out
 *  of the tab you're doing it in. */
export async function revokeOtherSessionsForAccount(
  accountId: number,
  exceptTokenHash: string,
  now: string,
): Promise<void> {
  await pool.query(
    'UPDATE sessions SET revoked_at = $3 WHERE account_id = $1 AND token_hash <> $2 AND revoked_at IS NULL',
    [accountId, exceptTokenHash, now],
  );
}

/** Every session for this account, no exception — used by an admin-initiated reset, where
 *  locking the account out of anything it was already logged into is the whole point. */
export async function revokeAllSessionsForAccount(accountId: number, now: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL', [accountId, now]);
}

// Step-up auth: stamped after the account re-enters its password via POST
// /api/auth/step-up. Short-lived on purpose — re-checked against `now` in requireOrgRole
// on every admin-scoped request, never cached client-side as a boolean.
export async function elevateSession(tokenHash: string, until: string): Promise<void> {
  await pool.query('UPDATE sessions SET elevated_until = $2 WHERE token_hash = $1', [tokenHash, until]);
}

/* ---------- org chart: people ---------- */

export async function getPeople(orgId: number): Promise<Person[]> {
  const { rows } = await pool.query('SELECT * FROM people WHERE org_id = $1 ORDER BY id', [orgId]);
  return rows.map(toPerson);
}

export async function getPerson(id: number): Promise<Person> {
  const { rows } = await pool.query('SELECT * FROM people WHERE id = $1', [id]);
  if (rows.length === 0) throw new Error(`No person ${id}`);
  return toPerson(rows[0]);
}

export async function getOrgIdOfPerson(id: number): Promise<number> {
  const { rows } = await pool.query('SELECT org_id FROM people WHERE id = $1', [id]);
  if (rows.length === 0) throw new Error(`No person ${id}`);
  return rows[0].org_id;
}

const EMPTY_SURFACES: Record<SurfaceKey, SurfaceState> = {
  github: 'absent', jira: 'absent', salesforce: 'absent',
  calendar: 'absent', slack: 'absent', confluence: 'absent',
  linear: 'absent', notion: 'absent', asana: 'absent', gitlab: 'absent', hubspot: 'absent', zendesk: 'absent',
  trello: 'absent', airtable: 'absent', monday: 'absent', figma: 'absent', discord: 'absent',
  microsoft365: 'absent', zoom: 'absent', dropbox: 'absent',
  airflow: 'absent', dbt: 'absent', snowflake: 'absent', databricks: 'absent',
  // Not connected yet, like every other tool. These used to default to 'outOfScope', which
  // means "doesn't apply to this role" — but nothing ever set it deliberately, so once pushes
  // to out-of-scope tools were refused (2026-09-14) nobody in an organization could connect
  // Claude Code or Codex at all (found 2026-09-15; migration 0005 fixes existing people).
  'claude-code': 'absent', codex: 'absent', 'gemini-cli': 'absent',
};

export async function createPerson(orgId: number, input: {
  name: string;
  title: string;
  team: string;
  managerId: number | null;
  agentDeployed: boolean;
  /** Real login for this org-chart entry, when one's being linked — the account itself
   *  is resolved-or-created by the caller (server.ts, same "temp password shown once"
   *  orchestration as inviting an org admin), not here; this just stores the FK. */
  accountId?: number | null;
}): Promise<Person> {
  const { rows } = await pool.query(
    `INSERT INTO people (org_id, name, title, team, manager_id, agent_deployed, surfaces, account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [orgId, input.name, input.title, input.team, input.managerId, input.agentDeployed, JSON.stringify(EMPTY_SURFACES), input.accountId ?? null],
  );
  return toPerson(rows[0]);
}

/** Every org-chart identity linked to one account — what "log in as yourself" resolves
 *  to. Ordered by org id only for determinism; there's no inherent "primary" org.
 *  `orgId` rides along outside the `Person` shape itself (deliberately not added to
 *  domain/types.ts's Person — that type stays pure "correctness core," with no notion of
 *  which org it's in, since policy.ts/coverage.ts never need one) because this is the
 *  one place identities from *different* orgs are returned side by side and the caller
 *  needs to tell them apart. */
export async function getPeopleForAccount(accountId: number): Promise<(Person & { orgId: number; orgName: string })[]> {
  const { rows } = await pool.query(
    `SELECT p.*, o.name AS org_name FROM people p JOIN organizations o ON o.id = p.org_id
     WHERE p.account_id = $1 ORDER BY p.org_id, p.id`,
    [accountId],
  );
  return rows.map((row) => ({ ...toPerson(row), orgId: row.org_id, orgName: row.org_name }));
}

/** Refuses to remove anyone still listed as someone else's manager — reassign first. */
export async function deletePerson(orgId: number, personId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const { rows: reports } = await pool.query('SELECT count(*)::int AS n FROM people WHERE manager_id = $1', [personId]);
  if (reports[0].n > 0) {
    return { ok: false, error: 'this person still has direct reports — reassign or remove them first' };
  }
  await pool.query('DELETE FROM people WHERE id = $1 AND org_id = $2', [personId, orgId]);
  return { ok: true };
}

export async function updatePersonSurface(id: number, key: SurfaceKey, state: SurfaceState): Promise<Person> {
  const { rows } = await pool.query(
    `UPDATE people SET surfaces = jsonb_set(surfaces, $2, to_jsonb($3::text)) WHERE id = $1 RETURNING *`,
    [id, `{${key}}`, state],
  );
  return toPerson(rows[0]);
}

export async function getSurfaces(): Promise<Surface[]> {
  const { rows } = await pool.query('SELECT * FROM surfaces_catalog ORDER BY key');
  return rows.map(toSurface);
}

export async function getNeverIngested(): Promise<string[]> {
  const { rows } = await pool.query('SELECT name FROM never_ingested ORDER BY name');
  return rows.map((r) => r.name);
}

/* ---------- evidence & claims ---------- */

export async function getEvidence(orgId: number): Promise<Record<string, Evidence>> {
  const { rows } = await pool.query('SELECT * FROM evidence WHERE org_id = $1', [orgId]);
  const out: Record<string, Evidence> = {};
  for (const row of rows) out[row.id] = toEvidence(row);
  return out;
}

export async function getClaims(orgId: number, personId?: number): Promise<Claim[]> {
  const { rows } = personId == null
    ? await pool.query('SELECT * FROM claims WHERE org_id = $1 ORDER BY id', [orgId])
    : await pool.query('SELECT * FROM claims WHERE org_id = $1 AND person_id = $2 ORDER BY id', [orgId, personId]);
  return rows.map(toClaim);
}

/** `note` is the person's own words on what's actually true — stored verbatim in
 *  `superseded_by` rather than a fixed marker string, since nothing else in the codebase
 *  reads that column's value as anything but a truthy/falsy "was this corrected" check
 *  (confirmed by grep before making this the storage, not a second column). Found and
 *  fixed together: the frontend form was asking for this note and discarding it. */
export async function getClaimById(id: string): Promise<Claim | null> {
  const { rows } = await pool.query('SELECT * FROM claims WHERE id = $1', [id]);
  return rows.length ? toClaim(rows[0]) : null;
}

export async function correctClaim(id: string, note: string): Promise<Claim | null> {
  const { rows } = await pool.query(
    `UPDATE claims SET superseded_by = $2 WHERE id = $1 RETURNING *`,
    [id, note],
  );
  return rows.length ? toClaim(rows[0]) : null;
}

/** Idempotent — same id re-ingested today just refreshes the row in place, so re-running
 *  ingestion never piles up duplicate claims for the same real-world observation. */
export async function upsertEvidence(orgId: number, evidence: Evidence): Promise<void> {
  await pool.query(
    `INSERT INTO evidence (id, org_id, kind, title, connector, recorded_at, excerpt, note, external_ref)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       kind = EXCLUDED.kind, title = EXCLUDED.title, connector = EXCLUDED.connector,
       recorded_at = EXCLUDED.recorded_at, excerpt = EXCLUDED.excerpt, note = EXCLUDED.note,
       external_ref = EXCLUDED.external_ref`,
    [evidence.id, orgId, evidence.kind, evidence.title, evidence.connector, evidence.recordedAt,
      evidence.excerpt, evidence.note, evidence.externalRef],
  );
}

export async function upsertClaim(orgId: number, claim: Claim): Promise<void> {
  await pool.query(
    `INSERT INTO claims (id, org_id, person_id, tier, data_class, text, evidence_id, source_surface, derived_at, superseded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (id) DO UPDATE SET
       tier = EXCLUDED.tier, data_class = EXCLUDED.data_class, text = EXCLUDED.text,
       evidence_id = EXCLUDED.evidence_id, source_surface = EXCLUDED.source_surface,
       derived_at = EXCLUDED.derived_at, superseded_by = EXCLUDED.superseded_by`,
    [claim.id, orgId, claim.personId, claim.tier, claim.dataClass, claim.text, claim.evidenceId,
      claim.sourceSurface, claim.derivedAt, claim.supersededBy],
  );
}

/* ---------- escalations ---------- */

export async function getEscalations(orgId: number): Promise<Escalation[]> {
  const { rows } = await pool.query('SELECT * FROM escalations WHERE org_id = $1 ORDER BY id', [orgId]);
  return rows.map((r) => toEscalation(r));
}

export async function getEscalationById(id: string): Promise<Escalation | null> {
  const { rows } = await pool.query('SELECT * FROM escalations WHERE id = $1', [id]);
  return rows.length ? toEscalation(rows[0]) : null;
}

/** Idempotent per detection rule (domain/escalations.ts's `id`s are deterministic per
 *  (rule, personId)). Re-running detection refreshes the narrative fields but deliberately
 *  never touches `status`/`acknowledged*`/`resolved*`/`created_at` — a human's triage
 *  decision must survive the condition being re-detected, see docs/escalation-triage.md §4. */
export async function upsertEscalationDraft(orgId: number, draft: EscalationDraft): Promise<void> {
  await pool.query(
    `INSERT INTO escalations (id, org_id, kind, title, detail, person_id, evidence_id, rule, path)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, detail = EXCLUDED.detail, evidence_id = EXCLUDED.evidence_id,
       path = EXCLUDED.path`,
    [draft.id, orgId, draft.kind, draft.title, draft.detail, draft.personId, draft.evidenceId,
      draft.rule, JSON.stringify(draft.path)],
  );
}

export async function acknowledgeEscalation(id: string, actorPersonId: number, now: string): Promise<Escalation | null> {
  const { rows } = await pool.query(
    `UPDATE escalations SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = $3
     WHERE id = $1 AND status = 'open' RETURNING *`,
    [id, actorPersonId, now],
  );
  return rows.length ? toEscalation(rows[0]) : null;
}

export async function resolveEscalation(id: string, actorPersonId: number, now: string): Promise<Escalation | null> {
  const { rows } = await pool.query(
    `UPDATE escalations SET status = 'resolved', resolved_by = $2, resolved_at = $3
     WHERE id = $1 AND status IN ('open', 'acknowledged') RETURNING *`,
    [id, actorPersonId, now],
  );
  return rows.length ? toEscalation(rows[0]) : null;
}

/* ---------- policy — immutable revisions ---------- */

export async function getCurrentRevision(orgId: number): Promise<PolicyRevision> {
  const { rows } = await pool.query(
    'SELECT * FROM policy_revisions WHERE org_id = $1 ORDER BY id DESC LIMIT 1',
    [orgId],
  );
  return toRevision(rows[0]);
}

export async function listRevisions(orgId: number): Promise<PolicyRevision[]> {
  const { rows } = await pool.query('SELECT * FROM policy_revisions WHERE org_id = $1 ORDER BY id', [orgId]);
  return rows.map(toRevision);
}

export async function insertRevision(input: {
  orgId: number;
  grid: PolicyRevision['grid'];
  createdBy: string;
  note: string;
  now: string;
}): Promise<PolicyRevision> {
  const { rows } = await pool.query(
    `INSERT INTO policy_revisions (org_id, grid, created_at, created_by, note)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.orgId, JSON.stringify(input.grid), input.now, input.createdBy, input.note],
  );
  return toRevision(rows[0]);
}

/** Seeds the one policy revision every organization needs to exist before it can be queried. */
export async function insertInitialRevision(orgId: number, grid: PolicyRevision['grid']): Promise<PolicyRevision> {
  return insertRevision({ orgId, grid, createdBy: 'seed', note: 'Initial policy', now: new Date().toISOString() });
}

/* ---------- audit — append-only, hash-chained ----------
   The chain lives in the database; the hashing algorithm lives in domain/audit.ts, so
   this never re-implements it. A row is only ever appended after taking a session
   advisory lock scoped to the org, so two concurrent requests for the same org can't
   both read the same "last row" and append two entries with the same prevHash. Advisory
   locks need no table privilege — LOCK TABLE / SELECT FOR UPDATE would need UPDATE
   grants that mesh_app is deliberately never given on this table. */
const AUDIT_APPEND_LOCK_CLASS = 0x6d657368; // 'mesh' — arbitrary, just needs to be stable

export async function appendAuditEntry(input: {
  orgId: number;
  requesterId: number;
  requesterRole: RequesterRole;
  targetPersonId: number;
  question: string;
  snapshot: AuditEntry['snapshot'];
  now: string;
  /** UI grouping only — never part of hashEntry()'s input, see 0001_baseline.sql's comment on
   *  this column. */
  conversationId?: string | null;
}): Promise<AuditEntry> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [AUDIT_APPEND_LOCK_CLASS, input.orgId]);
    const { rows: last } = await client.query(
      'SELECT row_hash FROM audit_log WHERE org_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
      [input.orgId],
    );
    const base: Omit<AuditEntry, 'rowHash'> = {
      id: randomUUID(),
      orgId: String(input.orgId),
      requesterId: input.requesterId,
      requesterRole: input.requesterRole,
      targetPersonId: input.targetPersonId,
      question: input.question,
      snapshot: input.snapshot,
      policyRevisionId: input.snapshot.policyRevisionId,
      subjectNotifiedAt: input.now,
      createdAt: input.now,
      prevHash: last[0]?.row_hash ?? null,
    };
    const entry: AuditEntry = { ...base, rowHash: hashEntry(base), conversationId: input.conversationId ?? null };
    await client.query(
      `INSERT INTO audit_log
         (id, org_id, requester_id, requester_role, target_person_id, question, snapshot,
          policy_revision_id, subject_notified_at, created_at, prev_hash, row_hash, conversation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        entry.id, input.orgId, entry.requesterId, entry.requesterRole, entry.targetPersonId,
        entry.question, JSON.stringify(entry.snapshot), entry.policyRevisionId,
        entry.subjectNotifiedAt, entry.createdAt, entry.prevHash, entry.rowHash, entry.conversationId,
      ],
    );
    await client.query('COMMIT');
    return entry;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listAuditEntries(orgId: number): Promise<AuditEntry[]> {
  const { rows } = await pool.query('SELECT * FROM audit_log WHERE org_id = $1 ORDER BY created_at, id', [orgId]);
  return rows.map(toAuditEntry);
}

export async function auditForSubject(personId: number): Promise<AuditEntry[]> {
  const { rows } = await pool.query(
    'SELECT * FROM audit_log WHERE target_person_id = $1 ORDER BY created_at, id',
    [personId],
  );
  return rows.map(toAuditEntry);
}

/** One "someone asked about you" notification: a persisted ask by someone else about one of
 *  this account's own people. Derived from audit_log, never stored separately. The subject
 *  already sees who asked and what (`/api/audit/subject/:id`), so nothing new is disclosed. */
export interface AskedAboutYouNotification {
  id: string;
  askedAt: string;
  askerName: string;
  askerRole: string;
  question: string;
  personId: number;
  orgId: number;
  orgName: string;
  unread: boolean;
}

export async function listAskedAboutYou(accountId: number, limit = 20): Promise<{ items: AskedAboutYouNotification[]; unreadCount: number }> {
  const [{ rows }, { rows: countRows }] = await Promise.all([
    pool.query(
      `SELECT a.id, a.created_at, a.requester_role, a.question, a.target_person_id, a.org_id,
              o.name AS org_name, COALESCE(r.name, 'Someone') AS asker_name,
              a.created_at > COALESCE(nr.seen_through, '-infinity') AS unread
         FROM audit_log a
         JOIN people t ON t.id = a.target_person_id AND t.account_id = $1
         JOIN organizations o ON o.id = a.org_id
         LEFT JOIN people r ON r.id = a.requester_id
         LEFT JOIN notification_reads nr ON nr.account_id = $1
        WHERE a.requester_id <> a.target_person_id
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $2`,
      [accountId, limit],
    ),
    pool.query(
      `SELECT count(*)::int AS n
         FROM audit_log a
         JOIN people t ON t.id = a.target_person_id AND t.account_id = $1
         LEFT JOIN notification_reads nr ON nr.account_id = $1
        WHERE a.requester_id <> a.target_person_id
          AND a.created_at > COALESCE(nr.seen_through, '-infinity')`,
      [accountId],
    ),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      askedAt: iso(row.created_at),
      askerName: row.asker_name,
      askerRole: row.requester_role,
      question: row.question,
      personId: row.target_person_id,
      orgId: row.org_id,
      orgName: row.org_name,
      unread: row.unread,
    })),
    unreadCount: countRows[0].n,
  };
}

/** Marks notifications read up to `through` (the newest one the person actually saw, so an
 *  ask landing while the list was open still counts as unread). Never moves backwards and
 *  never past the database's own clock. */
export async function markAskedAboutYouSeen(accountId: number, through: string): Promise<void> {
  await pool.query(
    `INSERT INTO notification_reads (account_id, seen_through) VALUES ($1, LEAST($2::timestamptz, now()))
     ON CONFLICT (account_id) DO UPDATE
       SET seen_through = GREATEST(notification_reads.seen_through, EXCLUDED.seen_through)`,
    [accountId, through],
  );
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
}

/** A "chat" — My agent → Ask yourself (requesterId === targetId) or a real cross-person
 *  Ask thread (e.g. a manager's own chat with one employee) — is a UI grouping over real
 *  audit rows for one (requester, target) pair, not a separate stored entity: title and
 *  last-updated are derived, not stored, so there's nothing to keep in sync. Grouped in
 *  application code rather than SQL GROUP BY, matching how coverage/escalation checks
 *  already aggregate elsewhere in this codebase. */
export async function listConversationsForPair(requesterId: number, targetId: number): Promise<ConversationSummary[]> {
  const { rows } = await pool.query(
    `SELECT conversation_id, question, created_at FROM audit_log
     WHERE requester_id = $1 AND target_person_id = $2
       AND conversation_id IS NOT NULL
     ORDER BY created_at`,
    [requesterId, targetId],
  );
  const byId = new Map<string, ConversationSummary>();
  for (const row of rows) {
    const id = row.conversation_id as string;
    const existing = byId.get(id);
    if (existing) {
      existing.updatedAt = iso(row.created_at);
      existing.turnCount += 1;
    } else {
      byId.set(id, { id, title: row.question, updatedAt: iso(row.created_at), turnCount: 1 });
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Most recent real asks for one specific (requester, target) pair, newest first — the
 *  input ESC-REPEAT-WITHHOLD checks. */
export async function getRecentAuditForPair(requesterId: number, targetPersonId: number, limit: number): Promise<AuditEntry[]> {
  const { rows } = await pool.query(
    'SELECT * FROM audit_log WHERE requester_id = $1 AND target_person_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3',
    [requesterId, targetPersonId, limit],
  );
  return rows.map(toAuditEntry);
}

export async function verifyAudit(orgId: number): Promise<{ valid: boolean; brokenAt: number | null }> {
  return verifyChain(await listAuditEntries(orgId));
}

/* ---------- agent runtimes ---------- */

export async function getRuntimeCatalog(): Promise<AgentRuntime[]> {
  const { rows } = await pool.query('SELECT * FROM runtime_catalog ORDER BY key');
  return rows.map(toRuntime);
}

export async function getPersonRuntimes(personId: number): Promise<PersonRuntime[]> {
  const { rows } = await pool.query(
    'SELECT * FROM person_runtimes WHERE person_id = $1 ORDER BY added_at',
    [personId],
  );
  return rows.map(toPersonRuntime);
}

/** Registers a personal sub-agent — never connected to org surfaces. The org's one main
 *  agent is a separate, admin-only concept — see getOrgMainAgent/setOrgMainAgent below. */
export async function insertPersonRuntime(
  personId: number,
  runtimeKey: string,
  scope: RuntimeScope,
  addedAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO person_runtimes (org_id, person_id, runtime_key, scope, added_at)
     SELECT org_id, $1, $2, $3, $4 FROM people WHERE id = $1`,
    [personId, runtimeKey, scope, addedAt],
  );
}

export async function deletePersonRuntime(personId: number, runtimeKey: string): Promise<void> {
  await pool.query('DELETE FROM person_runtimes WHERE person_id = $1 AND runtime_key = $2', [personId, runtimeKey]);
}

/** Same trio, account-keyed instead of person-keyed — a sub-agent registered by an
 *  account with no organization at all. */
export async function getAccountRuntimes(accountId: number): Promise<PersonRuntime[]> {
  const { rows } = await pool.query(
    'SELECT * FROM account_runtimes WHERE account_id = $1 ORDER BY added_at',
    [accountId],
  );
  return rows.map(toPersonRuntime);
}

export async function insertAccountRuntime(
  accountId: number,
  runtimeKey: string,
  scope: RuntimeScope,
  addedAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO account_runtimes (account_id, runtime_key, scope, added_at) VALUES ($1,$2,$3,$4)`,
    [accountId, runtimeKey, scope, addedAt],
  );
}

export async function deleteAccountRuntime(accountId: number, runtimeKey: string): Promise<void> {
  await pool.query('DELETE FROM account_runtimes WHERE account_id = $1 AND runtime_key = $2', [accountId, runtimeKey]);
}

export async function getOrgMainAgent(orgId: number): Promise<OrgMainAgent | null> {
  const { rows } = await pool.query('SELECT * FROM org_main_agent WHERE org_id = $1', [orgId]);
  return rows[0] ? toOrgMainAgent(rows[0]) : null;
}

/** Sets (or switches) the org's one main/aggregator agent — the only registration
 *  connected to the org. Called only from an admin-gated endpoint
 *  (server.ts's POST /api/organizations/:orgId/main-agent); no individual person can
 *  reach this. org_id is the table's primary key, so this is a plain upsert — there's
 *  never an old row to demote, unlike the old per-person version. */
/** apiKeyEncrypted/baseUrl/model are the org's fully-resolved final values (never
 *  "undefined meaning leave unchanged" — that merge, if the caller wants one, happens in
 *  server.ts before calling this, same as every other value here). Pass null to clear an
 *  override back to the platform default. */
export async function setOrgMainAgent(
  orgId: number,
  runtimeKey: string,
  scope: RuntimeScope,
  addedAt: string,
  apiKeyEncrypted: string | null,
  baseUrl: string | null,
  model: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO org_main_agent (org_id, runtime_key, scope, added_at, api_key_encrypted, base_url, model)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (org_id) DO UPDATE SET
       runtime_key = $2, scope = $3, added_at = $4,
       api_key_encrypted = $5, base_url = $6, model = $7`,
    [orgId, runtimeKey, scope, addedAt, apiKeyEncrypted, baseUrl, model],
  );
}

function toAccountMainAgent(row: any): AccountMainAgent {
  return {
    runtimeKey: row.runtime_key,
    addedAt: isoDate(row.added_at),
    apiKeyEncrypted: row.api_key_encrypted ?? null,
    baseUrl: row.base_url ?? null,
    model: row.model ?? null,
  };
}

export async function getAccountMainAgent(accountId: number): Promise<AccountMainAgent | null> {
  const { rows } = await pool.query('SELECT * FROM account_main_agent WHERE account_id = $1', [accountId]);
  return rows[0] ? toAccountMainAgent(rows[0]) : null;
}

/** The personal counterpart to setOrgMainAgent — self-set by the account itself (see
 *  server.ts's POST /api/accounts/me/main-agent, gated only on being logged in as
 *  yourself). No `scope`: a personal credential is always immediately usable. */
export async function setAccountMainAgent(
  accountId: number,
  runtimeKey: string,
  addedAt: string,
  apiKeyEncrypted: string | null,
  baseUrl: string | null,
  model: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO account_main_agent (account_id, runtime_key, added_at, api_key_encrypted, base_url, model)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (account_id) DO UPDATE SET
       runtime_key = $2, added_at = $3, api_key_encrypted = $4, base_url = $5, model = $6`,
    [accountId, runtimeKey, addedAt, apiKeyEncrypted, baseUrl, model],
  );
}

export interface PersonalAskEntry {
  id: string;
  conversationId: string;
  question: string;
  answer: string;
  createdAt: string;
  consultedSources: string[];
}

function toPersonalAskEntry(row: any): PersonalAskEntry {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    question: row.question,
    consultedSources: row.consulted_sources ?? [],
    answer: row.answer,
    createdAt: iso(row.created_at),
  };
}

/** A personal account's own "Ask yourself" history — the counterpart to audit_log for an
 *  account with no organization (audit_log's org_id/target_person_id are NOT NULL, so it
 *  structurally can't hold this). No hash chain, no policy_revision_id: none of
 *  audit_log's tamper-evident/disclosure properties apply — there is no one else who
 *  could ever be shown this, it's just your own chat history. */
export async function insertPersonalAsk(
  accountId: number,
  conversationId: string,
  question: string,
  answer: string,
  createdAt: string,
  consultedSources: string[] = [],
): Promise<PersonalAskEntry> {
  const { rows } = await pool.query(
    `INSERT INTO personal_asks (id, account_id, conversation_id, question, answer, created_at, consulted_sources)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [randomUUID(), accountId, conversationId, question, answer, createdAt, JSON.stringify(consultedSources)],
  );
  return toPersonalAskEntry(rows[0]);
}

export async function getPersonalConversation(accountId: number, conversationId: string): Promise<PersonalAskEntry[]> {
  const { rows } = await pool.query(
    'SELECT * FROM personal_asks WHERE account_id = $1 AND conversation_id = $2 ORDER BY created_at, id',
    [accountId, conversationId],
  );
  return rows.map(toPersonalAskEntry);
}

/** Every one of this account's own personal asks, across all its chats — the frontend
 *  groups these by conversationId itself, same as it already does with real audit rows
 *  for the org path (conversations.ts). */
export async function listPersonalAsks(accountId: number): Promise<PersonalAskEntry[]> {
  const { rows } = await pool.query(
    'SELECT * FROM personal_asks WHERE account_id = $1 ORDER BY created_at, id',
    [accountId],
  );
  return rows.map(toPersonalAskEntry);
}

/** Same grouping shape and reasoning as listConversationsForPair above, just over
 *  personal_asks instead of audit_log. */
export async function listPersonalConversations(accountId: number): Promise<ConversationSummary[]> {
  const { rows } = await pool.query(
    `SELECT conversation_id, question, created_at FROM personal_asks
     WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  const byId = new Map<string, ConversationSummary>();
  for (const row of rows) {
    const id = row.conversation_id as string;
    const existing = byId.get(id);
    if (existing) {
      existing.updatedAt = iso(row.created_at);
      existing.turnCount += 1;
    } else {
      byId.set(id, { id, title: row.question, updatedAt: iso(row.created_at), turnCount: 1 });
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Real, permanent delete — safe here in a way it structurally isn't for audit_log (rule 2):
 *  personal_asks carries no one else's disclosure evidence, no hash chain, nothing anyone
 *  but this same account could ever be shown, and mesh_app holds a real DELETE grant on
 *  this table specifically (unlike audit_log/policy_revisions' INSERT-only grant). Scoped
 *  to accountId so one account can never delete another's chat by guessing a conversation
 *  id. Deleting a conversation that doesn't belong to this account, or doesn't exist,
 *  quietly deletes zero rows rather than erroring — same idempotent-delete posture as
 *  every other DELETE endpoint in this codebase. */
export async function deletePersonalConversation(accountId: number, conversationId: string): Promise<void> {
  await pool.query('DELETE FROM personal_asks WHERE account_id = $1 AND conversation_id = $2', [accountId, conversationId]);
}

/* ---------- personal OAuth connections ----------
   Not org data — credential state for the real-integration features. Fully owned by the
   person: unlike audit_log, this can be updated and deleted by them at will. */

export interface OAuthConnection {
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  connectedEmail: string | null;
  siteUrl: string | null;
}

// Credentials are encrypted at rest (domain/credentials.ts) and decrypted only here, on the
// way out of the database — every connector reads through this one mapper.
function toOAuthConnection(row: any): OAuthConnection {
  return {
    provider: row.provider,
    accessToken: decryptCredential(row.access_token),
    refreshToken: row.refresh_token == null ? null : decryptCredential(row.refresh_token),
    expiresAt: iso(row.expires_at),
    connectedEmail: row.connected_email,
    siteUrl: row.site_url,
  };
}

export async function getOAuthConnection(personId: number, provider: string): Promise<OAuthConnection | null> {
  const { rows } = await pool.query(
    'SELECT * FROM person_oauth_tokens WHERE person_id = $1 AND provider = $2',
    [personId, provider],
  );
  return rows.length ? toOAuthConnection(rows[0]) : null;
}

export async function saveOAuthConnection(personId: number, input: {
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  connectedEmail: string | null;
  siteUrl?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO person_oauth_tokens
       (person_id, provider, access_token, refresh_token, expires_at, connected_email, site_url, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (person_id, provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, person_oauth_tokens.refresh_token),
       expires_at = EXCLUDED.expires_at,
       connected_email = EXCLUDED.connected_email,
       site_url = EXCLUDED.site_url,
       updated_at = EXCLUDED.updated_at`,
    [
      personId, input.provider, encryptCredential(input.accessToken),
      input.refreshToken == null ? null : encryptCredential(input.refreshToken),
      input.expiresAt, input.connectedEmail, input.siteUrl ?? null, new Date().toISOString(),
    ],
  );
}

export async function deleteOAuthConnection(personId: number, provider: string): Promise<void> {
  await pool.query('DELETE FROM person_oauth_tokens WHERE person_id = $1 AND provider = $2', [personId, provider]);
}

/** Same three functions, one level up: an account with no organization (no `people` row
 *  to key off of) connecting a tool from its own personal "Set up my agent" — mirrors
 *  the person-keyed trio above exactly, just against account_oauth_tokens. */
export async function getAccountOAuthConnection(accountId: number, provider: string): Promise<OAuthConnection | null> {
  const { rows } = await pool.query(
    'SELECT * FROM account_oauth_tokens WHERE account_id = $1 AND provider = $2',
    [accountId, provider],
  );
  return rows.length ? toOAuthConnection(rows[0]) : null;
}

export async function saveAccountOAuthConnection(accountId: number, input: {
  provider: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  connectedEmail: string | null;
  siteUrl?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO account_oauth_tokens
       (account_id, provider, access_token, refresh_token, expires_at, connected_email, site_url, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (account_id, provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, account_oauth_tokens.refresh_token),
       expires_at = EXCLUDED.expires_at,
       connected_email = EXCLUDED.connected_email,
       site_url = EXCLUDED.site_url,
       updated_at = EXCLUDED.updated_at`,
    [
      accountId, input.provider, encryptCredential(input.accessToken),
      input.refreshToken == null ? null : encryptCredential(input.refreshToken),
      input.expiresAt, input.connectedEmail, input.siteUrl ?? null, new Date().toISOString(),
    ],
  );
}

export async function deleteAccountOAuthConnection(accountId: number, provider: string): Promise<void> {
  await pool.query('DELETE FROM account_oauth_tokens WHERE account_id = $1 AND provider = $2', [accountId, provider]);
}

/* ---------- self-service tool connections ----------
   Real, general, user-driven activity ingestion — see 0001_baseline.sql's comment on these two
   tables and docs/agent-to-agent-communication.md §13. */

export interface IngestToken {
  id: string;
  personId: number;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

function toIngestToken(row: any): IngestToken {
  return {
    id: row.id,
    personId: row.person_id,
    label: row.label,
    createdAt: iso(row.created_at),
    lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
    revoked: row.revoked_at != null,
  };
}

/** Stores only the hash — the raw token is never persisted, so it can never leak from a
 *  DB dump or backup. Returns the created row's metadata, not the token (the caller who
 *  generated the raw token already has it). */
export async function insertIngestToken(id: string, personId: number, tokenHash: string, label: string): Promise<IngestToken> {
  const { rows } = await pool.query(
    `INSERT INTO ingest_tokens (id, person_id, token_hash, label, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, personId, tokenHash, label, new Date().toISOString()],
  );
  return toIngestToken(rows[0]);
}

export async function listIngestTokens(personId: number): Promise<IngestToken[]> {
  const { rows } = await pool.query('SELECT * FROM ingest_tokens WHERE person_id = $1 ORDER BY created_at DESC', [personId]);
  return rows.map(toIngestToken);
}

export async function revokeIngestToken(personId: number, tokenId: string): Promise<void> {
  await pool.query(
    'UPDATE ingest_tokens SET revoked_at = $3 WHERE id = $1 AND person_id = $2 AND revoked_at IS NULL',
    [tokenId, personId, new Date().toISOString()],
  );
}

/** The only place a hashed token is ever compared — resolves an inbound webhook's bearer
 *  token to the person who owns it, or null if it's unknown/revoked. This is the entire
 *  authentication boundary for /api/ingest/:source: identity comes from the token, never
 *  from anything else in the request. */
export async function resolveIngestToken(tokenHash: string): Promise<{ personId: number } | null> {
  const { rows } = await pool.query(
    'SELECT person_id FROM ingest_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
  if (rows.length === 0) return null;
  await pool.query('UPDATE ingest_tokens SET last_used_at = $2 WHERE token_hash = $1', [tokenHash, new Date().toISOString()]);
  return { personId: rows[0].person_id };
}

export interface IngestedEvent {
  source: string;
  kind: string;
  summary: string;
  occurredAt: string;
}

export async function insertIngestedEvent(id: string, personId: number, event: IngestedEvent): Promise<void> {
  await pool.query(
    `INSERT INTO ingested_events (id, person_id, source, kind, summary, occurred_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, personId, event.source, event.kind, event.summary, event.occurredAt],
  );
}

export async function getIngestedEventsSince(personId: number, source: string, since: Date): Promise<IngestedEvent[]> {
  const { rows } = await pool.query(
    `SELECT * FROM ingested_events WHERE person_id = $1 AND source = $2 AND occurred_at >= $3 ORDER BY occurred_at`,
    [personId, source, since.toISOString()],
  );
  return rows.map((r) => ({ source: r.source, kind: r.kind, summary: r.summary, occurredAt: iso(r.occurred_at) }));
}

/** Same shape as the ingest-token/ingested-event pair above, account-keyed instead of
 *  person-keyed — a personal (no-org) account's own bearer token for POST
 *  /api/ingest/:source and the raw activity it authenticates. */
export interface AccountIngestToken {
  id: string;
  accountId: number;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

function toAccountIngestToken(row: any): AccountIngestToken {
  return {
    id: row.id,
    accountId: row.account_id,
    label: row.label,
    createdAt: iso(row.created_at),
    lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
    revoked: row.revoked_at != null,
  };
}

export async function insertAccountIngestToken(id: string, accountId: number, tokenHash: string, label: string): Promise<AccountIngestToken> {
  const { rows } = await pool.query(
    `INSERT INTO account_ingest_tokens (id, account_id, token_hash, label, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [id, accountId, tokenHash, label, new Date().toISOString()],
  );
  return toAccountIngestToken(rows[0]);
}

export async function listAccountIngestTokens(accountId: number): Promise<AccountIngestToken[]> {
  const { rows } = await pool.query('SELECT * FROM account_ingest_tokens WHERE account_id = $1 ORDER BY created_at DESC', [accountId]);
  return rows.map(toAccountIngestToken);
}

export async function revokeAccountIngestToken(accountId: number, tokenId: string): Promise<void> {
  await pool.query(
    'UPDATE account_ingest_tokens SET revoked_at = $3 WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL',
    [tokenId, accountId, new Date().toISOString()],
  );
}

export async function resolveAccountIngestToken(tokenHash: string): Promise<{ accountId: number } | null> {
  const { rows } = await pool.query(
    'SELECT account_id FROM account_ingest_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
  if (rows.length === 0) return null;
  await pool.query('UPDATE account_ingest_tokens SET last_used_at = $2 WHERE token_hash = $1', [tokenHash, new Date().toISOString()]);
  return { accountId: rows[0].account_id };
}

export async function insertAccountIngestedEvent(id: string, accountId: number, event: IngestedEvent): Promise<void> {
  await pool.query(
    `INSERT INTO account_ingested_events (id, account_id, source, kind, summary, occurred_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, accountId, event.source, event.kind, event.summary, event.occurredAt],
  );
}

export async function getAccountIngestedEventsSince(accountId: number, source: string, since: Date): Promise<IngestedEvent[]> {
  const { rows } = await pool.query(
    `SELECT * FROM account_ingested_events WHERE account_id = $1 AND source = $2 AND occurred_at >= $3 ORDER BY occurred_at`,
    [accountId, source, since.toISOString()],
  );
  return rows.map((r) => ({ source: r.source, kind: r.kind, summary: r.summary, occurredAt: iso(r.occurred_at) }));
}

/** An account's own freely-named custom sub-agent — see account_custom_agents' own
 *  0001_baseline.sql comment for why this is deliberately account-only and never a SurfaceKey. */
export interface AccountCustomAgent {
  id: string;
  accountId: number;
  sourceKey: string;
  name: string;
  purpose: string;
  createdAt: string;
}

function toAccountCustomAgent(row: any): AccountCustomAgent {
  return {
    id: row.id,
    accountId: row.account_id,
    sourceKey: row.source_key,
    name: row.name,
    purpose: row.purpose,
    createdAt: iso(row.created_at),
  };
}

/** sourceKey is generated here, not supplied by the caller — it only has to be unique and
 *  URL-safe, never secret (the ingest token is still the whole auth boundary; see
 *  POST /api/ingest/:source in server.ts). */
export async function createAccountCustomAgent(accountId: number, name: string, purpose: string): Promise<AccountCustomAgent> {
  const id = randomUUID();
  const sourceKey = `custom-${randomBytes(6).toString('hex')}`;
  const { rows } = await pool.query(
    `INSERT INTO account_custom_agents (id, account_id, source_key, name, purpose, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, accountId, sourceKey, name, purpose, new Date().toISOString()],
  );
  return toAccountCustomAgent(rows[0]);
}

export async function listAccountCustomAgents(accountId: number): Promise<AccountCustomAgent[]> {
  const { rows } = await pool.query('SELECT * FROM account_custom_agents WHERE account_id = $1 ORDER BY created_at', [accountId]);
  return rows.map(toAccountCustomAgent);
}

export async function deleteAccountCustomAgent(accountId: number, id: string): Promise<void> {
  await pool.query('DELETE FROM account_custom_agents WHERE account_id = $1 AND id = $2', [accountId, id]);
}

/** The ownership check POST /api/ingest/:source uses once a pushed source isn't one of the
 *  three fixed INGEST_SOURCES: does this source_key belong to a real, registered custom
 *  agent at all, and (checked by the caller) does it belong to *this* resolved account. */
export async function getAccountCustomAgentBySourceKey(sourceKey: string): Promise<AccountCustomAgent | null> {
  const { rows } = await pool.query('SELECT * FROM account_custom_agents WHERE source_key = $1', [sourceKey]);
  return rows[0] ? toAccountCustomAgent(rows[0]) : null;
}
