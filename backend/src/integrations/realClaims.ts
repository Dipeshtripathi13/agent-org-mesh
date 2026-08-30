import * as repo from '../db/repo.js';
import type { Claim, Evidence, SurfaceKey } from '../domain/types.js';
import { formatClaudeCodeDigest, getClaudeCodeActivitySince } from './claudeCodeActivity.js';
import { formatIngestedEventsDigest, getEventsSince } from './eventIngestion.js';
import { getGithubConnection } from './githubConnection.js';
import { formatGithubDigest, getRecentGithubActivity, type GithubActivityItem } from './github.js';
import { getJiraConnection } from './jiraConnection.js';
import { formatJiraDigest, getRecentJiraActivity, type JiraActivityItem } from './jira.js';
import { getMainProvider } from './runtimeProvider.js';
import { getLinearConnection, formatLinearDigest, getRecentLinearActivity } from './linear.js';
import { getNotionConnection, formatNotionDigest, getRecentNotionActivity } from './notion.js';
import { getConfluenceConnection, formatConfluenceDigest, getRecentConfluenceActivity } from './confluence.js';
import { getAsanaConnection, formatAsanaDigest, getRecentAsanaActivity } from './asana.js';
import { getGitlabConnection, formatGitlabDigest, getRecentGitlabActivity } from './gitlab.js';
import { getHubspotConnection, formatHubspotDigest, getRecentHubspotActivity } from './hubspot.js';
import { getZendeskConnection, formatZendeskDigest, getRecentZendeskActivity } from './zendesk.js';
import { formatCalendarDigest, getRecentCalendarActivity } from './googleCalendar.js';

/**
 * This is the piece that makes the org mesh's manager-facing "Ask" actually real for one
 * person: it turns Diego's genuine Claude Code session activity into an actual Claim row,
 * exactly the same shape as the seeded GitHub/Jira claims, so it flows through the
 * unmodified deterministic policy engine (respond() in policy.ts) like any other claim.
 * An LLM may draft the claim's *text* when configured; it never touches tier, dataClass,
 * or disclosure — those stay code, not a prompt, per CLAUDE.md rule 1.
 *
 * Idempotent per day: the claim id is keyed to today's date regardless of the gather
 * window, so asking "today" and then "this week" on the same day refreshes the same row
 * with the freshest gather rather than leaving two overlapping claims sitting side by
 * side in the disclosure list. Whichever window was asked most recently wins for today.
 */

const startOfToday = () => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

function deterministicClaimText(digest: { actions: string[]; filesTouched: string[] }): string {
  const lastAction = digest.actions.at(-1);
  const parts = [
    `${digest.filesTouched.length} file${digest.filesTouched.length === 1 ? '' : 's'} touched`,
    `${digest.actions.length} action${digest.actions.length === 1 ? '' : 's'} logged`,
  ];
  const tail = lastAction ? ` — most recently: ${lastAction}.` : '.';
  return `Claude Code session activity: ${parts.join(', ')}${tail}`;
}

/** No-op if this person doesn't have Claude Code connected as a real, in-scope surface —
 *  ingestion only ever runs for someone who has genuinely opted into it. `since` defaults
 *  to today, matching the original single-source behavior. */
export async function ingestClaudeCodeClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces['claude-code'] !== 'connected') return;

  const activity = await getClaudeCodeActivitySince(since, personId);
  const digest = formatClaudeCodeDigest(activity);
  if (!digest) return; // nothing real happened in this window — assert nothing

  const today = new Date().toISOString().slice(0, 10);
  const windowLabel = since.toISOString().slice(0, 10);
  const id = `auto-claudecode-${personId}-${today}`;
  const evidence: Evidence = {
    id,
    kind: 'session activity',
    title: `Claude Code session activity — since ${windowLabel}`,
    connector: 'claude-code',
    recordedAt: new Date().toISOString(),
    excerpt: digest.slice(0, 240),
    note: 'Auto-ingested from local Claude Code session transcripts on this machine. Read-only — nothing here is inferred beyond what the session log shows.',
    externalRef: 'local-claude-code-session-log',
  };
  await repo.upsertEvidence(orgId, evidence);

  const { provider } = await getMainProvider(orgId);
  const text = provider?.configured()
    ? await provider.writeClaim(person.name, digest)
    : deterministicClaimText(activity);

  const claim: Claim = {
    id,
    personId,
    tier: 'T2',
    dataClass: 'Internal',
    text,
    evidenceId: evidence.id,
    sourceSurface: 'claude-code',
    derivedAt: new Date().toISOString(),
    supersededBy: null,
  };
  await repo.upsertClaim(orgId, claim);
}

function deterministicGithubClaimText(items: GithubActivityItem[]): string {
  const authored = items.filter((i) => i.kind === 'authored').length;
  const reviewed = items.filter((i) => i.kind === 'reviewed').length;
  const parts = [
    authored ? `${authored} pull request${authored === 1 ? '' : 's'} opened or updated` : null,
    reviewed ? `${reviewed} review${reviewed === 1 ? '' : 's'} given` : null,
  ].filter((p): p is string => p != null);
  const last = items[0];
  return `GitHub activity: ${parts.join(', ')}${last ? ` — most recently: "${last.title}" in ${last.repo}.` : '.'}`;
}

/** No-op if this person doesn't have a real, connected GitHub token — same shape as
 *  ingestClaudeCodeClaim, one more ResourceProvider plugged into the same claim pipeline.
 *  `tier: 'T1'` matches github's declared feedsTier in surfaces_catalog. */
export async function ingestGithubClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces.github !== 'connected') return;

  const conn = await getGithubConnection(personId);
  if (!conn) return;

  const activity = await getRecentGithubActivity(conn.token, conn.login, since);
  const digest = formatGithubDigest(activity);
  if (!digest) return; // nothing real happened in this window — assert nothing

  const today = new Date().toISOString().slice(0, 10);
  const windowLabel = since.toISOString().slice(0, 10);
  const id = `auto-github-${personId}-${today}`;
  const evidence: Evidence = {
    id,
    kind: 'pull request activity',
    title: `GitHub activity — since ${windowLabel}`,
    connector: 'github',
    recordedAt: new Date().toISOString(),
    excerpt: digest.slice(0, 240),
    note: 'Auto-ingested via a personal access token connected by this person. Reads pull requests and reviews only — never file contents.',
    externalRef: 'github-rest-api',
  };
  await repo.upsertEvidence(orgId, evidence);

  const { provider } = await getMainProvider(orgId);
  const text = provider?.configured()
    ? await provider.writeClaim(person.name, digest)
    : deterministicGithubClaimText(activity);

  const claim: Claim = {
    id,
    personId,
    tier: 'T1',
    dataClass: 'Internal',
    text,
    evidenceId: evidence.id,
    sourceSurface: 'github',
    derivedAt: new Date().toISOString(),
    supersededBy: null,
  };
  await repo.upsertClaim(orgId, claim);
}

function deterministicJiraClaimText(items: JiraActivityItem[]): string {
  const assigned = items.filter((i) => i.role === 'assignee').length;
  const reported = items.filter((i) => i.role === 'reporter').length;
  const parts = [
    assigned ? `${assigned} issue${assigned === 1 ? '' : 's'} assigned` : null,
    reported ? `${reported} issue${reported === 1 ? '' : 's'} reported` : null,
  ].filter((p): p is string => p != null);
  const last = items[0];
  return `Jira activity: ${parts.join(', ')}${last ? ` — most recently: ${last.key} "${last.summary}" (${last.status}).` : '.'}`;
}

/** No-op if this person doesn't have a real, connected Jira token — same shape as
 *  ingestGithubClaim. UNVERIFIED against a real instance (see jira.ts's module comment). */
export async function ingestJiraClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces.jira !== 'connected') return;

  const conn = await getJiraConnection(personId);
  if (!conn) return;

  const activity = await getRecentJiraActivity(conn.siteUrl, conn.email, conn.apiToken, since);
  const digest = formatJiraDigest(activity);
  if (!digest) return; // nothing real happened in this window — assert nothing

  const today = new Date().toISOString().slice(0, 10);
  const windowLabel = since.toISOString().slice(0, 10);
  const id = `auto-jira-${personId}-${today}`;
  const evidence: Evidence = {
    id,
    kind: 'issue activity',
    title: `Jira activity — since ${windowLabel}`,
    connector: 'jira',
    recordedAt: new Date().toISOString(),
    excerpt: digest.slice(0, 240),
    note: 'Auto-ingested via an API token connected by this person. Reads assigned/reported issues only — never issue comments or attachments.',
    externalRef: 'jira-rest-api',
  };
  await repo.upsertEvidence(orgId, evidence);

  const { provider } = await getMainProvider(orgId);
  const text = provider?.configured()
    ? await provider.writeClaim(person.name, digest)
    : deterministicJiraClaimText(activity);

  const claim: Claim = {
    id,
    personId,
    tier: 'T1',
    dataClass: 'Internal',
    text,
    evidenceId: evidence.id,
    sourceSurface: 'jira',
    derivedAt: new Date().toISOString(),
    supersededBy: null,
  };
  await repo.upsertClaim(orgId, claim);
}

const PUSHED_SOURCE_LABEL: Record<'codex' | 'gemini-cli', string> = {
  codex: 'Codex CLI',
  'gemini-cli': 'Gemini CLI',
};

/** Codex CLI and Gemini CLI have no local session-transcript format to tail the way
 *  Claude Code does — a self-service pushed token is their ONLY real signal, so ingestion
 *  here is just "turn whatever was pushed into a claim", generically, one function for
 *  both rather than two near-identical copies. */
async function ingestPushedEventsClaim(source: 'codex' | 'gemini-cli', orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces[source] !== 'connected') return;

  const events = await getEventsSince(personId, source, since);
  const digest = formatIngestedEventsDigest(events);
  if (!digest) return; // nothing real was pushed in this window — assert nothing

  const today = new Date().toISOString().slice(0, 10);
  const windowLabel = since.toISOString().slice(0, 10);
  const id = `auto-${source}-${personId}-${today}`;
  const label = PUSHED_SOURCE_LABEL[source];
  const evidence: Evidence = {
    id,
    kind: 'pushed tool activity',
    title: `${label} activity — since ${windowLabel}`,
    connector: source,
    recordedAt: new Date().toISOString(),
    excerpt: digest.slice(0, 240),
    note: 'Auto-ingested from events pushed via a personal access token this person connected. No local file access — only what was explicitly pushed.',
    externalRef: `${source}-pushed-events`,
  };
  await repo.upsertEvidence(orgId, evidence);

  const lastEvent = events[events.length - 1];
  const { provider } = await getMainProvider(orgId);
  const text = provider?.configured()
    ? await provider.writeClaim(person.name, digest)
    : `${label} activity: ${events.length} event${events.length === 1 ? '' : 's'} logged${lastEvent ? ` — most recently: ${lastEvent.summary}.` : '.'}`;

  const claim: Claim = {
    id,
    personId,
    tier: 'T2',
    dataClass: 'Internal',
    text,
    evidenceId: evidence.id,
    sourceSurface: source,
    derivedAt: new Date().toISOString(),
    supersededBy: null,
  };
  await repo.upsertClaim(orgId, claim);
}

export const ingestCodexClaim = (orgId: number, personId: number, since: Date = startOfToday()) =>
  ingestPushedEventsClaim('codex', orgId, personId, since);
export const ingestGeminiClaim = (orgId: number, personId: number, since: Date = startOfToday()) =>
  ingestPushedEventsClaim('gemini-cli', orgId, personId, since);

/**
 * The shared tail every `ingest<Tool>Claim` function below reduces to once it already has
 * a real digest in hand — upsert the real evidence row, ask the org's main agent to draft
 * the claim's *text* (or fall back to a deterministic one, same "never blocked by a model
 * being unconfigured" guarantee every other source here has), then upsert the claim.
 * Extracted here instead of repeating `ingestGithubClaim`'s ~20-line tail eight more
 * times — the *fetch* half of each function below still differs per tool (different auth
 * shapes, different APIs), so that half stays written out per tool for real, but the
 * evidence/claim-writing half doesn't need to.
 */
async function finishIngestion(params: {
  orgId: number;
  personId: number;
  personName: string;
  surfaceKey: SurfaceKey;
  label: string;
  kind: string;
  tier: 'T1' | 'T2' | 'T3';
  externalRef: string;
  digest: string;
  deterministicText: string;
}): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const id = `auto-${params.surfaceKey}-${params.personId}-${today}`;
  const evidence: Evidence = {
    id,
    kind: params.kind,
    title: `${params.label} activity — ${today}`,
    connector: params.surfaceKey,
    recordedAt: new Date().toISOString(),
    excerpt: params.digest.slice(0, 240),
    note: `Auto-ingested via a credential connected by this person. Read-only, scoped to what ${params.label}'s API returns for them specifically.`,
    externalRef: params.externalRef,
  };
  await repo.upsertEvidence(params.orgId, evidence);

  const { provider } = await getMainProvider(params.orgId);
  const text = provider?.configured()
    ? await provider.writeClaim(params.personName, params.digest)
    : params.deterministicText;

  const claim: Claim = {
    id,
    personId: params.personId,
    tier: params.tier,
    dataClass: 'Internal',
    text,
    evidenceId: evidence.id,
    sourceSurface: params.surfaceKey,
    derivedAt: new Date().toISOString(),
    supersededBy: null,
  };
  await repo.upsertClaim(params.orgId, claim);
}

/** No-op if this person doesn't have a real, connected Linear key — same shape as
 *  ingestGithubClaim. UNVERIFIED against a real workspace (see linear.ts's module
 *  comment). */
export async function ingestLinearClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces.linear !== 'connected') return;
  const conn = await getLinearConnection(personId);
  if (!conn) return;
  const activity = await getRecentLinearActivity(conn.accessToken, since);
  const digest = formatLinearDigest(activity);
  if (!digest) return;
  await finishIngestion({
    orgId, personId, personName: person.name, surfaceKey: 'linear', label: 'Linear', kind: 'issue activity',
    tier: 'T1', externalRef: 'linear-graphql-api', digest,
    deterministicText: `Linear activity: ${activity.length} issue${activity.length === 1 ? '' : 's'} updated${activity[0] ? ` — most recently: ${activity[0].identifier} "${activity[0].title}" (${activity[0].status}).` : '.'}`,
  });
}

/** No-op if this person doesn't have a real, connected Notion integration — same shape as
 *  ingestGithubClaim. UNVERIFIED against a real workspace (see notion.ts's module
 *  comment). */
export async function ingestNotionClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces.notion !== 'connected') return;
  const conn = await getNotionConnection(personId);
  if (!conn) return;
  const activity = await getRecentNotionActivity(conn.accessToken, since);
  const digest = formatNotionDigest(activity);
  if (!digest) return;
  await finishIngestion({
    orgId, personId, personName: person.name, surfaceKey: 'notion', label: 'Notion', kind: 'page activity',
    tier: 'T2', externalRef: 'notion-rest-api', digest,
    deterministicText: `Notion activity: ${activity.length} page${activity.length === 1 ? '' : 's'} edited${activity[0] ? ` — most recently: "${activity[0].title}".` : '.'}`,
  });
}

/** No-op if this person doesn't have real, connected Confluence credentials — same shape
 *  as ingestJiraClaim (same Atlassian account). UNVERIFIED against a real site (see
 *  confluence.ts's module comment). */
export async function ingestConfluenceClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces.confluence !== 'connected') return;
  const conn = await getConfluenceConnection(personId);
  if (!conn) return;
  const activity = await getRecentConfluenceActivity(conn.siteUrl, conn.email, conn.apiToken, since);
  const digest = formatConfluenceDigest(activity);
  if (!digest) return;
  await finishIngestion({
    orgId, personId, personName: person.name, surfaceKey: 'confluence', label: 'Confluence', kind: 'page activity',
    tier: 'T2', externalRef: 'confluence-rest-api', digest,
    deterministicText: `Confluence activity: ${activity.length} page${activity.length === 1 ? '' : 's'} edited${activity[0] ? ` — most recently: "${activity[0].title}" in ${activity[0].spaceKey}.` : '.'}`,
  });
}

/** No-op if this person doesn't have a real, connected Asana token — same shape as
 *  ingestGithubClaim. UNVERIFIED against a real workspace (see asana.ts's module
 *  comment). */
export async function ingestAsanaClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces.asana !== 'connected') return;
  const conn = await getAsanaConnection(personId);
  if (!conn) return;
  const activity = await getRecentAsanaActivity(conn.accessToken, since);
  const digest = formatAsanaDigest(activity);
  if (!digest) return;
  await finishIngestion({
    orgId, personId, personName: person.name, surfaceKey: 'asana', label: 'Asana', kind: 'task activity',
    tier: 'T1', externalRef: 'asana-rest-api', digest,
    deterministicText: `Asana activity: ${activity.length} task${activity.length === 1 ? '' : 's'} updated${activity[0] ? ` — most recently: "${activity[0].name}".` : '.'}`,
  });
}

/** No-op if this person doesn't have a real, connected GitLab token — same shape as
 *  ingestGithubClaim. UNVERIFIED against a real instance (see gitlab.ts's module
 *  comment). */
export async function ingestGitlabClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces.gitlab !== 'connected') return;
  const conn = await getGitlabConnection(personId);
  if (!conn) return;
  const activity = await getRecentGitlabActivity(conn.accessToken, conn.siteUrl, since);
  const digest = formatGitlabDigest(activity);
  if (!digest) return;
  await finishIngestion({
    orgId, personId, personName: person.name, surfaceKey: 'gitlab', label: 'GitLab', kind: 'merge request activity',
    tier: 'T1', externalRef: 'gitlab-rest-api', digest,
    deterministicText: `GitLab activity: ${activity.length} merge request${activity.length === 1 ? '' : 's'} opened or updated${activity[0] ? ` — most recently: "${activity[0].title}" in ${activity[0].project}.` : '.'}`,
  });
}

/** No-op if this person doesn't have a real, connected HubSpot token — same shape as
 *  ingestGithubClaim. UNVERIFIED against a real portal (see hubspot.ts's module
 *  comment). */
export async function ingestHubspotClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces.hubspot !== 'connected') return;
  const conn = await getHubspotConnection(personId);
  if (!conn) return;
  const activity = await getRecentHubspotActivity(conn.accessToken, since);
  const digest = formatHubspotDigest(activity);
  if (!digest) return;
  await finishIngestion({
    orgId, personId, personName: person.name, surfaceKey: 'hubspot', label: 'HubSpot', kind: 'deal activity',
    tier: 'T1', externalRef: 'hubspot-crm-api', digest,
    deterministicText: `HubSpot activity: ${activity.length} deal${activity.length === 1 ? '' : 's'} updated${activity[0] ? ` — most recently: "${activity[0].name}" (${activity[0].stage}).` : '.'}`,
  });
}

/** No-op if this person doesn't have real, connected Zendesk credentials — same shape as
 *  ingestJiraClaim. UNVERIFIED against a real account (see zendesk.ts's module comment). */
export async function ingestZendeskClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces.zendesk !== 'connected') return;
  const conn = await getZendeskConnection(personId);
  if (!conn) return;
  const activity = await getRecentZendeskActivity(conn.subdomain, conn.email, conn.apiToken, since);
  const digest = formatZendeskDigest(activity);
  if (!digest) return;
  await finishIngestion({
    orgId, personId, personName: person.name, surfaceKey: 'zendesk', label: 'Zendesk', kind: 'ticket activity',
    tier: 'T1', externalRef: 'zendesk-rest-api', digest,
    deterministicText: `Zendesk activity: ${activity.length} ticket${activity.length === 1 ? '' : 's'} updated${activity[0] ? ` — most recently: "${activity[0].subject}" (${activity[0].status}).` : '.'}`,
  });
}

/** No-op if this person doesn't have a Google connection (Gmail's, shared — see
 *  googleCalendar.ts's module comment). UNVERIFIED against a real account: no real Google
 *  consent screen has completed against this app yet (same gap as the Gmail bridge). */
export async function ingestCalendarClaim(orgId: number, personId: number, since: Date = startOfToday()): Promise<void> {
  const person = await repo.getPerson(personId);
  if (person.surfaces.calendar !== 'connected') return;
  const activity = await getRecentCalendarActivity(personId, since);
  const digest = formatCalendarDigest(activity);
  if (!digest) return;
  await finishIngestion({
    orgId, personId, personName: person.name, surfaceKey: 'calendar', label: 'Google Calendar', kind: 'calendar activity',
    tier: 'T2', externalRef: 'google-calendar-api', digest,
    deterministicText: `Calendar activity: ${activity.length} event${activity.length === 1 ? '' : 's'}${activity[0] ? ` — most recently: "${activity[0].summary}".` : '.'}`,
  });
}
