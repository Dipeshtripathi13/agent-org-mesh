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
 *  Commits deliberately do NOT go through `/search/commits`, unlike the first version of
 *  this fix. Found live, twice, after that version shipped: a real, connected GitHub with
 *  real recent commits still reported "no commit activity" even after a first bug
 *  (`author:<login>` alone never searching private repos on that endpoint specifically —
 *  fixed by adding a `user:<login>`-scoped query) was fixed. The actual root cause is
 *  bigger than either bug: GitHub's Search API (commits included) is an asynchronous,
 *  Elasticsearch-backed index, not the live git graph — GitHub's own community threads
 *  document real indexing lag from minutes up to 48+ hours, sometimes longer, which makes
 *  it structurally unfit for "what's my *latest* commit," the exact question most likely to
 *  hit that lag. Fixed by dropping `/search/commits` entirely: `getRecentGithubActivity`
 *  now lists the account's most-recently-pushed repos via `GET /user/repos?sort=pushed`
 *  (real-time, authoritative, private repos included once authenticated) and reads each
 *  one's real commit log via `GET /repos/{owner}/{repo}/commits?author=&since=` — the
 *  actual git history, not a search index, confirmed live against a real, very recent
 *  public commit with zero lag. `/search/issues` (PRs/reviews below) doesn't have this
 *  problem — issues/PRs are lower-volume, centrally-indexed objects, not the same
 *  asynchronous code/commit index — and its `author:` qualifier was already confirmed to
 *  include private repos once authenticated, unlike commit search's, so it's unchanged. */

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

/** The real git commit log for one repo, not a search index — real-time, no indexing lag.
 *  A repo with zero commits ever (a genuinely empty repo) returns 409 from this endpoint,
 *  treated the same as "nothing to report" rather than an error; any other per-repo
 *  failure (e.g. a since-deleted or since-archived-with-restricted-access repo) is caught
 *  by the caller and skipped the same way — one repo's own quirk never blocks the rest. */
async function listRepoCommits(token: string, owner: string, name: string, login: string, since: Date): Promise<any[]> {
  const qs = new URLSearchParams({ author: login, since: since.toISOString(), per_page: '10' });
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${name}/commits?${qs}`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } },
  );
  if (res.status === 409) return [];
  if (!res.ok) throw new Error(`GitHub commits failed for ${owner}/${name}: ${res.status} ${await res.text()}`);
  const commits = (await res.json()) as any[];
  return commits.map((c) => ({ ...c, __repo: `${owner}/${name}` }));
}

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

  const toPrItem = (kind: 'authored' | 'reviewed') => (i: any): GithubActivityItem => ({
    kind,
    title: i.title,
    repo: String(i.repository_url ?? '').split('/').slice(-2).join('/'),
    url: i.html_url,
    updatedAt: i.updated_at,
  });
  // Message is trimmed to its first line/120 chars, matching how a PR title reads — never
  // the full commit body, and never a diff or file contents either way.
  const toCommitItem = (c: any): GithubActivityItem => ({
    kind: 'committed',
    title: String(c.commit?.message ?? '').split('\n')[0].slice(0, 120),
    repo: c.__repo ?? '',
    url: c.html_url,
    updatedAt: c.commit?.author?.date ?? '',
  });

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
