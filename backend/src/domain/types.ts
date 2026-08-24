/**
 * Agent Org Mesh — domain types.
 *
 * Read-only system: nothing here describes a write to any connected surface.
 */

/* ---------- confidence tiers ---------- */

/** T1 grounded in a system of record · T2 semi-structured · T3 unverified inference */
export type Tier = 'T1' | 'T2' | 'T3';

/** Not a tier — outcomes of the policy engine. */
export type Withheld =
  | 'WONT' // agent holds it; policy blocks disclosure. Reversible in the matrix.
  | 'CANT'; // never ingested. No policy change can surface it.

export type ClaimTier = Tier | Withheld;

/* ---------- data classes ---------- */

export const DATA_CLASSES = ['Open', 'Internal', 'Sensitive', 'Excluded'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];

/** Classes an admin can configure. Excluded is absent by construction. */
export const CONFIGURABLE_CLASSES = ['Open', 'Internal', 'Sensitive'] as const;
export type ConfigurableClass = (typeof CONFIGURABLE_CLASSES)[number];

/* ---------- roles ---------- */

export const ROLES = [
  'Self',
  'Peer',
  'Direct manager',
  'Skip-level',
  'Executive',
  'IT admin',
] as const;
export type RequesterRole = (typeof ROLES)[number];

/* ---------- surfaces ---------- */

export type SurfaceKey = 'github' | 'jira' | 'salesforce' | 'calendar' | 'slack' | 'confluence' | 'claude-code' | 'codex' | 'gemini-cli';

/**
 * connected  — live and inside the freshness window
 * partial    — connected but narrowed scope
 * stale      — connected but last read outside the window
 * absent     — in scope for this role, not connected
 * outOfScope — not applicable to this role; excluded from the denominator
 */
export type SurfaceState = 'connected' | 'partial' | 'stale' | 'absent' | 'outOfScope';

export interface Surface {
  key: SurfaceKey;
  name: string;
  feedsTier: Tier;
  /** What the connector reads — shown to the employee verbatim. */
  reads: string;
  /** What it explicitly does not read. */
  doesNotRead: string;
}

/* ---------- agent runtimes ---------- */

/**
 * The runtime that acts as a person's aggregator (Claude, ChatGPT, a self-hosted model…).
 * A catalog entry, not a person-specific record — every person picks from the same list.
 */
export interface AgentRuntime {
  key: string;
  name: string;
  vendor: string;
  contextWindow: string;
  host: string;
  /** Cleared by IT & Security. Unapproved runtimes register as `pending`, not `full`. */
  approved: boolean;
  /** No data-processing agreement on file. Cannot be registered at all. */
  blocked: boolean;
  reads: string;
  note: string;
  /** Which real ModelProvider adapter answers questions when this is someone's main
   *  agent. 'openai-compatible' covers ChatGPT and any open-source/self-hosted model
   *  behind the same wire protocol — one adapter, not one per vendor. 'unsupported'
   *  means no real integration path yet; stays a labelled simulation. */
  apiFamily: ApiFamily;
  /** Orthogonal to apiFamily: whether this catalog entry is a sensible *aggregator*
   *  choice at all, independent of which adapter would answer for it. claude-code has a
   *  real 'anthropic' apiFamily (its activity write-up already goes through Claude) but
   *  is a development tool that reads GitHub/Jira only — never meant to be the org-facing
   *  main agent, only ever a sub-agent. Main-agent eligibility is `mainEligible &&
   *  apiFamily !== 'unsupported'` (both must hold — a well-formed catalog keeps them in
   *  sync, but callers should not assume one implies the other). */
  mainEligible: boolean;
}

export type ApiFamily = 'anthropic' | 'openai-compatible' | 'unsupported';

export type RuntimeScope = 'full' | 'narrow' | 'pending';

/** One person's registration of one catalog runtime as a personal sub-agent — never
 *  touches org surfaces, never answers a cross-org query, never connected to the org.
 *  The org's one main/aggregator agent is a separate, org-level concept — see
 *  OrgMainAgent below. */
export interface PersonRuntime {
  runtimeKey: string;
  scope: RuntimeScope;
  addedAt: string;
}

/** The org's one main/aggregator agent — the only registration connected to the org: it
 *  carries surface scope and is what everyone's queries reach. Set only by an org admin
 *  (server.ts's POST /api/organizations/:orgId/main-agent), never by an individual
 *  person — see runtimeProvider.ts's getMainProvider. */
export interface OrgMainAgent {
  runtimeKey: string;
  scope: RuntimeScope;
  addedAt: string;
}

/* ---------- org ---------- */

export interface Person {
  id: number;
  name: string;
  title: string;
  team: string;
  managerId: number | null;
  /** An agent may be provisioned but not deployed. Never treated as zero coverage. */
  agentDeployed: boolean;
  surfaces: Record<SurfaceKey, SurfaceState>;
  /** The real login (db/repo.ts's `accounts`) linked to this org-chart entry, if any.
   *  Optional — pure disclosure logic (policy.ts, coverage.ts) never reads this, it's
   *  purely an identity-linking concern, so no existing fixture needs updating. */
  accountId?: number | null;
}

export interface CoverageReport {
  personId: number;
  /** null when no agent is deployed — distinct from 0%. */
  percent: number | null;
  inScopeCount: number;
  connectedCount: number;
  /** Human-readable gaps, e.g. "Confluence — not connected". */
  gaps: string[];
  agentDeployed: boolean;
}

/* ---------- evidence ---------- */

export interface Evidence {
  id: string;
  kind: string;
  title: string;
  connector: SurfaceKey;
  recordedAt: string;
  excerpt: string;
  note: string;
  /** Resolve at read time. If this fails, the claim is downgraded rather than shown. */
  externalRef: string;
}

/* ---------- claims ---------- */

export interface Claim {
  id: string;
  personId: number;
  tier: Tier;
  dataClass: DataClass;
  text: string;
  evidenceId: string | null;
  /** Surface the claim depends on. If it goes absent, the claim is not asserted. */
  sourceSurface: SurfaceKey;
  derivedAt: string;
  /** Corrections supersede rather than mutate. */
  supersededBy: string | null;
}

/* ---------- policy ---------- */

export type Disposition = 'allow' | 'redact' | 'refuse';

export type PolicyGrid = Record<RequesterRole, Record<ConfigurableClass, Disposition>>;

/**
 * Immutable. Editing writes a new revision; nothing updates in place.
 * Every response snapshot references the revision in force at read time.
 */
export interface PolicyRevision {
  id: number;
  orgId: string;
  grid: PolicyGrid;
  createdAt: string;
  createdBy: string;
  note: string;
}

/* ---------- responses ---------- */

export interface ResponseItem {
  tier: ClaimTier;
  text: string;
  evidenceId: string | null;
  /** Set when the engine withheld something — never a silent omission. */
  policyRef: string | null;
}

export interface CoverageStatement {
  percent: number | null;
  readSurfaces: SurfaceKey[];
  missingSurfaces: string[];
  /** Plain sentence shown under every answer. */
  text: string;
}

export interface AgentResponse {
  targetPersonId: number;
  requesterRole: RequesterRole;
  policyRevisionId: number;
  items: ResponseItem[];
  coverage: CoverageStatement;
  answeredAt: string;
  /**
   * Set only by /api/agent/ask — an LLM-written synthesis of a specific free-text
   * question, built strictly from `items` where policyRef is null (never redacted or
   * refused text). Stored once in the audit snapshot alongside `items`, exactly like
   * everything else here: never re-derived later.
   */
  synthesizedAnswer?: string;
  /**
   * Set only by /api/agent/ask — human-readable labels of which real tools the router
   * actually decided to call to answer *this* question (e.g. `["Claude Code", "Gmail"]`),
   * distinct from `items`, which reflects everything currently on file regardless of
   * whether it was touched this turn. Stored once alongside the answer, same as
   * `synthesizedAnswer` — never re-derived later.
   */
  consultedSources?: string[];
}

/* ---------- escalations ---------- */

/** One name in an escalation path, resolved from the org chart at detection time. */
export interface EscalationPathEntry {
  personId: number;
  name: string;
}

export type EscalationStatus = 'open' | 'acknowledged' | 'resolved';

/**
 * What the mesh pushed upward on its own, without being asked. T1/T2 escalations are
 * evidence-backed. CANT means the mesh detected a possible blocker but coverage was too
 * thin to assert it — so it escalates the coverage gap itself, never a guess dressed up
 * as a fact.
 */
export interface Escalation {
  id: string;
  kind: Tier | Withheld;
  title: string;
  detail: string;
  personId: number;
  evidenceId: string | null;
  rule: string;
  /** Derived from createdAt at read time — never stored as a literal (CLAUDE.md rule 6). */
  ageDays: number;
  status: EscalationStatus;
  acknowledgedBy: number | null;
  acknowledgedAt: string | null;
  resolvedBy: number | null;
  resolvedAt: string | null;
  /** Escalation order, e.g. [Diego Okonjo, Hana Oyelaran, Sofia Almeida]. */
  path: EscalationPathEntry[];
}

/**
 * What a detection rule actually produces (`domain/escalations.ts`). Deliberately excludes
 * `status`/`acknowledged*`/`resolved*`/`ageDays` — those are DB-managed state a re-running
 * detection must never overwrite; see `upsertEscalationDraft` in `db/repo.ts`.
 */
export type EscalationDraft = Pick<
  Escalation,
  'id' | 'kind' | 'title' | 'detail' | 'personId' | 'evidenceId' | 'rule' | 'path'
>;

/** The full stored row shape, minus the computed `ageDays` — what seed data authors and
 *  what a DB row round-trips to before `ageDays` is derived at read time. */
export type EscalationRecord = Omit<Escalation, 'ageDays'> & { createdAt: string };

/* ---------- audit ---------- */

/**
 * Append-only. The snapshot is resolved once at read time and never re-derived —
 * re-deriving would let a later policy edit rewrite history.
 */
export interface AuditEntry {
  id: string;
  orgId: string;
  requesterId: number;
  requesterRole: RequesterRole;
  targetPersonId: number;
  question: string;
  /** Frozen at the moment the answer was returned. */
  snapshot: AgentResponse;
  policyRevisionId: number;
  subjectNotifiedAt: string;
  createdAt: string;
  prevHash: string | null;
  rowHash: string;
  /** Groups a person's own "Self" asks into a chat — UI metadata only, outside the hash
   *  (see hashEntry() in audit.ts, which never reads this field). Optional so the
   *  in-memory AuditLog.append() in audit.ts — which predates chats and has no concept of
   *  one — never needs to know about it. Null/absent for anything not part of a chat. */
  conversationId?: string | null;
}
