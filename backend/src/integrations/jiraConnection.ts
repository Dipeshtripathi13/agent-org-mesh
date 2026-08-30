import * as repo from '../db/repo.js';
import { fetchJiraIdentity } from './jira.js';

const PROVIDER = 'jira';
// Jira API tokens don't expire on a fixed, readable schedule the way OAuth access tokens
// do — same "treat as long-lived" placeholder GitHub's PAT uses, for the same reason.
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

export async function saveJiraConnection(
  personId: number,
  siteUrl: string,
  email: string,
  apiToken: string,
): Promise<{ ok: true; displayName: string } | { ok: false; error: string }> {
  const identity = await fetchJiraIdentity(siteUrl, email, apiToken);
  if (!identity) {
    return { ok: false, error: "Jira rejected these credentials — check the site URL, email, and API token" };
  }
  await repo.saveOAuthConnection(personId, {
    provider: PROVIDER,
    accessToken: apiToken,
    refreshToken: null,
    expiresAt: FAR_FUTURE,
    connectedEmail: email,
    siteUrl,
  });
  return { ok: true, displayName: identity.displayName };
}

export async function getJiraStatus(personId: number): Promise<{ connected: boolean; email: string | null; siteUrl: string | null }> {
  const conn = await repo.getOAuthConnection(personId, PROVIDER);
  return { connected: !!conn, email: conn?.connectedEmail ?? null, siteUrl: conn?.siteUrl ?? null };
}

export async function getJiraConnection(personId: number): Promise<{ apiToken: string; email: string; siteUrl: string } | null> {
  const conn = await repo.getOAuthConnection(personId, PROVIDER);
  if (!conn || !conn.connectedEmail || !conn.siteUrl) return null;
  return { apiToken: conn.accessToken, email: conn.connectedEmail, siteUrl: conn.siteUrl };
}

export async function disconnectJira(personId: number): Promise<void> {
  await repo.deleteOAuthConnection(personId, PROVIDER);
}

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveJiraAccountConnection(
  accountId: number,
  siteUrl: string,
  email: string,
  apiToken: string,
): Promise<{ ok: true; displayName: string } | { ok: false; error: string }> {
  const identity = await fetchJiraIdentity(siteUrl, email, apiToken);
  if (!identity) {
    return { ok: false, error: "Jira rejected these credentials — check the site URL, email, and API token" };
  }
  await repo.saveAccountOAuthConnection(accountId, {
    provider: PROVIDER,
    accessToken: apiToken,
    refreshToken: null,
    expiresAt: FAR_FUTURE,
    connectedEmail: email,
    siteUrl,
  });
  return { ok: true, displayName: identity.displayName };
}

export async function getJiraAccountStatus(accountId: number): Promise<{ connected: boolean; email: string | null; siteUrl: string | null }> {
  const conn = await repo.getAccountOAuthConnection(accountId, PROVIDER);
  return { connected: !!conn, email: conn?.connectedEmail ?? null, siteUrl: conn?.siteUrl ?? null };
}

export async function getJiraAccountConnection(accountId: number): Promise<{ apiToken: string; email: string; siteUrl: string } | null> {
  const conn = await repo.getAccountOAuthConnection(accountId, PROVIDER);
  if (!conn || !conn.connectedEmail || !conn.siteUrl) return null;
  return { apiToken: conn.accessToken, email: conn.connectedEmail, siteUrl: conn.siteUrl };
}

export async function disconnectJiraAccount(accountId: number): Promise<void> {
  await repo.deleteAccountOAuthConnection(accountId, PROVIDER);
}
