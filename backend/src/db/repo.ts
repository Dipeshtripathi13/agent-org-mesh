import { randomUUID } from 'node:crypto';
import { hashEntry, verifyChain } from '../domain/audit.js';
import { computeEscalationAge } from '../domain/escalations.js';
import type {
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
}

export type OrgRole = 'owner' | 'admin' | 'viewer';

export interface OrgAdmin {
  accountId: number;
  name: string;
  email: string;
  role: OrgRole;
  addedAt: string;
}

export interface Organization {
  id: number;
  slug: string;
  name: string;
  createdAt: string;
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
  return { runtimeKey: row.runtime_key, scope: row.scope, addedAt: isoDate(row.added_at) };
}

function toOrganization(row: any): Organization {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: iso(row.created_at),
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

export async function getAccount(id: number): Promise<Account | null> {
  const { rows } = await pool.query('SELECT id, name, email FROM accounts WHERE id = $1', [id]);
  return rows.length ? { id: rows[0].id, name: rows[0].name, email: rows[0].email } : null;
}

export async function getAccountByEmail(email: string): Promise<(Account & { passwordHash: string | null }) | null> {
  const { rows } = await pool.query('SELECT id, name, email, password_hash FROM accounts WHERE email = $1', [email]);
  if (rows.length === 0) return null;
  return { id: rows[0].id, name: rows[0].name, email: rows[0].email, passwordHash: rows[0].password_hash };
}

/** Creates the account row itself — putting it to work as an org admin (addOrgAdmin) or
 *  linking it to an org-chart entry (createPerson's accountId) are separate steps, since
 *  the same account might end up doing either or both, in more than one org. */
export async function insertAccount(name: string, email: string, passwordHash: string | null): Promise<Account> {
  const { rows } = await pool.query(
    'INSERT INTO accounts (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email',
    [name, email, passwordHash],
  );
  return { id: rows[0].id, name: rows[0].name, email: rows[0].email };
}

export async function setAccountPassword(accountId: number, passwordHash: string): Promise<void> {
  await pool.query('UPDATE accounts SET password_hash = $2 WHERE id = $1', [accountId, passwordHash]);
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

/** Every organization, regardless of admin membership — deliberately NOT filtered the
 *  way listOrganizationsForAccount is. Used only to populate "My agent"'s identity
 *  switcher (frontend/src/lib/MeContext.tsx), which is intentionally open regardless of
 *  login (CLAUDE.md rule 7) — an org's name/slug/headcount is no more sensitive than the
 *  person-level data that panel already shows unauthenticated. Never use this for
 *  anything admin-scoped; that's what listOrganizationsForAccount is for. */
export async function listAllOrganizations(): Promise<Organization[]> {
  const { rows } = await pool.query(
    `SELECT o.*, count(p.id)::int AS people_count
     FROM organizations o
     LEFT JOIN people p ON p.org_id = o.id
     GROUP BY o.id
     ORDER BY o.id`,
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

/** The creating account becomes this org's sole 'owner' — atomically, so an org can
 *  never briefly exist with no admin able to manage it. Used when an *existing* account
 *  (already logged in as an admin) creates another org from Admin → Organizations —
 *  contrast with signUpWithNewOrganization below, the brand-new-account self-serve path. */
export async function createOrganization(creatorAccountId: number, name: string): Promise<Organization> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const slug = await uniqueSlug(client, name);
    const now = new Date().toISOString();
    const { rows } = await client.query(
      `INSERT INTO organizations (slug, name, created_at) VALUES ($1,$2,$3) RETURNING *`,
      [slug, name, now],
    );
    await client.query(
      `INSERT INTO org_admins (org_id, account_id, role, added_at) VALUES ($1,$2,'owner',$3)`,
      [rows[0].id, creatorAccountId, now],
    );
    await client.query('COMMIT');
    return toOrganization({ ...rows[0], people_count: 0 });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Self-serve signup: a brand-new (or previously passwordless) account creates its own
 *  organization from scratch, in one atomic step — no existing admin has to set anything
 *  up for them first. They become both that org's only person (top of the chart, no
 *  manager) and its owner-admin. Mirrors createOrganization's transaction shape, just
 *  with an account + a person row folded into the same transaction. */
export async function signUpWithNewOrganization(input: {
  name: string;
  email: string;
  passwordHash: string;
  orgName: string;
}): Promise<{ account: Account; organization: Organization; person: Person }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now = new Date().toISOString();

    const { rows: accountRows } = await client.query(
      'INSERT INTO accounts (name, email, password_hash) VALUES ($1,$2,$3) RETURNING id, name, email',
      [input.name, input.email, input.passwordHash],
    );
    const account: Account = accountRows[0];

    const slug = await uniqueSlug(client, input.orgName);
    const { rows: orgRows } = await client.query(
      'INSERT INTO organizations (slug, name, created_at) VALUES ($1,$2,$3) RETURNING *',
      [slug, input.orgName, now],
    );
    const orgId = orgRows[0].id;

    await client.query(
      `INSERT INTO org_admins (org_id, account_id, role, added_at) VALUES ($1,$2,'owner',$3)`,
      [orgId, account.id, now],
    );

    const { rows: personRows } = await client.query(
      `INSERT INTO people (org_id, name, title, team, manager_id, agent_deployed, surfaces, account_id)
       VALUES ($1,$2,$3,$4,NULL,$5,$6,$7) RETURNING *`,
      [orgId, input.name, 'Owner', 'Leadership', true, JSON.stringify(EMPTY_SURFACES), account.id],
    );

    await client.query('COMMIT');
    return {
      account,
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

export async function resolveSession(tokenHash: string, now: string): Promise<{ accountId: number } | null> {
  const { rows } = await pool.query(
    `SELECT account_id FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
    [tokenHash, now],
  );
  return rows.length ? { accountId: rows[0].account_id } : null;
}

export async function revokeSession(tokenHash: string, now: string): Promise<void> {
  await pool.query('UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1', [tokenHash, now]);
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
  // Out of scope by default — most people don't have a real sub-agent/token registered.
  'claude-code': 'outOfScope', codex: 'outOfScope', 'gemini-cli': 'outOfScope',
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
export async function getPeopleForAccount(accountId: number): Promise<(Person & { orgId: number })[]> {
  const { rows } = await pool.query('SELECT * FROM people WHERE account_id = $1 ORDER BY org_id, id', [accountId]);
  return rows.map((row) => ({ ...toPerson(row), orgId: row.org_id }));
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
  /** UI grouping only — never part of hashEntry()'s input, see schema.sql's comment on
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

export async function getOrgMainAgent(orgId: number): Promise<OrgMainAgent | null> {
  const { rows } = await pool.query('SELECT * FROM org_main_agent WHERE org_id = $1', [orgId]);
  return rows[0] ? toOrgMainAgent(rows[0]) : null;
}

/** Sets (or switches) the org's one main/aggregator agent — the only registration
 *  connected to the org. Called only from an admin-gated endpoint
 *  (server.ts's POST /api/organizations/:orgId/main-agent); no individual person can
 *  reach this. org_id is the table's primary key, so this is a plain upsert — there's
 *  never an old row to demote, unlike the old per-person version. */
export async function setOrgMainAgent(
  orgId: number,
  runtimeKey: string,
  scope: RuntimeScope,
  addedAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO org_main_agent (org_id, runtime_key, scope, added_at) VALUES ($1,$2,$3,$4)
     ON CONFLICT (org_id) DO UPDATE SET runtime_key = $2, scope = $3, added_at = $4`,
    [orgId, runtimeKey, scope, addedAt],
  );
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

function toOAuthConnection(row: any): OAuthConnection {
  return {
    provider: row.provider,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
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
    [personId, input.provider, input.accessToken, input.refreshToken, input.expiresAt, input.connectedEmail, input.siteUrl ?? null, new Date().toISOString()],
  );
}

export async function deleteOAuthConnection(personId: number, provider: string): Promise<void> {
  await pool.query('DELETE FROM person_oauth_tokens WHERE person_id = $1 AND provider = $2', [personId, provider]);
}

/* ---------- self-service tool connections ----------
   Real, general, user-driven activity ingestion — see schema.sql's comment on these two
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
