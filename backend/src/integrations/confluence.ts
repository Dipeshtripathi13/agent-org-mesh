/** Real Confluence reads — the exact same Atlassian API token, email, and site URL as
 *  jira.ts (one Atlassian account token covers both products). Read-only: pages the
 *  person authored or last modified, since a given date, via Confluence Cloud's CQL
 *  search endpoint.
 *
 *  UNVERIFIED AGAINST A REAL SITE — built the same way as jira.ts, following Confluence
 *  Cloud's documented REST API exactly, but no real Confluence site was available to test
 *  against yet. */
import {
  saveGenericConnection, getGenericConnection, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'confluence';

export interface ConfluenceActivityItem {
  title: string;
  spaceKey: string;
  url: string;
  lastModified: string;
}

function authHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
}

/** Resolves the credentials to a real Confluence user — doubles as validating them. */
export async function fetchConfluenceIdentity(siteUrl: string, email: string, apiToken: string): Promise<{ displayName: string } | null> {
  const res = await fetch(`${siteUrl.replace(/\/$/, '')}/wiki/rest/api/user/current`, {
    headers: { authorization: authHeader(email, apiToken), accept: 'application/json' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { displayName?: string };
  return data.displayName ? { displayName: data.displayName } : null;
}

export async function getRecentConfluenceActivity(siteUrl: string, email: string, apiToken: string, since: Date): Promise<ConfluenceActivityItem[]> {
  const dateStr = since.toISOString().slice(0, 10);
  const cql = `contributor = currentUser() and lastmodified >= "${dateStr}" order by lastmodified desc`;
  const res = await fetch(
    `${siteUrl.replace(/\/$/, '')}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=25&expand=space`,
    { headers: { authorization: authHeader(email, apiToken), accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Confluence search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { results?: any[] };
  return (data.results ?? []).map((r) => ({
    title: r.title,
    spaceKey: r.space?.key ?? 'unknown',
    url: `${siteUrl.replace(/\/$/, '')}/wiki${r._links?.webui ?? ''}`,
    lastModified: r.version?.when ?? new Date().toISOString(),
  }));
}

export function formatConfluenceDigest(items: ConfluenceActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `- Edited "${i.title}" in ${i.spaceKey}`).join('\n');
}

export async function saveConfluenceConnection(
  personId: number,
  siteUrl: string,
  email: string,
  apiToken: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchConfluenceIdentity(siteUrl, email, apiToken);
  if (!identity) return { ok: false, error: "Confluence rejected these credentials — check the site URL, email, and API token" };
  await saveGenericConnection(PROVIDER, personId, apiToken, email, siteUrl);
  return { ok: true, label: identity.displayName };
}

export async function getConfluenceStatus(personId: number): Promise<{ connected: boolean; email: string | null; siteUrl: string | null }> {
  const conn = await getGenericConnection(PROVIDER, personId);
  return { connected: !!conn, email: conn?.label ?? null, siteUrl: conn?.siteUrl ?? null };
}
export const getConfluenceConnection = async (personId: number) => {
  const conn = await getGenericConnection(PROVIDER, personId);
  if (!conn || !conn.label || !conn.siteUrl) return null;
  return { apiToken: conn.accessToken, email: conn.label, siteUrl: conn.siteUrl };
};
export const disconnectConfluence = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveConfluenceAccountConnection(
  accountId: number,
  siteUrl: string,
  email: string,
  apiToken: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchConfluenceIdentity(siteUrl, email, apiToken);
  if (!identity) return { ok: false, error: "Confluence rejected these credentials — check the site URL, email, and API token" };
  await saveGenericAccountConnection(PROVIDER, accountId, apiToken, email, siteUrl);
  return { ok: true, label: identity.displayName };
}
export async function getConfluenceAccountStatus(accountId: number): Promise<{ connected: boolean; email: string | null; siteUrl: string | null }> {
  const conn = await getGenericAccountConnection(PROVIDER, accountId);
  return { connected: !!conn, email: conn?.label ?? null, siteUrl: conn?.siteUrl ?? null };
}
export const getConfluenceAccountConnection = async (accountId: number) => {
  const conn = await getGenericAccountConnection(PROVIDER, accountId);
  if (!conn || !conn.label || !conn.siteUrl) return null;
  return { apiToken: conn.accessToken, email: conn.label, siteUrl: conn.siteUrl };
};
export const disconnectConfluenceAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
