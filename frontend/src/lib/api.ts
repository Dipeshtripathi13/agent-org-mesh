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
 *  (Admin → Organizations), read-only everywhere else. `hasCustomApiKey`/`baseUrl`/`model`
 *  reflect an optional org-owned credential override (never the decrypted key itself —
 *  the backend never sends that back) that replaces this deployment's platform-wide
 *  default just for this org, including pointing at a self-hosted endpoint. */
export interface OrgMainAgent {
  runtimeKey: string;
  scope: RuntimeScope;
  addedAt: string;
  hasCustomApiKey: boolean;
  baseUrl: string | null;
  model: string | null;
}
/** The personal counterpart to OrgMainAgent, for an account connected to no organization
 *  at all — set by the account itself, no admin involved. Same shape minus `scope`. */
export interface AccountMainAgent {
  runtimeKey: string;
  addedAt: string;
  hasCustomApiKey: boolean;
  baseUrl: string | null;
  model: string | null;
}
/** One entry in the plug-and-play connector catalog (backend's connectorCatalog.ts) —
 *  drives ConnectorsPanel's dropdown and per-tool connect form entirely from data. */
export interface ConnectorField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  optional?: boolean;
  multiline?: boolean;
}
export type ConnectorCategory = 'code' | 'docs' | 'project-mgmt' | 'support' | 'crm' | 'comms' | 'calendar' | 'storage' | 'design' | 'data-eng';
export interface ConnectorDef {
  key: string;
  name: string;
  category: ConnectorCategory;
  authType: 'pat' | 'pat-with-site' | 'oauth-google' | 'ingest-token' | 'coming-soon';
  fields: ConnectorField[];
  status: 'live' | 'connectable' | 'coming-soon';
  helpText: string;
}

/** The one real login identity in this app — a human, not a role. The same account can
 *  administer one or more orgs (org_admins) and/or be linked from one or more `people`
 *  rows (an org-chart identity, one per org) at the same time. */
/** `mustChangePassword` is true while this account is still on a temp password someone
 *  else generated for it (an invite, or an admin-initiated reset) — App.tsx's Shell forces
 *  the change before anything else renders. */
export interface Account { id: number; name: string; email: string; mustChangePassword: boolean; }
/** 'owner' can invite/remove/promote other admins for an org (and can't be removed as
 *  the last one); 'admin' can do everything else that mutates org state; 'viewer' can
 *  see admin screens but not change anything. */
export type OrgRole = 'owner' | 'admin' | 'viewer';
export interface OrgAdmin { accountId: number; name: string; email: string; role: OrgRole; addedAt: string; }
/** One of an account's own org-chart identities — `orgId` rides outside `Person` itself
 *  since this is the one place identities from different orgs appear side by side. */
export type MyIdentity = Person & { orgId: number; orgName: string };
export type OrgPlan = 'starter' | 'business' | 'enterprise';
export interface Organization {
  id: number; slug: string; name: string; createdAt: string; plan: OrgPlan; peopleCount: number;
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

/** Carries the real HTTP status alongside the server's own error message — callers that
 *  need to react differently to specific statuses (429's `errorRaw = ApiError`, most
 *  notably a 428 meaning "this action needs step-up," see StepUpContext.tsx) can check
 *  `e instanceof ApiError && e.status === 428` instead of string-matching a message. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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
    throw new ApiError(res.status, body?.error ?? `${res.status} ${path}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  authMe: () =>
    req<{ account: Account | null; orgRoles: Record<number, OrgRole>; people: MyIdentity[]; adminElevatedUntil: string | null }>('/auth/me'),
  login: (email: string, password: string) =>
    req<{ account: Account }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  /** Step-up ("log in as admin") — re-verifies the already-logged-in account's own
   *  password and elevates its existing session for a short window. Not a second account
   *  or a second cookie, just proof-of-you-again before anything Admin-scoped unlocks. */
  stepUp: (password: string) =>
    req<{ adminElevatedUntil: string }>('/auth/step-up', { method: 'POST', body: JSON.stringify({ password }) }),
  /** Self-serve: creates a personal account *and* a one-person "workspace" organization
   *  for it in the same step (auto-named, no company name required up front) — logs in
   *  immediately, already elevated, so the new owner can set up their own main agent with
   *  no extra re-auth prompt. `createOrganization` below still exists separately for
   *  adding an *additional* org later. */
  signUp: (name: string, email: string, password: string) =>
    req<{ account: Account; organization: Organization; person: Person }>('/auth/signup', {
      method: 'POST', body: JSON.stringify({ name, email, password }),
    }),
  logout: () => req<{ ok: true }>('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ ok: true }>('/auth/change-password', {
      method: 'POST', body: JSON.stringify({ currentPassword, newPassword }),
    }),
  orgAdmins: (orgId: number) => req<{ admins: OrgAdmin[] }>(`/organizations/${orgId}/admins`),
  /** `tempPassword` is null — and `linkedExistingAccount` true — when this email already
   *  had a real account: they keep the login they already have, there's no new credential
   *  to hand over. The two cases read very differently to whoever invited them, so the UI
   *  has to tell them apart rather than just showing nothing. */
  inviteOrgAdmin: (orgId: number, email: string, name: string, role: OrgRole) =>
    req<{ admin: OrgAdmin; tempPassword: string | null; emailSent: boolean; linkedExistingAccount: boolean }>(
      `/organizations/${orgId}/admins`,
      { method: 'POST', body: JSON.stringify({ email, name, role }) },
    ),
  setOrgAdminRole: (orgId: number, accountId: number, role: OrgRole) =>
    req<{ ok: true }>(`/organizations/${orgId}/admins/${accountId}`, {
      method: 'PATCH', body: JSON.stringify({ role }),
    }),
  removeOrgAdmin: (orgId: number, accountId: number) =>
    req<{ ok: true }>(`/organizations/${orgId}/admins/${accountId}`, { method: 'DELETE' }),

  /** Admin-scoped — only orgs the logged-in account administers (empty when logged out). */
  organizations: () => req<{ organizations: Organization[] }>('/organizations'),
  /** Also makes the caller this org's first person (Owner, top of the chart) — accounts
   *  and orgs are fully decoupled (see auth.signUp above), so this is the one place an
   *  org actually gets created, for a brand-new individual or an existing admin alike. */
  createOrganization: (name: string) =>
    req<{ organization: Organization; person: Person }>('/organizations', { method: 'POST', body: JSON.stringify({ name }) }),
  /** Same two cases as inviteOrgAdmin above: a brand-new account gets a one-time
   *  `tempPassword`, an email that already has an account gets linked instead
   *  (`linkedExistingAccount`) and keeps its own password. */
  addPerson: (orgId: number, person: NewPerson) =>
    req<{ person: Person; tempPassword: string | null; emailSent: boolean; linkedExistingAccount: boolean }>(
      `/organizations/${orgId}/people`,
      { method: 'POST', body: JSON.stringify(person) },
    ),
  removePerson: (orgId: number, personId: number) =>
    req<{ ok: true }>(`/organizations/${orgId}/people/${personId}`, { method: 'DELETE' }),
  /** Admin-initiated reset — the no-email half of "I forgot my password". Returns a fresh
   *  one-time temp password to hand over; 409s for an account that also belongs to another
   *  organization (see the endpoint's own comment in server.ts). */
  resetPersonPassword: (orgId: number, personId: number) =>
    req<{ tempPassword: string; email: string | null }>(
      `/organizations/${orgId}/people/${personId}/reset-password`,
      { method: 'POST' },
    ),

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
  /** No `window`/time-range param — the router (server.ts's gatherAll) now infers how far
   *  back to look per connected surface from the question's own wording, replacing a fixed
   *  "Today / This week" toggle found live not to scale to hundreds of connected tools. */
  agentAsk: (targetId: number, role: string, question: string, requesterId: number, persist = false, conversationId?: string) =>
    req<{
      answer: string; items: ResponseItem[]; withheldCount: number; coverage: AgentResponse['coverage'];
      conversationId?: string;
      /** Real tools the router actually called for this question (e.g. ["Claude Code",
       *  "Gmail"]) — empty when the answer came purely from what was already on file. */
      consultedSources: string[];
    }>('/agent/ask', {
      method: 'POST',
      body: JSON.stringify({ targetId, role, question, persist, requesterId, conversationId }),
    }),
  /** One question, one update covering every direct report in one go — the multi-target
   *  sibling of agentAsk. No targetId/role: the report list is resolved server-side from
   *  the org chart itself (never client-supplied), and every report is asked under
   *  'Direct manager' because that relationship is what put them in the list at all. */
  askTeam: (question: string, requesterId: number, persist = false) =>
    req<{
      answer: string;
      reportCount: number;
      perPerson: {
        personId: number; name: string; answer: string; withheldCount: number;
        coverage: AgentResponse['coverage']; consultedSources: string[];
      }[];
    }>('/agent/ask-team', {
      method: 'POST',
      body: JSON.stringify({ question, requesterId, persist }),
    }),
  /** The personal counterpart to agentAsk, for an account with no organization — no
   *  targetId/role/requesterId, since the requester is always the target. */
  askPersonal: (question: string, conversationId?: string) =>
    req<{ answer: string; conversationId: string; consultedSources: string[] }>('/agent/ask-personal', {
      method: 'POST',
      body: JSON.stringify({ question, conversationId }),
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
  /** The personal counterparts to auditForSubject/listConversations, scoped to the
   *  logged-in account's own personal asks rather than an org-chart person id. */
  personalAsks: () => req<{
    entries: { id: string; conversationId: string; question: string; answer: string; createdAt: string; consultedSources: string[] }[];
  }>('/accounts/me/asks'),
  personalConversations: () => req<{
    conversations: { id: string; title: string; updatedAt: string; turnCount: number }[];
  }>('/accounts/me/conversations'),
  /** Real, permanent delete — safe here in a way it isn't for org/cross-person Ask threads,
   *  which are audit_log rows and can never be deleted (rule 2). See the endpoint's own
   *  comment in server.ts. */
  deletePersonalConversation: (conversationId: string) =>
    req<{ deleted: true }>(`/accounts/me/conversations/${conversationId}`, { method: 'DELETE' }),
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
  // A self-view (raw claims, ids and all) — the backend requires the caller to actually
  // be this person (session identity, falling back to requesterId===id when logged out,
  // same free-switcher trust level as the rest of "My agent"), so it's always called with
  // your own id as both the path param and requesterId.
  person: (id: number) => req<{
    person: Person; coverage: Coverage;
    surfaces: (Surface & { state: SurfaceState; label: string })[];
    claims: Claim[];
  }>(`/person/${id}?requesterId=${id}`),
  correctClaim: (id: string, note: string) =>
    req<{ claim: Claim }>(`/claim/${id}/correct`, { method: 'POST', body: JSON.stringify({ note }) }),
  exportPerson: (id: number) => req<Record<string, unknown>>(`/person/${id}/export?requesterId=${id}`),
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
  /** `apiKey`/`baseUrl`/`model` are the org's own optional credential override — omit a
   *  field to leave it untouched, pass `null` (or `''`) to clear it back to this
   *  deployment's platform default. */
  setOrgMainAgent: (
    orgId: number,
    runtimeKey: string,
    scope: 'full' | 'narrow',
    credentials?: { apiKey?: string | null; baseUrl?: string | null; model?: string | null },
  ) =>
    req<{ registered: OrgMainAgent }>(`/organizations/${orgId}/main-agent`, {
      method: 'POST',
      body: JSON.stringify({ runtimeKey, scope, ...credentials }),
    }),
  /** The personal counterpart to orgMainAgent/setOrgMainAgent, for an account with no
   *  organization — self-service, no `scope` (no approval workflow for your own
   *  credential). */
  accountMainAgent: () =>
    req<{ catalog: AgentRuntime[]; registered: AccountMainAgent | null }>('/accounts/me/main-agent'),
  setAccountMainAgent: (
    runtimeKey: string,
    credentials?: { apiKey?: string | null; baseUrl?: string | null; model?: string | null },
  ) =>
    req<{ registered: AccountMainAgent }>('/accounts/me/main-agent', {
      method: 'POST',
      body: JSON.stringify({ runtimeKey, ...credentials }),
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

  /** Same shape as the person-keyed GitHub/Jira/runtimes/ingest-tokens above, for a
   *  personal (no-org) account's own "Set up my agent" — found live, asked for directly:
   *  these tools "should be there along with" the generic connector catalog. */
  accountGithubStatus: () => req<{ connected: boolean; login: string | null }>('/accounts/me/github/status'),
  connectAccountGithub: (token: string) =>
    req<{ connected: true; login: string }>('/accounts/me/github', { method: 'POST', body: JSON.stringify({ token }) }),
  disconnectAccountGithub: () => req<{ ok: true }>('/accounts/me/github', { method: 'DELETE' }),

  accountJiraStatus: () =>
    req<{ connected: boolean; email: string | null; siteUrl: string | null }>('/accounts/me/jira/status'),
  connectAccountJira: (siteUrl: string, email: string, apiToken: string) =>
    req<{ connected: true; displayName: string }>('/accounts/me/jira', {
      method: 'POST', body: JSON.stringify({ siteUrl, email, apiToken }),
    }),
  disconnectAccountJira: () => req<{ ok: true }>('/accounts/me/jira', { method: 'DELETE' }),

  accountRuntimes: () => req<{ catalog: AgentRuntime[]; registered: PersonRuntime[] }>('/accounts/me/runtimes'),
  registerAccountRuntime: (runtimeKey: string) =>
    req<{ registered: PersonRuntime[] }>('/accounts/me/runtimes', { method: 'POST', body: JSON.stringify({ runtimeKey }) }),
  disconnectAccountRuntime: (runtimeKey: string) =>
    req<{ registered: PersonRuntime[] }>(`/accounts/me/runtimes/${runtimeKey}`, { method: 'DELETE' }),

  accountIngestTokens: () => req<{ tokens: IngestToken[] }>('/accounts/me/ingest-tokens'),
  createAccountIngestToken: (label: string) =>
    req<{ id: string; token: string }>('/accounts/me/ingest-tokens', { method: 'POST', body: JSON.stringify({ label }) }),
  revokeAccountIngestToken: (tokenId: string) =>
    req<{ tokens: IngestToken[] }>(`/accounts/me/ingest-tokens/${tokenId}`, { method: 'DELETE' }),

  /** The generic plug-and-play framework for every connector beyond GitHub/Jira/Gmail —
   *  one catalog, one connect/disconnect/status shape, driving ConnectorsPanel's dropdown
   *  and dynamic per-tool form entirely from data instead of one component per tool. */
  /** `oauth.google` is whether *this deployment* has Google OAuth credentials configured.
   *  The catalog itself is static product surface; this isn't. When it's false the server
   *  already reports the Google-backed connectors as 'coming-soon', and the panel hides
   *  the bespoke Gmail entry — otherwise "Connect Gmail" opens a tab of raw JSON. */
  connectorsCatalog: () =>
    req<{ catalog: ConnectorDef[]; oauth: { google: boolean } }>('/connectors/catalog'),
  personConnectors: (personId: number) =>
    req<{ statuses: Record<string, { connected: boolean; label: string | null }> }>(`/person/${personId}/connectors`),
  connectConnector: (personId: number, key: string, fields: Record<string, string>) =>
    req<{ connected: true; label: string }>(`/person/${personId}/connectors/${key}`, {
      method: 'POST', body: JSON.stringify(fields),
    }),
  disconnectConnector: (personId: number, key: string) =>
    req<{ ok: true }>(`/person/${personId}/connectors/${key}`, { method: 'DELETE' }),
  /** Same three, account-keyed instead of person-keyed — for a personal (no-org) account's
   *  own "Set up my agent." Same catalog (connectorsCatalog above is shared by both). */
  accountConnectors: () =>
    req<{ statuses: Record<string, { connected: boolean; label: string | null }> }>('/accounts/me/connectors'),
  connectAccountConnector: (key: string, fields: Record<string, string>) =>
    req<{ connected: true; label: string }>(`/accounts/me/connectors/${key}`, {
      method: 'POST', body: JSON.stringify(fields),
    }),
  disconnectAccountConnector: (key: string) =>
    req<{ ok: true }>(`/accounts/me/connectors/${key}`, { method: 'DELETE' }),

  ingestTokens: (personId: number) => req<{ tokens: IngestToken[] }>(`/person/${personId}/ingest-tokens`),
  createIngestToken: (personId: number, label: string) =>
    req<{ id: string; token: string }>(`/person/${personId}/ingest-tokens`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  revokeIngestToken: (personId: number, tokenId: string) =>
    req<{ tokens: IngestToken[] }>(`/person/${personId}/ingest-tokens/${tokenId}`, { method: 'DELETE' }),
};
