export type Tier = 'T1' | 'T2' | 'T3' | 'WONT' | 'CANT';
export type Disposition = 'allow' | 'redact' | 'refuse';
export type SurfaceState = 'connected' | 'partial' | 'stale' | 'absent' | 'outOfScope';

export interface ResponseItem {
  tier: Tier;
  text: string;
  evidenceId: string | null;
  policyRef: string | null;
}
export interface AgentResponse {
  targetPersonId: number;
  requesterRole: string;
  policyRevisionId: number;
  items: ResponseItem[];
  coverage: { percent: number | null; missingSurfaces: string[]; text: string };
  /** Set only when this snapshot came from /api/agent/ask — the LLM-written synthesis of
   *  a free-text question, stored once alongside items so it can be audited later without
   *  ever being re-derived. Was missing from this type entirely until a later audit pass
   *  found the Audit Log page had nothing to read it from. */
  synthesizedAnswer?: string;
  /** Real tools the router decided to call to answer this specific question — set only
   *  by /api/agent/ask, persisted once alongside the answer, same as synthesizedAnswer. */
  consultedSources?: string[];
}
export interface Coverage {
  percent: number | null;
  inScopeCount: number;
  connectedCount: number;
  gaps: string[];
  agentDeployed: boolean;
}
export interface Person {
  id: number; name: string; title: string; team: string;
  managerId: number | null; agentDeployed: boolean;
  surfaces: Record<string, SurfaceState>;
  coverage: Coverage;
  /** The real login linked to this org-chart entry, if any — null for most of the
   *  seeded roster (structural entries, no account) and for any person added without an
   *  email. Not unique: the same account can be linked from a person row in more than
   *  one org (real multi-org membership). */
  accountId?: number | null;
}
export interface Surface { key: string; name: string; feedsTier: string; reads: string; doesNotRead: string; }
export type EscalationStatus = 'open' | 'acknowledged' | 'resolved';
export interface EscalationPathEntry { personId: number; name: string; }
export interface Escalation {
  id: string; kind: Tier; title: string; detail: string; personId: number;
  evidenceId: string | null; rule: string; ageDays: number; status: EscalationStatus;
  acknowledgedBy: number | null; acknowledgedAt: string | null;
  resolvedBy: number | null; resolvedAt: string | null;
  path: EscalationPathEntry[];
}
export interface ConnectorStats {
  key: string; name: string; feedsTier: string; reads: string; doesNotRead: string;
  status: 'live' | 'degraded' | 'stale'; inScopeCount: number; connectedCount: number;
  counts: Record<SurfaceState, number>;
}
export interface Claim {
  id: string; personId: number; tier: Tier; dataClass: string; text: string;
  evidenceId: string | null; sourceSurface: string; derivedAt: string;
  supersededBy: string | null;
}
export type RuntimeScope = 'full' | 'narrow' | 'pending';
export type ApiFamily = 'anthropic' | 'openai-compatible' | 'unsupported';
export interface AgentRuntime {
  key: string; name: string; vendor: string; contextWindow: string; host: string;
  approved: boolean; blocked: boolean; reads: string; note: string;
  /** Which real ModelProvider adapter answers through this runtime as a main agent.
   *  'unsupported' entries can only be registered as sub-agents. */
  apiFamily: ApiFamily;
  /** Orthogonal to apiFamily: whether this entry is a sensible main-agent choice at all
   *  (e.g. Claude Code has a real apiFamily but is sub-agent-only). Main-agent eligible
   *  iff mainEligible && apiFamily !== 'unsupported'. */
  mainEligible: boolean;
}
/** A personal sub-agent registration — the org's one main agent is a separate,
 *  org-level, admin-only concept. See OrgMainAgent below. */
export interface PersonRuntime { runtimeKey: string; scope: RuntimeScope; addedAt: string; }
/** The org's one main/aggregator agent — set only by an org admin
 *  (Admin → Organizations), read-only everywhere else. */
export interface OrgMainAgent { runtimeKey: string; scope: RuntimeScope; addedAt: string; }
/** The one real login identity in this app — a human, not a role. The same account can
 *  administer one or more orgs (org_admins) and/or be linked from one or more `people`
 *  rows (an org-chart identity, one per org) at the same time. */
export interface Account { id: number; name: string; email: string; }
/** 'owner' can invite/remove/promote other admins for an org (and can't be removed as
 *  the last one); 'admin' can do everything else that mutates org state; 'viewer' can
 *  see admin screens but not change anything. */
export type OrgRole = 'owner' | 'admin' | 'viewer';
export interface OrgAdmin { accountId: number; name: string; email: string; role: OrgRole; addedAt: string; }
/** One of an account's own org-chart identities — `orgId` rides outside `Person` itself
 *  since this is the one place identities from different orgs appear side by side. */
export type MyIdentity = Person & { orgId: number };
export interface Organization {
  id: number; slug: string; name: string; createdAt: string; peopleCount: number;
}
export interface NewPerson {
  name: string; title: string; team: string; managerId: number | null; agentDeployed: boolean;
  /** Optional real login for this org-chart entry — resolve-or-create server-side. */
  email?: string;
}
export interface IngestToken {
  id: string; label: string; createdAt: string; lastUsedAt: string | null; revoked: boolean;
}
export const INGEST_SOURCES = ['claude-code', 'codex', 'gemini-cli'] as const;
export type IngestSource = typeof INGEST_SOURCES[number];

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    // Same-origin via Vite's dev proxy today, so this is already the default — explicit
    // so the admin session cookie still round-trips correctly if frontend and backend
    // are ever served from different origins later.
    credentials: 'include',
    headers: init?.body ? { 'content-type': 'application/json', ...(init?.headers ?? {}) } : init?.headers,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `${res.status} ${path}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  authMe: () => req<{ account: Account | null; orgRoles: Record<number, OrgRole>; people: MyIdentity[] }>('/auth/me'),
  login: (email: string, password: string) =>
    req<{ account: Account }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  /** Self-serve: creates the account, a brand-new organization, and this account's first
   *  person-identity (top of that org's chart) in one atomic step — no existing admin
   *  required. Logs in immediately on success. */
  signUp: (name: string, email: string, password: string, organizationName: string) =>
    req<{ account: Account; organization: Organization; person: Person }>('/auth/signup', {
      method: 'POST', body: JSON.stringify({ name, email, password, organizationName }),
    }),
  logout: () => req<{ ok: true }>('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: true }>('/auth/change-password', {
      method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
    }),
  orgAdmins: (orgId: number) => req<{ admins: OrgAdmin[] }>(`/organizations/${orgId}/admins`),
  inviteOrgAdmin: (orgId: number, email: string, name: string, role: OrgRole) =>
    req<{ admin: OrgAdmin; tempPassword: string | null; emailSent: boolean }>(`/organizations/${orgId}/admins`, {
      method: 'POST', body: JSON.stringify({ email, name, role }),
    }),
  setOrgAdminRole: (orgId: number, accountId: number, role: OrgRole) =>
    req<{ ok: true }>(`/organizations/${orgId}/admins/${accountId}`, {
      method: 'PATCH', body: JSON.stringify({ role }),
    }),
  removeOrgAdmin: (orgId: number, accountId: number) =>
    req<{ ok: true }>(`/organizations/${orgId}/admins/${accountId}`, { method: 'DELETE' }),

  /** Admin-scoped — only orgs the logged-in account administers (empty when logged out). */
  organizations: () => req<{ organizations: Organization[] }>('/organizations'),
  /** Unfiltered — every org, regardless of login. Only for MeContext's identity
   *  switcher; the Admin panel should always use `organizations()` above instead. */
  orgDirectory: () => req<{ organizations: Organization[] }>('/org-directory'),
  createOrganization: (name: string) =>
    req<{ organization: Organization }>('/organizations', { method: 'POST', body: JSON.stringify({ name }) }),
  addPerson: (orgId: number, person: NewPerson) =>
    req<{ person: Person; tempPassword: string | null; emailSent: boolean }>(`/organizations/${orgId}/people`, { method: 'POST', body: JSON.stringify(person) }),
  removePerson: (orgId: number, personId: number) =>
    req<{ ok: true }>(`/organizations/${orgId}/people/${personId}`, { method: 'DELETE' }),

  org: (orgId: number) => req<{ people: Person[]; surfaces: Surface[]; neverIngested: string[] }>(`/org?orgId=${orgId}`),
  overview: (orgId: number) => req<{
    coverage: { percent: number; bands: Record<string, number>; agentsLive: number; totalPeople: number };
    refusals: { total: number; wont: number; cant: number };
    silentGaps: number; queries: number; policyRevision: number;
  }>(`/overview?orgId=${orgId}`),
  policy: (orgId: number) => req<{
    revision: { id: number; grid: Record<string, Record<string, Disposition>>; note: string };
    history: { id: number; createdAt: string; note: string }[];
  }>(`/policy?orgId=${orgId}`),
  cyclePolicy: (orgId: number, role: string, dataClass: string) =>
    req<unknown>(`/policy/cycle?orgId=${orgId}`, { method: 'POST', body: JSON.stringify({ role, dataClass }) }),
  query: (targetId: number, role: string, persist = false, question = '', requesterId = 10) =>
    req<{ response: AgentResponse }>('/query', {
      method: 'POST',
      body: JSON.stringify({ targetId, role, persist, question, requesterId }),
    }),
  agentAsk: (targetId: number, role: string, question: string, requesterId: number, window: 'today' | 'week' = 'today', persist = false, conversationId?: string) =>
    req<{
      answer: string; items: ResponseItem[]; withheldCount: number; coverage: AgentResponse['coverage'];
      conversationId?: string;
      /** Real tools the router actually called for this question (e.g. ["Claude Code",
       *  "Gmail"]) — empty when the answer came purely from what was already on file. */
      consultedSources: string[];
    }>('/agent/ask', {
      method: 'POST',
      body: JSON.stringify({ targetId, role, question, window, persist, requesterId, conversationId }),
    }),
  audit: (orgId: number) => req<{
    entries: {
      id: string; question: string; requesterRole: string; targetPersonId: number;
      createdAt: string; policyRevisionId: number; policyChangedSince: boolean;
      snapshot: AgentResponse;
    }[];
    currentRevision: number;
    integrity: { valid: boolean };
  }>(`/audit?orgId=${orgId}`),
  auditForSubject: (id: number) => req<{
    entries: {
      id: string; question: string; requesterRole: string; requesterId: number;
      targetPersonId: number; createdAt: string; policyRevisionId: number;
      snapshot: AgentResponse; conversationId: string | null;
    }[];
  }>(`/audit/subject/${id}`),
  listConversations: (requesterId: number, targetId: number) => req<{
    conversations: { id: string; title: string; updatedAt: string; turnCount: number }[];
  }>(`/agent/conversations?requesterId=${requesterId}&targetId=${targetId}`),
  escalations: (orgId: number) => req<{ escalations: Escalation[] }>(`/escalations?orgId=${orgId}`),
  acknowledgeEscalation: (id: string, actorPersonId: number) =>
    req<{ escalation: Escalation }>(`/escalations/${id}/acknowledge`, {
      method: 'POST', body: JSON.stringify({ actorPersonId }),
    }),
  resolveEscalation: (id: string, actorPersonId: number) =>
    req<{ escalation: Escalation }>(`/escalations/${id}/resolve`, {
      method: 'POST', body: JSON.stringify({ actorPersonId }),
    }),
  connections: (orgId: number) => req<{ connectors: ConnectorStats[]; neverIngested: string[] }>(`/connections?orgId=${orgId}`),
  cycleSurface: (personId: number, surfaceKey: string) =>
    req<{ person: Person; coverage: Coverage }>(`/person/${personId}/surface/cycle`, {
      method: 'POST',
      body: JSON.stringify({ surfaceKey }),
    }),
  person: (id: number) => req<{
    person: Person; coverage: Coverage;
    surfaces: (Surface & { state: SurfaceState; label: string })[];
    claims: Claim[];
  }>(`/person/${id}`),
  correctClaim: (id: string, note: string) =>
    req<{ claim: Claim }>(`/claim/${id}/correct`, { method: 'POST', body: JSON.stringify({ note }) }),
  exportPerson: (id: number) => req<Record<string, unknown>>(`/person/${id}/export`),
  runtimeCatalog: () => req<{ catalog: AgentRuntime[] }>('/runtimes'),
  personRuntimes: (id: number) =>
    req<{ catalog: AgentRuntime[]; registered: PersonRuntime[] }>(`/person/${id}/runtimes`),
  registerRuntime: (personId: number, runtimeKey: string) =>
    req<{ registered: PersonRuntime[] }>(`/person/${personId}/runtimes`, {
      method: 'POST',
      body: JSON.stringify({ runtimeKey }),
    }),
  /** The org's one main agent — read-only for everyone, set only by an org admin via
   *  setOrgMainAgent below. */
  orgMainAgent: (orgId: number) =>
    req<{ catalog: AgentRuntime[]; registered: OrgMainAgent | null }>(`/organizations/${orgId}/main-agent`),
  setOrgMainAgent: (orgId: number, runtimeKey: string, scope: 'full' | 'narrow') =>
    req<{ registered: OrgMainAgent }>(`/organizations/${orgId}/main-agent`, {
      method: 'POST',
      body: JSON.stringify({ runtimeKey, scope }),
    }),
  disconnectRuntime: (personId: number, runtimeKey: string) =>
    req<{ registered: PersonRuntime[] }>(`/person/${personId}/runtimes/${runtimeKey}`, {
      method: 'DELETE',
    }),
  queryRuntime: (personId: number, runtimeKey: string) =>
    req<{ text: string; real: boolean }>(`/person/${personId}/runtimes/${runtimeKey}/query`),
  askClaudeCliLive: (personId: number, question: string) =>
    req<{ text: string; real: true; live: true }>(`/person/${personId}/runtimes/claude-code/ask-live`, {
      method: 'POST', body: JSON.stringify({ question }),
    }),

  gmailStatus: (personId: number) =>
    req<{ connected: boolean; email: string | null }>(`/person/${personId}/gmail/status`),
  gmailConnectUrl: (personId: number) => `/api/oauth/gmail/start?personId=${personId}`,
  disconnectGmail: (personId: number) =>
    req<{ ok: true }>(`/person/${personId}/gmail`, { method: 'DELETE' }),

  githubStatus: (personId: number) =>
    req<{ connected: boolean; login: string | null }>(`/person/${personId}/github/status`),
  connectGithub: (personId: number, token: string) =>
    req<{ connected: true; login: string }>(`/person/${personId}/github`, {
      method: 'POST', body: JSON.stringify({ token }),
    }),
  disconnectGithub: (personId: number) =>
    req<{ ok: true }>(`/person/${personId}/github`, { method: 'DELETE' }),

  jiraStatus: (personId: number) =>
    req<{ connected: boolean; email: string | null; siteUrl: string | null }>(`/person/${personId}/jira/status`),
  connectJira: (personId: number, siteUrl: string, email: string, apiToken: string) =>
    req<{ connected: true; displayName: string }>(`/person/${personId}/jira`, {
      method: 'POST', body: JSON.stringify({ siteUrl, email, apiToken }),
    }),
  disconnectJira: (personId: number) =>
    req<{ ok: true }>(`/person/${personId}/jira`, { method: 'DELETE' }),

  ingestTokens: (personId: number) => req<{ tokens: IngestToken[] }>(`/person/${personId}/ingest-tokens`),
  createIngestToken: (personId: number, label: string) =>
    req<{ id: string; token: string }>(`/person/${personId}/ingest-tokens`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  revokeIngestToken: (personId: number, tokenId: string) =>
    req<{ tokens: IngestToken[] }>(`/person/${personId}/ingest-tokens/${tokenId}`, { method: 'DELETE' }),
};
