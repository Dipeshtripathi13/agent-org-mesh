/** Real GitLab reads — a personal access token the person pastes in themselves (no OAuth
 *  app to register, same PAT-style shape as GitHub — GitLab is GitHub's closest sibling
 *  here). Read-only: merge requests authored, since a given date. Defaults to gitlab.com;
 *  an optional instance URL covers self-hosted GitLab.
 *
 *  UNVERIFIED AGAINST A REAL INSTANCE — built the same way as github.ts, following
 *  GitLab's documented REST API exactly, but no real GitLab account was available to test
 *  against yet. */
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'gitlab';
const DEFAULT_HOST = 'https://gitlab.com';

export interface GitlabActivityItem {
  title: string;
  project: string;
  url: string;
  updatedAt: string;
}

function host(siteUrl: string | null | undefined): string {
  return (siteUrl?.trim() || DEFAULT_HOST).replace(/\/+$/, '');
}

/** Resolves the token to a real GitLab user — doubles as validating it works at all. */
export async function fetchGitlabIdentity(token: string, siteUrl: string | null): Promise<{ username: string } | null> {
  const res = await fetch(`${host(siteUrl)}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token } });
  if (!res.ok) return null;
  const data = (await res.json()) as { username?: string };
  return data.username ? { username: data.username } : null;
}

export async function getRecentGitlabActivity(token: string, siteUrl: string | null, since: Date): Promise<GitlabActivityItem[]> {
  const identity = await fetchGitlabIdentity(token, siteUrl);
  if (!identity) return [];
  const params = new URLSearchParams({
    scope: 'all',
    author_username: identity.username,
    updated_after: since.toISOString(),
    per_page: '25',
  });
  const res = await fetch(`${host(siteUrl)}/api/v4/merge_requests?${params.toString()}`, { headers: { 'PRIVATE-TOKEN': token } });
  if (!res.ok) throw new Error(`GitLab search failed: ${res.status} ${await res.text()}`);
  const items = (await res.json()) as any[];
  return items.map((mr) => ({
    title: mr.title,
    project: mr.references?.full ?? String(mr.project_id ?? ''),
    url: mr.web_url,
    updatedAt: mr.updated_at,
  }));
}

export function formatGitlabDigest(items: GitlabActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `- Opened/updated MR in ${i.project}: "${i.title}"`).join('\n');
}

export async function saveGitlabConnection(
  personId: number,
  token: string,
  siteUrl: string | null,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchGitlabIdentity(token, siteUrl);
  if (!identity) return { ok: false, error: "GitLab rejected this token — check it and the instance URL" };
  await saveGenericConnection(PROVIDER, personId, token, identity.username, siteUrl?.trim() || null);
  return { ok: true, label: identity.username };
}

export const getGitlabStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export const getGitlabConnection = (personId: number) => getGenericConnection(PROVIDER, personId);
export const disconnectGitlab = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveGitlabAccountConnection(
  accountId: number,
  token: string,
  siteUrl: string | null,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchGitlabIdentity(token, siteUrl);
  if (!identity) return { ok: false, error: "GitLab rejected this token — check it and the instance URL" };
  await saveGenericAccountConnection(PROVIDER, accountId, token, identity.username, siteUrl?.trim() || null);
  return { ok: true, label: identity.username };
}
export const getGitlabAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const getGitlabAccountConnection = (accountId: number) => getGenericAccountConnection(PROVIDER, accountId);
export const disconnectGitlabAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
