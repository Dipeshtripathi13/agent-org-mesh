/** Real GitLab reads — a personal access token the person pastes in themselves (no OAuth
 *  app to register, same PAT-style shape as GitHub — GitLab is GitHub's closest sibling
 *  here). Read-only: merge requests authored, since a given date. Defaults to gitlab.com;
 *  an optional instance URL covers self-hosted GitLab.
 *
 *  The activity read (`getRecentGitlabActivity`) goes through GitLab's own official MCP
 *  server instead of a direct REST call — part of the same MCP pilot batch as
 *  github.ts/notion.ts/linear.ts. Real, sourced findings, not assumptions: GitLab's own
 *  docs (docs.gitlab.com/user/model_context_protocol/mcp_server_tools/) name the exact
 *  tool (`list_merge_requests`) and confirm it filters by `author_username` — but do NOT
 *  document a native updated-since filter for that specific tool, so results are filtered
 *  by `updated_at` client-side, same pattern this file's own dbt/`notion.ts` neighbors
 *  already use for date filtering. The endpoint pattern (`https://<host>/api/v4/mcp`,
 *  confirmed live: a deliberately invalid bearer token reaches it and gets a clean 401)
 *  reuses this file's own existing `host()` helper unchanged, so self-hosted GitLab
 *  instances work exactly like they already do for the REST-based identity check below.
 *  One real, disclosed gap: GitLab's docs describe the tool's response as "compact
 *  metadata" without publishing the exact JSON field names, unlike GitHub's fully
 *  open-source server (no live-verifiable schema was possible without a real token, since
 *  even `tools/list` requires auth here) — the mapping below keeps this file's existing,
 *  REST-API-convention field names (`title`, `web_url`, `updated_at`, `references.full`)
 *  as the best-informed guess (GitLab's own REST API already uses exactly this snake_case
 *  shape, and a "compact" object is far more likely to be a subset of those same fields
 *  than a renamed one), and degrades honestly — an empty digest, never a crash or wrong
 *  data — if that guess turns out wrong for a real workspace.
 *
 *  `fetchGitlabIdentity`/connection storage stay on plain REST, deliberately not migrated
 *  — same reasoning as github.ts's `fetchGithubLogin`. UNVERIFIED against a real instance
 *  either way — this file has never been tested against a real GitLab account, MCP or
 *  REST. */
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';
import { withMcpSession } from './mcpClient.js';

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
  const mcpUrl = `${host(siteUrl)}/api/v4/mcp`;
  const result = await withMcpSession(mcpUrl, token, (callTool) => callTool('list_merge_requests', {
    author_username: identity.username,
    state: 'all',
  }));
  const items = Array.isArray(result) ? result : ((result as any)?.merge_requests ?? []);
  return items
    .filter((mr: any) => !mr.updated_at || new Date(mr.updated_at) >= since)
    .map((mr: any) => ({
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
