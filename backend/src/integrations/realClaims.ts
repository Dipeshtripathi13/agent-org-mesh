import * as repo from '../db/repo.js';
import type { Claim, Evidence } from '../domain/types.js';
import { formatClaudeCodeDigest, getClaudeCodeActivitySince } from './claudeCodeActivity.js';
import { formatIngestedEventsDigest, getEventsSince } from './eventIngestion.js';
import { getGithubConnection } from './githubConnection.js';
import { formatGithubDigest, getRecentGithubActivity, type GithubActivityItem } from './github.js';
import { getJiraConnection } from './jiraConnection.js';
import { formatJiraDigest, getRecentJiraActivity, type JiraActivityItem } from './jira.js';
import { getMainProvider } from './runtimeProvider.js';

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
