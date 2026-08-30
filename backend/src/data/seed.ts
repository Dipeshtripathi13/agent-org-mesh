import type {
  AgentRuntime,
  Claim,
  EscalationRecord,
  Evidence,
  OrgMainAgent,
  Person,
  PersonRuntime,
  Surface,
  SurfaceKey,
  SurfaceState,
} from '../domain/types.js';

/* ---------- surfaces ---------- */

export const SURFACES: Surface[] = [
  {
    key: 'github',
    name: 'GitHub',
    feedsTier: 'T1',
    reads: 'Pull requests, reviews and commit metadata',
    doesNotRead: 'File contents are never stored',
  },
  {
    key: 'jira',
    name: 'Jira',
    feedsTier: 'T1',
    reads: 'Issues you are assigned or watching',
    doesNotRead: 'Read at query time, never cached',
  },
  {
    key: 'salesforce',
    name: 'Salesforce',
    feedsTier: 'T1',
    reads: 'Opportunities and renewal records',
    doesNotRead: 'Contact personal details',
  },
  {
    key: 'calendar',
    name: 'Calendar',
    feedsTier: 'T2',
    reads: 'Busy blocks and event titles',
    doesNotRead: 'Attendee lists for meetings you do not organise',
  },
  {
    key: 'slack',
    name: 'Slack',
    feedsTier: 'T3',
    reads: 'Public channels you post in — signals only',
    doesNotRead: 'Direct messages, ever, for anyone',
  },
  {
    key: 'confluence',
    name: 'Confluence',
    feedsTier: 'T2',
    reads: 'Pages you authored or edited',
    doesNotRead: 'Spaces without an explicit grant',
  },
  {
    key: 'linear',
    name: 'Linear',
    feedsTier: 'T1',
    reads: 'Issues assigned to you and their status',
    doesNotRead: 'Issues in projects you have no membership in',
  },
  {
    key: 'notion',
    name: 'Notion',
    feedsTier: 'T2',
    reads: 'Pages you authored or last edited, shared with the integration',
    doesNotRead: 'Any page the workspace integration was not explicitly granted',
  },
  {
    key: 'asana',
    name: 'Asana',
    feedsTier: 'T1',
    reads: 'Tasks assigned to you and their status',
    doesNotRead: 'Tasks in projects you are not a member of',
  },
  {
    key: 'gitlab',
    name: 'GitLab',
    feedsTier: 'T1',
    reads: 'Merge requests and reviews, same shape as GitHub',
    doesNotRead: 'File contents are never stored',
  },
  {
    key: 'hubspot',
    name: 'HubSpot',
    feedsTier: 'T1',
    reads: 'Deals and activity you own',
    doesNotRead: 'Contact personal details',
  },
  {
    key: 'zendesk',
    name: 'Zendesk',
    feedsTier: 'T1',
    reads: 'Tickets assigned to you and their status',
    doesNotRead: 'Customer contact details',
  },
  {
    key: 'trello',
    name: 'Trello',
    feedsTier: 'T2',
    reads: 'Cards assigned to you on boards you belong to',
    doesNotRead: 'Boards you are not a member of',
  },
  {
    key: 'airtable',
    name: 'Airtable',
    feedsTier: 'T2',
    reads: 'Records in bases the connection was granted access to',
    doesNotRead: 'Any base not explicitly shared with the connection',
  },
  {
    key: 'monday',
    name: 'Monday.com',
    feedsTier: 'T2',
    reads: 'Items assigned to you and their status',
    doesNotRead: 'Boards you are not a member of',
  },
  {
    key: 'figma',
    name: 'Figma',
    feedsTier: 'T2',
    reads: 'Comments and file activity on files shared with you',
    doesNotRead: 'File contents beyond comment threads',
  },
  {
    key: 'discord',
    name: 'Discord',
    feedsTier: 'T3',
    reads: 'Public channels the connected bot can see — signals only',
    doesNotRead: 'Direct messages, ever, for anyone',
  },
  {
    key: 'microsoft365',
    name: 'Microsoft 365',
    feedsTier: 'T2',
    reads: 'Outlook calendar and Teams activity',
    doesNotRead: 'Email contents, ever',
  },
  {
    key: 'zoom',
    name: 'Zoom',
    feedsTier: 'T2',
    reads: 'Meeting attendance and scheduling metadata',
    doesNotRead: 'Recordings or transcripts',
  },
  {
    key: 'dropbox',
    name: 'Dropbox',
    feedsTier: 'T2',
    reads: 'File and folder activity in shared spaces',
    doesNotRead: 'File contents are never stored',
  },
  {
    key: 'claude-code',
    name: 'Claude Code',
    feedsTier: 'T2',
    reads: 'Local development session activity — commands run, files edited',
    doesNotRead: 'Source code contents; only action metadata',
  },
  {
    key: 'codex',
    name: 'Codex CLI',
    feedsTier: 'T2',
    reads: 'Command and file-editing tool calls, pushed by a hook this person configured',
    doesNotRead: 'Anything not explicitly pushed — no local file or session access',
  },
  {
    key: 'gemini-cli',
    name: 'Gemini CLI',
    feedsTier: 'T2',
    reads: 'Command and file-editing tool calls, pushed by a hook this person configured',
    doesNotRead: 'Anything not explicitly pushed — no local file or session access',
  },
];

/** Never registered as connectors. There is no code path that ingests these. */
export const NEVER_INGESTED = [
  'Workday — compensation & performance',
  'Workday — terminations & PIPs',
  'Ironclad — legal matters under hold',
  'Benefits & occupational health',
  'Direct messages, all platforms',
];

/* ---------- people ---------- */

const S = ['github', 'jira', 'salesforce', 'calendar', 'slack', 'confluence', 'claude-code'] as const;
const CODE: Record<string, SurfaceState> = {
  c: 'connected',
  p: 'partial',
  s: 'stale',
  d: 'absent',
  '-': 'outOfScope',
};

type Row = [number, string, string, number | null, string, string];

// Claude Code is out of scope for everyone except Diego (11) — he's the one person in this
// demo with a real, registered Claude Code sub-agent (see PERSON_RUNTIMES below), so he's
// the only one it's genuinely in scope to connect.
const RAW: Row[] = [
  [1, 'Marta Vieira', 'CEO', null, 'Executive', '--cccp-'],
  [2, 'Dev Raghunathan', 'CTO', 1, 'Executive', 'cc-ccp-'],
  [3, 'Priya Anand', 'VP Engineering', 2, 'Engineering', 'cc-ccc-'],
  [4, 'Tom Beckett', 'VP Sales', 1, 'Revenue', '--cpsp-'],
  [5, 'Elena Fischer', 'VP Finance & Ops', 1, 'Operations', '--pcpp-'],
  [6, 'Owen Marsh', 'Director, IT & Security', 2, 'IT', 'cp-ccc-'],
  [7, 'Marcus Reyes', 'Director, Platform Infrastructure', 3, 'Platform', 'cc-ccp-'],
  [8, 'Sofia Almeida', 'Director, Payments', 3, 'Payments', 'cc-cpp-'],
  [9, 'Jonas Weber', 'Director, Growth Engineering', 3, 'Growth', 'cc-ccs-'],
  [10, 'Hana Oyelaran', 'Engineering Manager, Payments', 8, 'Payments', 'cc-ccp-'],
  [11, 'Diego Okonjo', 'Staff Engineer', 10, 'Payments', 'cc-psdc'],
  [12, 'Amara Lindqvist', 'Senior Engineer', 10, 'Payments', 'cc-ccc-'],
  [13, 'Ruben Castellanos', 'Senior Engineer', 10, 'Payments', 'cs-pdd-'],
  [14, 'Yuki Tanaka', 'Engineer', 10, 'Payments', 'cc-cpd-'],
  [15, 'Noor Haddad', 'Engineer', 10, 'Payments', 'cc-ccp-'],
  [16, 'Felix Brandt', 'QA Engineer', 10, 'Payments', 'cp-csd-'],
  [17, 'Ivy Chen', 'Engineering Manager, Platform', 7, 'Platform', 'cc-ccc-'],
  [18, 'Samuel Adeyemi', 'Staff Engineer', 17, 'Platform', 'cc-ccp-'],
  [19, 'Lena Vogt', 'Senior Engineer', 17, 'Platform', 'cc-cpc-'],
  [20, 'Omar Nasser', 'Engineer', 17, 'Platform', 'cc-ccd-'],
  [21, 'Grace Mbeki', 'Engineer', 17, 'Platform', 'cc-ccc-'],
  [22, 'Tobias Lindgren', 'Site Reliability Engineer', 17, 'Platform', 'cc-csp-'],
  [23, 'Aisha Rahman', 'Engineering Manager, Growth', 9, 'Growth', 'cc-ccp-'],
  [24, 'Petra Nowak', 'Senior Engineer', 23, 'Growth', 'cc-cpp-'],
  [25, 'Kenji Mori', 'Engineer', 23, 'Growth', 'cc-pdd-'],
  [26, 'Clara Duarte', 'Engineer', 23, 'Growth', 'cc-ccc-'],
  [27, 'Nathan Ellis', 'Data Engineer', 23, 'Growth', 'cs-csd-'],
  [28, 'Zoe Ferrand', 'Director, Product', 2, 'Product', '-c-ccp-'],
  [29, 'Ravi Menon', 'Product Manager, Payments', 28, 'Payments', '-c-ccp-'],
  [30, 'Ingrid Solberg', 'Product Manager, Platform', 28, 'Platform', '-c-ccc-'],
  [31, 'Hugo Silva', 'Design Lead', 28, 'Design', '-c-ccs-'],
  [32, 'Mei Lin', 'Product Designer', 31, 'Design', '-c-cps-'],
  [33, 'Karim Bousaid', 'Enterprise Account Executive', 4, 'Revenue', '--cccp-'],
  [34, 'Sarah Whitfield', 'Enterprise Account Executive', 4, 'Revenue', '--csdp-'],
  [35, 'Luis Ortega', 'Solutions Engineer', 4, 'Revenue', '-c-ccp-'],
  [36, 'Emma Novak', 'Customer Success Lead', 4, 'Revenue', '-ccccp-'],
  [37, 'Daniel Kovac', 'Support Engineer', 36, 'Support', '-cpccd-'],
  [38, 'Anja Petrova', 'Finance Analyst', 5, 'Operations', '--pcpd-'],
  [39, 'Ben Kowalski', 'IT Systems Administrator', 6, 'IT', 'cc-ccc-'],
  [40, 'Rosa Iglesias', 'People Ops Partner', 5, 'Operations', '-------'],
];

/** People Ops is excluded from the mesh at deployment. */
const NO_AGENT = new Set([40]);

export const PEOPLE: Person[] = RAW.map(([id, name, title, managerId, team, codes]) => {
  const surfaces = {} as Record<SurfaceKey, SurfaceState>;
  S.forEach((key, i) => {
    surfaces[key] = CODE[codes[i]];
  });
  // Not part of the RAW encoding — like claude-code, out of scope for everyone until a
  // real self-service token connects one (see EMPTY_SURFACES in repo.ts for new people).
  surfaces.codex = 'outOfScope';
  surfaces['gemini-cli'] = 'outOfScope';
  // The 14 newer connectors (linear.ts and friends) are real, self-service-connectable
  // tools too, but nobody in this seeded 40-person demo has actually connected one —
  // 'absent' matches how salesforce/calendar/slack/confluence already default for anyone
  // who hasn't connected them, not 'outOfScope' (which means "doesn't apply to this
  // role," untrue here — any of these genuinely could apply, none happen to be wired up
  // for this fictional roster).
  (['linear', 'notion', 'asana', 'gitlab', 'hubspot', 'zendesk', 'trello', 'airtable', 'monday', 'figma', 'discord', 'microsoft365', 'zoom', 'dropbox'] as const)
    .forEach((key) => { surfaces[key] = 'absent'; });
  return { id, name, title, team, managerId, agentDeployed: !NO_AGENT.has(id), surfaces };
});

const INDEX = new Map(PEOPLE.map((p) => [p.id, p]));
export function byId(id: number): Person {
  const person = INDEX.get(id);
  if (!person) throw new Error(`No person ${id}`);
  return person;
}

export function children(id: number): Person[] {
  return PEOPLE.filter((p) => p.managerId === id);
}

/* ---------- evidence ---------- */

export const EVIDENCE: Record<string, Evidence> = {
  'PAY-2290': {
    id: 'PAY-2290',
    kind: 'system of record',
    title: 'Vendor sandbox key blocked for payments migration',
    connector: 'jira',
    recordedAt: '2026-08-02T09:15:00Z',
    excerpt:
      'Still waiting on sandbox credentials from the vendor — nothing we can do our side until they land.',
    note: 'Age is part of the evidence: 11 days blocked is what triggered rule ESC-BLOCK-10D. The subject was notified at the same instant as their manager.',
    externalRef: 'https://example.invalid/jira/PAY-2290',
  },
  'PR-2184': {
    id: 'PR-2184',
    kind: 'system of record',
    title: 'payments-core: route saved cards through vendor client',
    connector: 'github',
    recordedAt: '2026-08-10T14:22:00Z',
    excerpt: 'Blocking: this path still calls the legacy tokenizer for saved cards.',
    note: 'If the artifact stops resolving at read time, the claim is downgraded rather than shown. No link, no T1.',
    externalRef: 'https://example.invalid/github/pr/2184',
  },
  'REVIEW-0811': {
    id: 'REVIEW-0811',
    kind: 'semi-structured',
    title: 'Design review transcript, 41:12–41:38',
    connector: 'calendar',
    recordedAt: '2026-08-11T15:41:00Z',
    excerpt: 'I think 4.3 is fine, assuming the vendor thing clears this week.',
    note: 'T2 names the occasion and quotes verbatim. Phrased as reported, never as status. No sentiment or participation is derived from a transcript.',
    externalRef: 'https://example.invalid/transcripts/0811',
  },
  'ACV-3391': {
    id: 'ACV-3391',
    kind: 'system of record',
    title: 'Meridian Retail — renewal dependent on payments migration',
    connector: 'salesforce',
    recordedAt: '2026-08-09T10:02:00Z',
    excerpt: 'Customer will not sign the renewal until saved-card tokenisation is live.',
    note: 'Read via a Revenue agent. Slack is disconnected there, so nothing about the negotiation tone is available — and nothing was inferred.',
    externalRef: 'https://example.invalid/crm/ACV-3391',
  },
  'SIGNAL-0812': {
    id: 'SIGNAL-0812',
    kind: 'unstructured inference · unverified',
    title: 'Inference from Slack — not a fact',
    connector: 'slack',
    recordedAt: '2026-08-12T17:30:00Z',
    excerpt: "they've pushed twice already, so I'd plan for it moving again",
    note: 'Shown so a human can decide whether to ask. Never counted, charted, escalated on its own, or used to characterise a person. The subject sees this signal in their own timeline the moment it forms.',
    externalRef: 'https://example.invalid/slack/thread/0812',
  },
};

/* ---------- escalations ---------- */
/** What the mesh pushed upward on its own. Paths are derived from real reporting lines.
 *  `createdAt`/`acknowledgedAt`/`resolvedAt` are computed relative to whenever `npm run
 *  db:seed` actually runs, not baked in at authoring time — so "11 days ago" stays true
 *  no matter when the seed loads. These five rows are narrative demo content (the vendor
 *  blocker, the renewal, the PR review) — the real detection rules in domain/escalations.ts
 *  only fire from state this system actually observes; see docs/escalation-triage.md §2. */

const name = (id: number) => byId(id).name;
const path = (...ids: number[]) => ids.map((id) => ({ personId: id, name: name(id) }));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();

export const ESCALATIONS: EscalationRecord[] = [
  {
    id: 'esc-1',
    kind: 'T1',
    title: 'Vendor sandbox key has blocked payments migration for 11 days',
    detail:
      'PAY-2290 has not moved since 2026-08-02. Two vendor follow-ups recorded. The 4.3 release date depends on it.',
    personId: 11,
    evidenceId: 'PAY-2290',
    rule: 'ESC-BLOCK-10D',
    path: path(11, 10, 8),
    status: 'open',
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: daysAgo(11),
  },
  {
    id: 'esc-2',
    kind: 'T1',
    title: 'Renewal contingent on a blocked migration',
    detail:
      "Meridian Retail's renewal (ACV-3391) is tied to tokenisation shipping. Two agents connected the ticket and the opportunity; neither owner had seen the other's record.",
    personId: 34,
    evidenceId: 'ACV-3391',
    rule: 'ESC-XFN-DEP',
    path: path(34, 4),
    status: 'acknowledged',
    acknowledgedBy: 4, // Tom Beckett, VP Sales
    acknowledgedAt: hoursAgo(2),
    resolvedBy: null,
    resolvedAt: null,
    createdAt: daysAgo(4),
  },
  {
    id: 'esc-3',
    kind: 'T1',
    title: 'Review has been open 6 days past team norm',
    detail: 'PR#2184 has one unresolved blocking comment. Norm for payments-core is 2 days.',
    personId: 11,
    evidenceId: 'PR-2184',
    rule: 'ESC-REVIEW-AGE',
    path: path(11, 10),
    status: 'acknowledged',
    acknowledgedBy: 10, // Hana Oyelaran, direct manager
    acknowledgedAt: daysAgo(1),
    resolvedBy: null,
    resolvedAt: null,
    createdAt: daysAgo(6),
  },
  {
    id: 'esc-4',
    kind: 'CANT',
    title: 'Escalation formed but not delivered',
    detail:
      "A blocker on Ruben Castellanos's work was detected, but coverage is 40% — Jira is stale and Slack and Confluence are absent. The mesh escalated the coverage gap instead of the blocker, to avoid asserting something it cannot support.",
    personId: 13,
    evidenceId: null,
    rule: 'ESC-COVERAGE',
    path: path(13, 6),
    status: 'open',
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedBy: null,
    resolvedAt: null,
    createdAt: daysAgo(2),
  },
  {
    id: 'esc-5',
    kind: 'T2',
    title: 'Growth reported a dependency on the payments work',
    detail:
      'Reported in the 08-10 planning session; no ticket links the two workstreams, so this stays hedged.',
    personId: 25,
    evidenceId: 'REVIEW-0811',
    rule: 'ESC-DEP-REPORTED',
    path: path(25, 23, 9),
    status: 'acknowledged',
    acknowledgedBy: 9, // Jonas Weber, skip-level
    acknowledgedAt: daysAgo(3),
    resolvedBy: null,
    resolvedAt: null,
    createdAt: daysAgo(5),
  },
];

/* ---------- claims ---------- */

export const CLAIMS: Claim[] = [
  {
    id: 'c-11-1',
    personId: 11,
    tier: 'T1',
    dataClass: 'Open',
    text: 'The payments migration is blocked on a vendor sandbox key. PAY-2290 has been in a blocked state for 11 days.',
    evidenceId: 'PAY-2290',
    sourceSurface: 'jira',
    derivedAt: '2026-08-13T09:12:00Z',
    supersededBy: null,
  },
  {
    id: 'c-11-2',
    personId: 11,
    tier: 'T1',
    dataClass: 'Internal',
    text: 'PR#2184 in payments-core is open with one blocking review comment on the saved-card path.',
    evidenceId: 'PR-2184',
    sourceSurface: 'github',
    derivedAt: '2026-08-13T09:12:00Z',
    supersededBy: null,
  },
  {
    id: 'c-11-3',
    personId: 11,
    tier: 'T2',
    dataClass: 'Internal',
    text: 'Reported as on track for the 4.3 cut in the 2026-08-11 design review. Not confirmed against a ticket.',
    evidenceId: 'REVIEW-0811',
    sourceSurface: 'calendar',
    derivedAt: '2026-08-13T09:12:00Z',
    supersededBy: null,
  },
  {
    id: 'c-11-4',
    personId: 11,
    tier: 'T3',
    dataClass: 'Sensitive',
    text: 'Language in two Slack threads suggests the vendor date may slip again. No record confirms this — treat as a prompt to ask, not as status.',
    evidenceId: 'SIGNAL-0812',
    sourceSurface: 'slack',
    derivedAt: '2026-08-12T17:30:00Z',
    supersededBy: null,
  },
  {
    id: 'c-13-1',
    personId: 13,
    tier: 'T1',
    dataClass: 'Open',
    text: 'Two commits landed on the tokenisation branch this week.',
    evidenceId: 'PR-2184',
    sourceSurface: 'github',
    derivedAt: '2026-08-13T09:00:00Z',
    supersededBy: null,
  },
  {
    id: 'c-13-2',
    personId: 13,
    tier: 'T3',
    dataClass: 'Internal',
    text: 'Slack discussion suggests a dependency on the payments work.',
    evidenceId: 'SIGNAL-0812',
    sourceSurface: 'slack',
    derivedAt: '2026-08-13T09:00:00Z',
    supersededBy: null,
  },
  {
    id: 'c-34-1',
    personId: 34,
    tier: 'T1',
    dataClass: 'Sensitive',
    text: "Meridian Retail's renewal is contingent on tokenisation shipping — ACV-3391.",
    evidenceId: 'ACV-3391',
    sourceSurface: 'salesforce',
    derivedAt: '2026-08-12T18:20:00Z',
    supersededBy: null,
  },
];

/* ---------- agent runtimes ---------- */
/** Org-wide catalog. Every person registers from the same list. */

export const RUNTIME_CATALOG: AgentRuntime[] = [
  {
    key: 'claude-sonnet',
    name: 'Claude',
    vendor: 'Anthropic',
    contextWindow: '200k',
    host: 'Northbeam tenant · eu-west-1',
    approved: true,
    blocked: false,
    reads: 'All in-scope surfaces',
    note: 'Org default. Enterprise agreement covers zero-retention inference.',
    apiFamily: 'anthropic',
    mainEligible: true,
  },
  {
    key: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    contextWindow: '200k',
    host: 'Developer workstation · local',
    approved: true,
    blocked: false,
    reads: 'GitHub and Jira only',
    note: 'Runs beside your editor. Still read-only to the mesh.',
    apiFamily: 'anthropic',
    mainEligible: false, // development tool scoped to GitHub/Jira — sub-agent only, never the org-facing aggregator
  },
  {
    key: 'chatgpt',
    name: 'ChatGPT',
    vendor: 'OpenAI',
    contextWindow: '128k',
    host: 'Northbeam tenant · us-east-1',
    approved: true,
    blocked: false,
    reads: 'All in-scope surfaces',
    note: 'Approved for Open and Internal classes. Sensitive-class claims are withheld from this runtime by policy.',
    apiFamily: 'openai-compatible',
    mainEligible: true,
  },
  {
    key: 'copilot',
    name: 'GitHub Copilot',
    vendor: 'GitHub',
    contextWindow: '64k',
    host: 'GitHub Enterprise',
    approved: true,
    blocked: false,
    reads: 'GitHub only',
    note: 'Repository context only. Cannot see Jira, calendar, or Slack.',
    apiFamily: 'unsupported',
    mainEligible: false,
  },
  {
    key: 'gemini',
    name: 'Gemini',
    vendor: 'Google',
    contextWindow: '1M',
    host: 'Workspace tenant · eu',
    approved: true,
    blocked: false,
    reads: 'Calendar and Confluence',
    note: 'Strong on long documents; approved for T2 surfaces only.',
    apiFamily: 'unsupported',
    mainEligible: false,
  },
  {
    // The vehicle for "bring your own self-hosted/open-source endpoint" — a global,
    // vendor-neutral catalog entry (runtime_catalog is shared across every org, so its
    // copy can never assume one organization's specific infrastructure). Any org can pick
    // this and supply its own baseUrl/apiKey/model override (org_main_agent's credential
    // columns, resolved by runtimeProvider.ts's resolveCredentials) to point at Ollama,
    // vLLM, or a company-run model — same OpenAI-compatible wire protocol as chatgpt,
    // no separate integration code needed.
    key: 'llama-local',
    name: 'Self-hosted (OpenAI-compatible)',
    vendor: 'Your own infrastructure',
    contextWindow: 'varies by model',
    host: 'Your own network — set per organization',
    approved: true,
    blocked: false,
    reads: 'All in-scope surfaces',
    note: 'Point at any OpenAI-compatible endpoint you run — Ollama, vLLM, or a company-hosted model. Requires your organization\'s own API key and endpoint URL below.',
    apiFamily: 'openai-compatible',
    mainEligible: true,
  },
  {
    key: 'mistral',
    name: 'Mistral Large',
    vendor: 'Mistral AI',
    contextWindow: '128k',
    host: 'Northbeam tenant · eu-west-3',
    approved: false,
    blocked: false,
    reads: 'nothing until approved',
    note: 'Not yet approved by IT & Security. Registering files a request; nothing connects until sign-off.',
    apiFamily: 'unsupported',
    mainEligible: false,
  },
  {
    key: 'grok',
    name: 'Grok',
    vendor: 'xAI',
    contextWindow: '128k',
    host: 'Vendor cloud',
    approved: false,
    blocked: true,
    reads: 'nothing — cannot be registered',
    note: 'No data-processing agreement on file. IT must sign a DPA before this can be requested at all.',
    apiFamily: 'unsupported',
    mainEligible: false,
  },
];

/** Mutable: registering or disconnecting a sub-agent edits this in place. Every entry
 *  here is a personal sub-agent — the org's one main agent is ORG_MAIN_AGENT below. */
export const PERSON_RUNTIMES: Record<number, PersonRuntime[]> = {
  11: [
    { runtimeKey: 'claude-code', scope: 'full', addedAt: '2026-07-22' },
  ],
};

/** The one seeded org's (Northbeam) admin-set main agent — set once by seed-db.ts, same
 *  as what used to be Diego's personal main-agent registration before that concept moved
 *  to the org level. */
export const ORG_MAIN_AGENT: OrgMainAgent = {
  runtimeKey: 'claude-sonnet',
  scope: 'full',
  addedAt: '2026-07-14',
  apiKeyEncrypted: null,
  baseUrl: null,
  model: null,
};
