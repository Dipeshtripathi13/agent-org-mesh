import type { SurfaceKey } from '../domain/types.js';
import * as repo from '../db/repo.js';
import { saveGithubAccountConnection, getGithubAccountConnection, getGithubAccountStatus, disconnectGithubAccount } from './githubConnection.js';
import { getRecentGithubActivity, formatGithubDigest } from './github.js';
import { saveJiraAccountConnection, getJiraAccountConnection, getJiraAccountStatus, disconnectJiraAccount } from './jiraConnection.js';
import { getRecentJiraActivity, formatJiraDigest } from './jira.js';
import { listAccountTokens } from './ingestTokens.js';
import { getAccountEventsSince, formatIngestedEventsDigest } from './eventIngestion.js';
import { getClaudeCodeActivitySince, formatClaudeCodeDigest } from './claudeCodeActivity.js';
import {
  saveLinearAccountConnection, getLinearAccountStatus, getLinearAccountConnection, disconnectLinearAccount,
  getRecentLinearActivity, formatLinearDigest,
} from './linear.js';
import {
  saveNotionAccountConnection, getNotionAccountStatus, getNotionAccountConnection, disconnectNotionAccount,
  getRecentNotionActivity, formatNotionDigest,
} from './notion.js';
import {
  saveConfluenceAccountConnection, getConfluenceAccountStatus, getConfluenceAccountConnection, disconnectConfluenceAccount,
  getRecentConfluenceActivity, formatConfluenceDigest,
} from './confluence.js';
import {
  saveAsanaAccountConnection, getAsanaAccountStatus, getAsanaAccountConnection, disconnectAsanaAccount,
  getRecentAsanaActivity, formatAsanaDigest,
} from './asana.js';
import {
  saveGitlabAccountConnection, getGitlabAccountStatus, getGitlabAccountConnection, disconnectGitlabAccount,
  getRecentGitlabActivity, formatGitlabDigest,
} from './gitlab.js';
import {
  saveHubspotAccountConnection, getHubspotAccountStatus, getHubspotAccountConnection, disconnectHubspotAccount,
  getRecentHubspotActivity, formatHubspotDigest,
} from './hubspot.js';
import {
  saveZendeskAccountConnection, getZendeskAccountStatus, getZendeskAccountConnection, disconnectZendeskAccount,
  getRecentZendeskActivity, formatZendeskDigest,
} from './zendesk.js';
import {
  saveTrelloAccountConnection, getTrelloAccountStatus, disconnectTrelloAccount, getTrelloAccountConnection,
  getRecentTrelloActivity, formatTrelloDigest,
} from './trello.js';
import { saveAirtableAccountConnection, getAirtableAccountStatus, disconnectAirtableAccount } from './airtable.js';
import { saveMondayAccountConnection, getMondayAccountStatus, disconnectMondayAccount } from './monday.js';
import { saveFigmaAccountConnection, getFigmaAccountStatus, disconnectFigmaAccount } from './figma.js';
import { saveDiscordAccountConnection, getDiscordAccountStatus, disconnectDiscordAccount } from './discord.js';
import {
  saveAirflowAccountConnection, getAirflowAccountStatus, getAirflowAccountConnection, disconnectAirflowAccount,
  getRecentAirflowActivity, formatAirflowDigest,
} from './airflow.js';
import {
  saveDbtAccountConnection, getDbtAccountStatus, getDbtAccountConnection, disconnectDbtAccount,
  getRecentDbtActivity, formatDbtDigest,
} from './dbtCloud.js';
import {
  saveSnowflakeAccountConnection, getSnowflakeAccountStatus, getSnowflakeAccountConnection, disconnectSnowflakeAccount,
  getRecentSnowflakeActivity, formatSnowflakeDigest,
} from './snowflake.js';
import {
  saveDatabricksAccountConnection, getDatabricksAccountStatus, getDatabricksAccountConnection, disconnectDatabricksAccount,
  getRecentDatabricksActivity, formatDatabricksDigest,
} from './databricks.js';

/**
 * The personal (no-org) counterpart to server.ts's CONNECT_HANDLERS/DISCONNECT_HANDLERS/
 * STATUS_HANDLERS + resourceProviders.ts's PROVIDERS/gatherAll — same generic connector
 * catalog (connectorCatalog.ts), same tools, just account-keyed instead of person-keyed
 * since a personal account has no `people` row to attach a surface/claim to at all. GitHub
 * and Jira are real, full entries here too now — a personal account can connect its own,
 * private GitHub/Jira, never visible to anyone else. Google Calendar stays excluded: it
 * rides on Gmail's OAuth token, and Gmail itself was never extended to personal accounts
 * (a genuinely separate, bigger piece of work, not done here).
 */

type AccountConnectHandler = (accountId: number, fields: Record<string, string>) => Promise<{ ok: true; label: string } | { ok: false; error: string }>;
type AccountStatusHandler = (accountId: number) => Promise<{ connected: boolean; label: string | null }>;

export const ACCOUNT_CONNECT_HANDLERS: Partial<Record<SurfaceKey, AccountConnectHandler>> = {
  github: async (id, f) => {
    const r = await saveGithubAccountConnection(id, f.token);
    return r.ok ? { ok: true, label: r.login } : r;
  },
  jira: async (id, f) => {
    const r = await saveJiraAccountConnection(id, f.siteUrl, f.email, f.apiToken);
    return r.ok ? { ok: true, label: r.displayName } : r;
  },
  linear: (id, f) => saveLinearAccountConnection(id, f.apiKey),
  notion: (id, f) => saveNotionAccountConnection(id, f.token),
  confluence: (id, f) => saveConfluenceAccountConnection(id, f.siteUrl, f.email, f.apiToken),
  asana: (id, f) => saveAsanaAccountConnection(id, f.token),
  gitlab: (id, f) => saveGitlabAccountConnection(id, f.token, f.siteUrl?.trim() || null),
  hubspot: (id, f) => saveHubspotAccountConnection(id, f.token),
  zendesk: (id, f) => saveZendeskAccountConnection(id, f.siteUrl, f.email, f.apiToken),
  trello: (id, f) => saveTrelloAccountConnection(id, f.apiKey, f.token),
  airtable: (id, f) => saveAirtableAccountConnection(id, f.token),
  monday: (id, f) => saveMondayAccountConnection(id, f.token),
  figma: (id, f) => saveFigmaAccountConnection(id, f.token),
  discord: (id, f) => saveDiscordAccountConnection(id, f.token),
  airflow: (id, f) => saveAirflowAccountConnection(id, f.siteUrl, f.username, f.password),
  dbt: (id, f) => saveDbtAccountConnection(id, f.token, f.accountId, f.siteUrl?.trim() || null),
  snowflake: (id, f) => saveSnowflakeAccountConnection(id, f.account, f.username, f.privateKey, f.warehouse?.trim() || null),
  databricks: (id, f) => saveDatabricksAccountConnection(id, f.workspaceUrl, f.clientId, f.clientSecret),
};

export const ACCOUNT_DISCONNECT_HANDLERS: Partial<Record<SurfaceKey, (accountId: number) => Promise<void>>> = {
  github: disconnectGithubAccount,
  jira: disconnectJiraAccount,
  linear: disconnectLinearAccount,
  notion: disconnectNotionAccount,
  confluence: disconnectConfluenceAccount,
  asana: disconnectAsanaAccount,
  gitlab: disconnectGitlabAccount,
  hubspot: disconnectHubspotAccount,
  zendesk: disconnectZendeskAccount,
  trello: disconnectTrelloAccount,
  airtable: disconnectAirtableAccount,
  monday: disconnectMondayAccount,
  figma: disconnectFigmaAccount,
  discord: disconnectDiscordAccount,
  airflow: disconnectAirflowAccount,
  dbt: disconnectDbtAccount,
  snowflake: disconnectSnowflakeAccount,
  databricks: disconnectDatabricksAccount,
};

export const ACCOUNT_STATUS_HANDLERS: Partial<Record<SurfaceKey, AccountStatusHandler>> = {
  linear: getLinearAccountStatus,
  notion: getNotionAccountStatus,
  confluence: async (id) => { const s = await getConfluenceAccountStatus(id); return { connected: s.connected, label: s.email }; },
  asana: getAsanaAccountStatus,
  gitlab: getGitlabAccountStatus,
  hubspot: getHubspotAccountStatus,
  zendesk: async (id) => { const s = await getZendeskAccountStatus(id); return { connected: s.connected, label: s.email }; },
  trello: getTrelloAccountStatus,
  airtable: getAirtableAccountStatus,
  monday: getMondayAccountStatus,
  figma: getFigmaAccountStatus,
  discord: getDiscordAccountStatus,
  airflow: getAirflowAccountStatus,
  dbt: getDbtAccountStatus,
  snowflake: getSnowflakeAccountStatus,
  databricks: getDatabricksAccountStatus,
  github: async (id) => { const s = await getGithubAccountStatus(id); return { connected: s.connected, label: s.login }; },
  jira: async (id) => { const s = await getJiraAccountStatus(id); return { connected: s.connected, label: s.email }; },
  // codex/gemini-cli have no credential to check and aren't real runtime_catalog entries
  // (org mode's own "Register another agent" can't register them either — that dropdown
  // is a separate, orthogonal concept from ingest sources, see eventIngestion.ts) —
  // "connected" for the ask-personal digest bridge means at least one real event has ever
  // been pushed, the same signal that flips a person's surface to 'connected' in org mode.
  codex: async (id) => ({ connected: (await getAccountEventsSince(id, 'codex', new Date(0))).length > 0, label: null }),
  'gemini-cli': async (id) => ({ connected: (await getAccountEventsSince(id, 'gemini-cli', new Date(0))).length > 0, label: null }),
  // claude-code: org mode only ever triggers its local-transcript scan once
  // person.surfaces['claude-code'] is actually 'connected' (realClaims.ts's
  // ingestClaudeCodeClaim checks this explicitly, never unconditionally) — registered as
  // a sub-agent or had at least one real event pushed, the same two paths that flip that
  // surface in org mode. Matching that gate here, not scanning on every single ask
  // regardless of whether this account has ever touched Claude Code at all.
  'claude-code': async (id) => {
    const [registered, pushed] = await Promise.all([
      repo.getAccountRuntimes(id),
      getAccountEventsSince(id, 'claude-code', new Date(0)),
    ]);
    return { connected: registered.some((r) => r.runtimeKey === 'claude-code') || pushed.length > 0, label: null };
  },
};

// A separate `ACCOUNT_INGEST_TOKEN_STATUS` map used to override these three keys' status
// in the ConnectorsPanel dropdown with "has ≥1 active token to manage" instead of this
// map's own real per-source signal — found live, reported directly: generating one
// Claude Code token made Codex CLI and Gemini CLI both show as "connected" in the panel,
// since a token isn't scoped to one source. Removed; the panel now reads
// ACCOUNT_STATUS_HANDLERS directly for every key, same as every other connector. This
// doesn't reintroduce the local-transcript-scan-hang bug the removed map's comment
// warned about — that bug was ask-personal's digest bridge treating Claude Code as
// unconditionally connected before it had any real gate at all; this map's own
// claude-code/codex/gemini-cli entries above already are that real, cheap gate (a DB
// check, never a filesystem scan), so reusing them for the panel's display is exactly the
// same signal, not a step back toward the old bug.

/** The "live"-tier tools that can actually produce a digest — the personal-ask bridge's
 *  version of resourceProviders.ts's PROVIDERS array. `ask-personal` in server.ts narrows
 *  this to connected tools, runs it through the same `selectRelevantSurfaces` router the
 *  org path uses, then feeds whichever come back relevant into `converse`'s `sections` —
 *  never persisted anywhere but that turn's own answer (and, for the label only,
 *  `consulted_sources` on the personal_asks row itself). */
export interface AccountDigestProvider {
  surfaceKey: SurfaceKey;
  label: string;
  fetchDigest(accountId: number, since: Date): Promise<string | null>;
}

export const ACCOUNT_DIGEST_PROVIDERS: AccountDigestProvider[] = [
  {
    surfaceKey: 'linear', label: 'Linear',
    fetchDigest: async (id, since) => {
      const conn = await getLinearAccountConnection(id);
      if (!conn) return null;
      return formatLinearDigest(await getRecentLinearActivity(conn.accessToken, since));
    },
  },
  {
    surfaceKey: 'notion', label: 'Notion',
    fetchDigest: async (id, since) => {
      const conn = await getNotionAccountConnection(id);
      if (!conn) return null;
      return formatNotionDigest(await getRecentNotionActivity(conn.accessToken, since));
    },
  },
  {
    surfaceKey: 'confluence', label: 'Confluence',
    fetchDigest: async (id, since) => {
      const conn = await getConfluenceAccountConnection(id);
      if (!conn) return null;
      return formatConfluenceDigest(await getRecentConfluenceActivity(conn.siteUrl, conn.email, conn.apiToken, since));
    },
  },
  {
    surfaceKey: 'asana', label: 'Asana',
    fetchDigest: async (id, since) => {
      const conn = await getAsanaAccountConnection(id);
      if (!conn) return null;
      return formatAsanaDigest(await getRecentAsanaActivity(conn.accessToken, since));
    },
  },
  {
    surfaceKey: 'gitlab', label: 'GitLab',
    fetchDigest: async (id, since) => {
      const conn = await getGitlabAccountConnection(id);
      if (!conn) return null;
      return formatGitlabDigest(await getRecentGitlabActivity(conn.accessToken, conn.siteUrl, since));
    },
  },
  {
    surfaceKey: 'hubspot', label: 'HubSpot',
    fetchDigest: async (id, since) => {
      const conn = await getHubspotAccountConnection(id);
      if (!conn) return null;
      return formatHubspotDigest(await getRecentHubspotActivity(conn.accessToken, since));
    },
  },
  {
    surfaceKey: 'zendesk', label: 'Zendesk',
    fetchDigest: async (id, since) => {
      const conn = await getZendeskAccountConnection(id);
      if (!conn) return null;
      return formatZendeskDigest(await getRecentZendeskActivity(conn.subdomain, conn.email, conn.apiToken, since));
    },
  },
  {
    surfaceKey: 'airflow', label: 'Airflow',
    fetchDigest: async (id, since) => {
      const conn = await getAirflowAccountConnection(id);
      if (!conn) return null;
      return formatAirflowDigest(await getRecentAirflowActivity(conn.siteUrl, conn.username, conn.password, since));
    },
  },
  {
    surfaceKey: 'dbt', label: 'dbt Cloud',
    fetchDigest: async (id, since) => {
      const conn = await getDbtAccountConnection(id);
      if (!conn) return null;
      return formatDbtDigest(await getRecentDbtActivity(conn.token, conn.accountId, conn.host, since));
    },
  },
  {
    surfaceKey: 'snowflake', label: 'Snowflake',
    fetchDigest: async (id, since) => {
      const conn = await getSnowflakeAccountConnection(id);
      if (!conn) return null;
      return formatSnowflakeDigest(await getRecentSnowflakeActivity(conn.account, conn.username, conn.privateKey, conn.warehouse, since));
    },
  },
  {
    surfaceKey: 'databricks', label: 'Databricks',
    fetchDigest: async (id, since) => {
      const conn = await getDatabricksAccountConnection(id);
      if (!conn) return null;
      return formatDatabricksDigest(await getRecentDatabricksActivity(conn.workspaceUrl, conn.clientId, conn.clientSecret, since));
    },
  },
  {
    surfaceKey: 'trello', label: 'Trello',
    fetchDigest: async (id, since) => {
      const conn = await getTrelloAccountConnection(id);
      if (!conn) return null;
      return formatTrelloDigest(await getRecentTrelloActivity(conn.apiKey, conn.token, since));
    },
  },
  // GitHub/Jira have their own dedicated connect panel (not the generic catalog), same as
  // org mode, but still belong in the ask-personal discovery bridge like everything else
  // connected.
  {
    surfaceKey: 'github', label: 'GitHub',
    fetchDigest: async (id, since) => {
      const conn = await getGithubAccountConnection(id);
      if (!conn) return null;
      return formatGithubDigest(await getRecentGithubActivity(conn.token, conn.login, since));
    },
  },
  {
    surfaceKey: 'jira', label: 'Jira',
    fetchDigest: async (id, since) => {
      const conn = await getJiraAccountConnection(id);
      if (!conn) return null;
      return formatJiraDigest(await getRecentJiraActivity(conn.siteUrl, conn.email, conn.apiToken, since));
    },
  },
  // Codex CLI and Gemini CLI are pure event-push sources — no credential to fetch with,
  // just whatever's already landed in account_ingested_events via a real ingest token.
  {
    surfaceKey: 'codex', label: 'Codex CLI',
    fetchDigest: async (id, since) => formatIngestedEventsDigest(await getAccountEventsSince(id, 'codex', since)),
  },
  {
    surfaceKey: 'gemini-cli', label: 'Gemini CLI',
    fetchDigest: async (id, since) => formatIngestedEventsDigest(await getAccountEventsSince(id, 'gemini-cli', since)),
  },
  // Claude Code merges the same local-transcript scan every caller shares (this demo's
  // own machine) with whatever this account has itself pushed — see
  // claudeCodeActivity.ts's own module comment on that local-read limitation.
  {
    surfaceKey: 'claude-code', label: 'Claude Code',
    fetchDigest: async (id, since) => formatClaudeCodeDigest(await getClaudeCodeActivitySince(since, undefined, id)),
  },
];

/** The open-ended counterpart to the fixed ACCOUNT_DIGEST_PROVIDERS list above — an
 *  account's own freely-named custom agents (a finance agent, a marketing agent, anything
 *  it describes for itself), generalizing the fixed claude-code/codex/gemini-cli ingest
 *  sources the same way the rest of this codebase generalized one-off connectors into a
 *  catalog. Unlike that static array, this can't be a module-level constant — the whole
 *  point is a person registers these themselves, with no code change — so it's rebuilt
 *  fresh from account_custom_agents on every ask. `surfaceKey` here is each agent's own
 *  generated source_key, a plain string rather than the closed SurfaceKey union: these
 *  never touch surfaces_catalog, coverage, or the claims/policy pipeline, the same
 *  personal-only boundary Gmail's org-mode bridge and the rest of this file already keep
 *  (see this module's own header comment). "Connected" means the same thing it does for
 *  codex/gemini-cli above: at least one real event has actually been pushed, not just
 *  registered — a name with nothing behind it yet isn't worth the router's attention. */
export interface CustomAgentDigestProvider {
  surfaceKey: string;
  label: string;
  reads: string;
  fetchDigest(accountId: number, since: Date): Promise<string | null>;
}

/**
 * The account-keyed sibling of resourceProviders.ts's verifyProvider — same real-liveness
 * check (own module comment there explains the actual gap it closes: every status check
 * in this codebase was DB-existence only, never a live ping, which is exactly how Jira's
 * connector passed every prior check for months while the endpoint underneath it was
 * already gone). Reuses each provider's own `fetchDigest` unchanged, called with
 * `since = right now`; a working credential resolves (with or without a digest — either is
 * success), a revoked one throws. Custom agents are deliberately excluded here: there's no
 * live external API behind one to ping — its own "connected" status already is its
 * liveness signal (has a real event ever landed), not a credential that can go stale.
 */
export async function verifyAccountProvider(accountId: number, surfaceKey: string): Promise<{ ok: boolean; checkedAt: string; error?: string }> {
  const checkedAt = new Date().toISOString();
  const entry = ACCOUNT_DIGEST_PROVIDERS.find((p) => p.surfaceKey === surfaceKey);
  if (!entry) return { ok: false, checkedAt, error: 'no live check available for this tool' };

  const status = await ACCOUNT_STATUS_HANDLERS[entry.surfaceKey]?.(accountId);
  if (!status?.connected) return { ok: false, checkedAt, error: 'not connected' };
  try {
    await entry.fetchDigest(accountId, new Date());
    return { ok: true, checkedAt };
  } catch (err) {
    return { ok: false, checkedAt, error: err instanceof Error ? err.message : 'request failed' };
  }
}

export async function accountCustomAgentProviders(accountId: number): Promise<CustomAgentDigestProvider[]> {
  const agents = await repo.listAccountCustomAgents(accountId);
  if (agents.length === 0) return [];
  const everPushed = await Promise.all(
    agents.map((a) => getAccountEventsSince(accountId, a.sourceKey, new Date(0))),
  );
  return agents
    .filter((_, i) => everPushed[i].length > 0)
    .map((agent) => ({
      surfaceKey: agent.sourceKey,
      label: agent.name,
      reads: agent.purpose,
      fetchDigest: (id: number, since: Date) => getAccountEventsSince(id, agent.sourceKey, since).then(formatIngestedEventsDigest),
    }));
}
