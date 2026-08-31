/** Real GitHub reads — a personal access token the person pastes in themselves (no OAuth
 *  app to register, unlike Gmail). Read-only: pull requests authored, reviews given, and
 *  commits authored, since a given date. Never file contents — matches the surface's own
 *  promised contract in surfaces_catalog ("Pull requests, reviews and commit metadata" /
 *  "File contents are never stored"). Commit metadata was that contract's own long-standing
 *  gap: promised since this connector's first version, never actually fetched, until found
 *  live — a personal ask answered "I don't have access" for a real, connected GitHub
 *  because there was nothing to report from PRs/reviews alone, even though real commits had
 *  happened.
 *
 *  Commits went through three real, live-found bugs before landing here — worth recording
 *  since it's exactly why the commit path (and only the commit path) below is now the one
 *  piece of this connector routed through GitHub's own official MCP server instead of a
 *  hand-rolled REST call: (1) commits weren't read at all, only PRs/reviews; (2)
 *  `/search/commits`' `author:<login>` alone never searches private repositories, fixed by
 *  adding a `user:<login>`-scoped query; (3) the deeper problem underneath both — GitHub's
 *  Search API (commits included) is an asynchronous, Elasticsearch-backed index, not the
 *  live git graph, with real documented indexing lag from minutes up to 48+ hours,
 *  structurally unfit for "what's my *latest* commit." The first fix for (3) moved to the
 *  real per-repo Commits REST API (`GET /repos/{owner}/{repo}/commits?author=&since=`) —
 *  correct, but it's exactly the kind of vendor-API-quirk code this project doesn't want to
 *  keep hand-writing and re-debugging per tool at scale (raised directly: "we will connect
 *  hundreds of tools, I don't want to test and debug and create an endpoint for each").
 *  `list_commits` on GitHub's official, remote, hosted MCP server
 *  (`https://api.githubcopilot.com/mcp/`, plain PAT auth) wraps that same real Commits API
 *  — GitHub's own maintainers already had to get this right — so the commit read now goes
 *  through `mcpClient.ts`'s `withMcpSession` instead. Its "minimal commit" JSON shape
 *  mirrors the REST API's own nested `commit.message`/`commit.author.{name,email,date}`
 *  shape exactly (confirmed against the server's real Go source, `minimal_types.go` —
 *  never assumed), so the mapping logic below needed no changes at all.
 *
 *  Deliberately NOT migrated to MCP: repo discovery (`listRecentlyPushedRepos`, plain REST
 *  `GET /user/repos?sort=pushed`) and PR/review search (`searchIssues`, plain REST
 *  `/search/issues`). Neither was ever part of the bug above — `/user/repos` is a direct,
 *  real-time listing, not a search index, and `/search/issues`' `author:` qualifier was
 *  already confirmed to include private repos once authenticated, unlike commit search's
 *  own gap — so both stay on the REST calls that already work correctly. GitHub's MCP
 *  server also exposes `search_commits`, tempting as a single-call replacement for the
 *  whole commit path — deliberately not used: it's backed by the exact same lagging search
 *  index as `/search/commits`, so using it would just reintroduce bug (3) through MCP
 *  instead of fixing it. This file is therefore a deliberate MCP+REST hybrid, not "fully
 *  MCP" — MCP only where it demonstrably fixes a real, already-found bug, not because
 *  "MCP" is the goal in itself. */

import { withMcpSession } from './mcpClient.js';

// GitHub's official, remote, hosted MCP server — no self-hosting. Used for the commit
// read only, see the module comment above for exactly why not everything in this file.
const GITHUB_MCP_URL = 'https://api.githubcopilot.com/mcp/';

export interface GithubActivityItem {
  kind: 'authored' | 'reviewed' | 'committed';
  title: string;
  repo: string;
  url: string;
  updatedAt: string;
}

/** Resolves the token to a real GitHub login — doubles as validating the token works at
 *  all. Returns null for an invalid/expired/revoked token rather than throwing, so the
 *  caller can show a clear "that token didn't work" message. */
export async function fetchGithubLogin(token: string): Promise<string | null> {
  const res = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { login?: string };
  return data.login ?? null;
}

async function searchIssues(token: string, query: string): Promise<any[]> {
  const res = await fetch(
    `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=25`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) throw new Error(`GitHub search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: any[] };
  return data.items ?? [];
}

// How many of the account's most-recently-pushed repos to check for real commits — bounds
// the number of API calls a single ask makes. The account's own *most recently pushed to*
// repos are, by construction, exactly where a "what's my latest commit" question is most
// likely to be answered from; a repo that hasn't been pushed to recently is also very
// unlikely to hold the answer to that question.
const REPOS_TO_CHECK = 15;

async function listRecentlyPushedRepos(token: string): Promise<{ owner: string; name: string }[]> {
  const res = await fetch(
    `https://api.github.com/user/repos?sort=pushed&direction=desc&per_page=${REPOS_TO_CHECK}&affiliation=owner,collaborator,organization_member`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) throw new Error(`GitHub repo list failed: ${res.status} ${await res.text()}`);
  const repos = (await res.json()) as { owner?: { login?: string }; name?: string }[];
  return repos
    .filter((r): r is { owner: { login: string }; name: string } => !!r.owner?.login && !!r.name)
    .map((r) => ({ owner: r.owner.login, name: r.name }));
}

/** The real git commit log for one repo, via GitHub's own MCP `list_commits` tool — not a
 *  search index, no indexing lag (see the module comment above). Any per-repo failure
 *  (an empty repo with zero commits ever, a since-deleted or restricted-access repo, a
 *  transient MCP hiccup) is caught by the caller and skipped the same way — one repo's own
 *  quirk never blocks the rest of the digest. */
async function listRepoCommits(token: string, owner: string, name: string, login: string, since: Date): Promise<any[]> {
  return withMcpSession(GITHUB_MCP_URL, token, async (callTool) => {
    const result = await callTool('list_commits', {
      owner, repo: name, author: login, since: since.toISOString(), perPage: 10,
    });
    const commits = Array.isArray(result) ? result : [];
    return commits.map((c: any) => ({ ...c, __repo: `${owner}/${name}` }));
  });
}

// Split out to module scope, not left as closures inside getRecentGithubActivity, so
// they're directly unit-testable against realistic fixture shapes without any network or
// MCP mocking — the same pure/impure split as parseCallToolResult in mcpClient.ts.
export const toPrItem = (kind: 'authored' | 'reviewed') => (i: any): GithubActivityItem => ({
  kind,
  title: i.title,
  repo: String(i.repository_url ?? '').split('/').slice(-2).join('/'),
  url: i.html_url,
  updatedAt: i.updated_at,
});
// Message is trimmed to its first line/120 chars, matching how a PR title reads — never
// the full commit body, and never a diff or file contents either way. `commit.message`/
// `commit.author.date` — confirmed against GitHub's real MCP server source
// (minimal_types.go), not assumed — matches the raw REST commit shape exactly, so this
// mapping is identical whether `c` came from REST or from `list_commits`.
export const toCommitItem = (c: any): GithubActivityItem => ({
  kind: 'committed',
  title: String(c.commit?.message ?? '').split('\n')[0].slice(0, 120),
  repo: c.__repo ?? '',
  url: c.html_url,
  updatedAt: c.commit?.author?.date ?? '',
});

export async function getRecentGithubActivity(token: string, login: string, since: Date): Promise<GithubActivityItem[]> {
  const dateStr = since.toISOString().slice(0, 10);
  const [authored, reviewed, repos] = await Promise.all([
    searchIssues(token, `type:pr author:${login} updated:>=${dateStr}`),
    searchIssues(token, `type:pr reviewed-by:${login} -author:${login} updated:>=${dateStr}`),
    listRecentlyPushedRepos(token),
  ]);
  const perRepoCommits = await Promise.all(
    repos.map((r) => listRepoCommits(token, r.owner, r.name, login, since).catch(() => [] as any[])),
  );
  const committed = perRepoCommits.flat();

  return [...authored.map(toPrItem('authored')), ...reviewed.map(toPrItem('reviewed')), ...committed.map(toCommitItem)];
}

const KIND_LABEL: Record<GithubActivityItem['kind'], string> = {
  authored: 'Opened/updated PR', reviewed: 'Reviewed PR', committed: 'Committed to',
};

export function formatGithubDigest(items: GithubActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items
    .map((i) => `- ${KIND_LABEL[i.kind]} ${i.kind === 'committed' ? i.repo : `in ${i.repo}`}: "${i.title}"`)
    .join('\n');
}
