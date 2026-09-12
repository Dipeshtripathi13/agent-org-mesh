import * as repo from '../db/repo.js';

// PATs/API tokens don't expire on a fixed, readable schedule the way OAuth access tokens
// do — same "treat as long-lived" placeholder githubConnection.ts/jiraConnection.ts
// already use, for the same reason. If the provider rejects it later (revoked, actually
// expired), ingestion just gets an auth error and the surface silently stops refreshing.
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

/** The shared low-level storage every new (non-GitHub/Jira/Gmail) connector's own
 *  `save<Tool>Connection` wraps — same `person_oauth_tokens` row every connector already
 *  uses (0001_baseline.sql), just no longer duplicated per tool. `accessToken` is whichever
 *  field the caller has already validated live against the real provider; `siteUrl` is
 *  the one optional extra column (a subdomain, an instance URL) tools like Zendesk/GitLab/
 *  Confluence need and PAT-only tools like Linear/Notion/Asana simply omit. */
export async function saveGenericConnection(
  provider: string,
  personId: number,
  accessToken: string,
  connectedLabel: string,
  siteUrl: string | null = null,
): Promise<void> {
  await repo.saveOAuthConnection(personId, {
    provider,
    accessToken,
    refreshToken: null,
    expiresAt: FAR_FUTURE,
    connectedEmail: connectedLabel,
    siteUrl,
  });
}

export async function getGenericConnectionStatus(provider: string, personId: number): Promise<{ connected: boolean; label: string | null }> {
  const conn = await repo.getOAuthConnection(personId, provider);
  return { connected: !!conn, label: conn?.connectedEmail ?? null };
}

export async function getGenericConnection(provider: string, personId: number): Promise<{ accessToken: string; label: string | null; siteUrl: string | null } | null> {
  const conn = await repo.getOAuthConnection(personId, provider);
  if (!conn) return null;
  return { accessToken: conn.accessToken, label: conn.connectedEmail, siteUrl: conn.siteUrl ?? null };
}

export async function disconnectGeneric(provider: string, personId: number): Promise<void> {
  await repo.deleteOAuthConnection(personId, provider);
}

/** Same four functions, account-keyed instead of person-keyed — for a personal (no-org)
 *  account connecting a tool from its own "Set up my agent," where there's no `people`
 *  row to key off of at all. */
export async function saveGenericAccountConnection(
  provider: string,
  accountId: number,
  accessToken: string,
  connectedLabel: string,
  siteUrl: string | null = null,
): Promise<void> {
  await repo.saveAccountOAuthConnection(accountId, {
    provider,
    accessToken,
    refreshToken: null,
    expiresAt: FAR_FUTURE,
    connectedEmail: connectedLabel,
    siteUrl,
  });
}

export async function getGenericAccountConnectionStatus(provider: string, accountId: number): Promise<{ connected: boolean; label: string | null }> {
  const conn = await repo.getAccountOAuthConnection(accountId, provider);
  return { connected: !!conn, label: conn?.connectedEmail ?? null };
}

export async function getGenericAccountConnection(provider: string, accountId: number): Promise<{ accessToken: string; label: string | null; siteUrl: string | null } | null> {
  const conn = await repo.getAccountOAuthConnection(accountId, provider);
  if (!conn) return null;
  return { accessToken: conn.accessToken, label: conn.connectedEmail, siteUrl: conn.siteUrl ?? null };
}

export async function disconnectGenericAccount(provider: string, accountId: number): Promise<void> {
  await repo.deleteAccountOAuthConnection(accountId, provider);
}
