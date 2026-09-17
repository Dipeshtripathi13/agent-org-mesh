import type { AskedAboutYou } from './notifications';

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
export interface Account {
  id: number; name: string; email: string; mustChangePassword: boolean; emailVerified: boolean;
  /** A new signup that hasn't verified its email yet — the app shows only the verify screen. */
  emailVerificationPending: boolean;
}
/** A one-time invitation link, shown once to the admin who created it. */
export interface InviteLink { id: string; email: string; url: string; expiresAt: string; emailSent: boolean; }
export interface PendingInvitation {
  id: string; email: string; kind: 'person' | 'admin'; personName: string | null; adminRole: OrgRole | null;
  createdAt: string; expiresAt: string; emailSent: boolean;
}
export interface InvitationInfo {
  orgName: string; kind: 'person' | 'admin'; personName: string | null; personTitle: string | null;
  adminRole: OrgRole | null; email: string; invitedByName: string | null; expiresAt: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
}
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
  /** People this organization's plan allows; null means unlimited. */
  seatLimit: number | null;
}
export interface NewPerson {
  name: string; title: string; team: string; managerId: number | null; agentDeployed: boolean;
  /** Optional — sends this person a one-time invitation link to claim this chart entry. */
  email?: string;
}
export interface IngestToken {
  id: string; label: string; createdAt: string; lastUsedAt: string | null; revoked: boolean;
}
export const INGEST_SOURCES = ['claude-code', 'codex', 'gemini-cli'] as const;
export type IngestSource = typeof INGEST_SOURCES[number];

/** An account's own freely-named custom sub-agent. `sourceKey` is what
 *  POST /api/ingest/:source matches once it isn't one of the three fixed INGEST_SOURCES —
 *  generated server-side, not secret (the ingest token is still the whole auth boundary). */
export interface CustomAgent {
  id: string; sourceKey: string; name: string; purpose: string; createdAt: string;
}

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
    const body = await res.json().catch(() => null) as { error?: string; requestId?: string } | null;
    // A server failure's own message is deliberately generic; the request ID is what a person
    // can quote so the matching log line (and Sentry event) can be found.
    const message = res.status >= 500 && body?.requestId
      ? `Something went wrong on our side. Reference: ${body.requestId}`
      : body?.error ?? `${res.status} ${path}`;
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

/** What an organization's admins see about one person in its chart (GET people-details). */
export interface PersonDetails {
  personId: number;
  email: string | null;
  /** active: has a login · invited: invitation pending · invite-expired · no-login: added without an email */
  status: 'active' | 'invited' | 'invite-expired' | 'no-login';
  lastSignInAt: string | null;
  adminRole: OrgRole | null;
  invitation: { email: string; sentAt: string; expiresAt: string; emailed: boolean } | null;
  connectedTools: string[];
}

/** One of the signed-in person's chats about someone else, labelled with who it's about. */
export interface PersonConversation {
  id: string; title: string; updatedAt: string; turnCount: number;
  targetId: number; targetName: string; targetTitle: string;
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
    req<{ invite: InviteLink }>(
      `/organizations/${orgId}/admins`,
      { method: 'POST', body: JSON.stringify({ email, name, role }) },
    ),
  orgInvitations: (orgId: number) => req<{ invitations: PendingInvitation[] }>(`/organizations/${orgId}/invitations`),
  /** Admins only: each person's email, sign-in status, admin role and connected tools. */
  orgPeopleDetails: (orgId: number) => req<{ people: PersonDetails[] }>(`/organizations/${orgId}/people-details`),
  revokeInvitation: (orgId: number, invitationId: string) =>
    req<{ ok: true }>(`/organizations/${orgId}/invitations/${invitationId}`, { method: 'DELETE' }),
  invitation: (token: string) => req<{ invitation: InvitationInfo }>(`/invitations/${token}`),
  acceptInvitation: (token: string) =>
    req<{ accepted: true; orgId: number; kind: 'person' | 'admin' }>(`/invitations/${token}/accept`, { method: 'POST' }),
  verifyEmail: (token: string) =>
    req<{ verified: true }>('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }),
  resendVerification: () =>
    req<{ sent: boolean; alreadyVerified?: boolean }>('/auth/verify-email/resend', { method: 'POST' }),
  requestPasswordReset: (email: string) =>
    req<{ ok: true; message: string }>('/auth/password-reset/request', { method: 'POST', body: JSON.stringify({ email }) }),
  confirmPasswordReset: (token: string, newPassword: string) =>
    req<{ reset: true }>('/auth/password-reset/confirm', { method: 'POST', body: JSON.stringify({ token, newPassword }) }),
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
    req<{ person: Person; invite: InviteLink | null }>(
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
  /** Who's asking is always the logged-in session's own identity — never sent from here. */
  query: (targetId: number, role: string, persist = false, question = '') =>
    req<{ response: AgentResponse }>('/query', {
      method: 'POST',
      body: JSON.stringify({ targetId, role, persist, question }),
    }),
  /** No `window`/time-range param — the router (server.ts's gatherAll) now infers how far
   *  back to look per connected surface from the question's own wording, replacing a fixed
   *  "Today / This week" toggle found live not to scale to hundreds of connected tools. */
  agentAsk: (targetId: number, role: string, question: string, persist = false, conversationId?: string) =>
    req<{
      answer: string; items: ResponseItem[]; withheldCount: number; coverage: AgentResponse['coverage'];
      conversationId?: string;
      /** Real tools the router actually called for this question (e.g. ["Claude Code",
       *  "Gmail"]) — empty when the answer came purely from what was already on file. */
      consultedSources: string[];
    }>('/agent/ask', {
      method: 'POST',
      body: JSON.stringify({ targetId, role, question, persist, conversationId }),
    }),
  /** One question, one update covering several freely-chosen people at once — the
   *  multi-target sibling of agentAsk. `targetIds` is a real, open choice (a CEO picking
   *  the Eng manager and the Fin manager, say), unlike a single agentAsk's one `targetId`.
   *  One claimed `role` applies to every target, checked independently per target
   *  server-side — a target it isn't truthful for comes back as its own visible rejection
   *  in `perPerson` (`ok: false`, with a real `reason`), never silently dropped. */
  askMulti: (question: string, role: string, targetIds: number[], persist = false) =>
    req<{
      answer: string;
      askedCount: number;
      rejectedCount: number;
      perPerson: (
        | { personId: number; name: string; ok: true; answer: string; withheldCount: number; coverage: AgentResponse['coverage']; consultedSources: string[] }
        | { personId: number; name: string | null; ok: false; reason: string }
      )[];
    }>('/agent/ask-multi', {
      method: 'POST',
      body: JSON.stringify({ question, role, targetIds, persist }),
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
  /** The top-bar bell: asks by other people about any of this account's own people. */
  notifications: () => req<{ items: AskedAboutYou[]; unreadCount: number }>('/notifications'),
  /** Marks read up to the newest notification actually shown (never "now", so an ask that
   *  lands while the list is open still counts as unread). */
  markNotificationsSeen: (through: string) =>
    req<{ ok: true }>('/notifications/seen', { method: 'POST', body: JSON.stringify({ through }) }),
  /** Every chat you've had about other people in this organization, newest first. */
  myConversations: (orgId: number) => req<{ conversations: PersonConversation[] }>(`/agent/conversations/mine?orgId=${orgId}`),
  /** Hides one of your Ask chats from your own lists; the record itself is permanent. */
  hideConversation: (orgId: number, conversationId: string) =>
    req<{ ok: true }>(`/agent/conversations/${conversationId}?orgId=${orgId}`, { method: 'DELETE' }),
  listConversations: (targetId: number) => req<{
    conversations: { id: string; title: string; updatedAt: string; turnCount: number }[];
  }>(`/agent/conversations?targetId=${targetId}`),
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
  acknowledgeEscalation: (id: string) =>
    req<{ escalation: Escalation }>(`/escalations/${id}/acknowledge`, { method: 'POST' }),
  resolveEscalation: (id: string) =>
    req<{ escalation: Escalation }>(`/escalations/${id}/resolve`, { method: 'POST' }),
  connections: (orgId: number) => req<{ connectors: ConnectorStats[]; neverIngested: string[] }>(`/connections?orgId=${orgId}`),
  cycleSurface: (personId: number, surfaceKey: string) =>
    req<{ person: Person; coverage: Coverage }>(`/person/${personId}/surface/cycle`, {
      method: 'POST',
      body: JSON.stringify({ surfaceKey }),
    }),
  // A self-view (raw claims, ids and all) — the backend requires the logged-in session's
  // own identity to be exactly this person.
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

  /** Your own freely-named custom sub-agent — a finance agent, a marketing agent,
   *  anything you describe for yourself — generalizing the fixed claude-code/codex/
   *  gemini-cli ingest sources into an open-ended one. Pushes events the same way those
   *  three do, authenticated by the same ingest tokens above, just under its own
   *  `sourceKey` instead of one of the three fixed names. Account-only. */
  customAgents: () => req<{ agents: CustomAgent[] }>('/accounts/me/custom-agents'),
  createCustomAgent: (name: string, purpose: string) =>
    req<{ agent: CustomAgent }>('/accounts/me/custom-agents', { method: 'POST', body: JSON.stringify({ name, purpose }) }),
  deleteCustomAgent: (id: string) =>
    req<{ agents: CustomAgent[] }>(`/accounts/me/custom-agents/${id}`, { method: 'DELETE' }),

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
  /** A real, on-demand "does this credential still work" check — not just "is one stored."
   *  Makes the same real API call the org's own main agent would make on the next real ask,
   *  right now, against a window narrow enough to almost never return anything new — a
   *  working credential resolves, a revoked one or a vendor-side breaking change throws. */
  verifyConnector: (personId: number, key: string) =>
    req<{ ok: boolean; checkedAt: string; error?: string }>(`/person/${personId}/connectors/${key}/verify`, { method: 'POST' }),
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
  verifyAccountConnector: (key: string) =>
    req<{ ok: boolean; checkedAt: string; error?: string }>(`/accounts/me/connectors/${key}/verify`, { method: 'POST' }),

  ingestTokens: (personId: number) => req<{ tokens: IngestToken[] }>(`/person/${personId}/ingest-tokens`),
  createIngestToken: (personId: number, label: string) =>
    req<{ id: string; token: string }>(`/person/${personId}/ingest-tokens`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  revokeIngestToken: (personId: number, tokenId: string) =>
    req<{ tokens: IngestToken[] }>(`/person/${personId}/ingest-tokens/${tokenId}`, { method: 'DELETE' }),
};
