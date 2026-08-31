/** Real GitHub reads — a personal access token the person pastes in themselves (no OAuth
 *  app to register, unlike Gmail). Read-only: pull requests authored, reviews given, and
 *  commits authored, since a given date. Never file contents — matches the surface's own
 *  promised contract in surfaces_catalog ("Pull requests, reviews and commit metadata" /
 *  "File contents are never stored"). Commit metadata was that contract's own long-standing
 *  gap: promised since this connector's first version, never actually fetched, until found
 *  live — a personal ask answered "I don't have access" for a real, connected GitHub
 *  because there was nothing to report from PRs/reviews alone, even though real commits had
 *  happened. `search/commits` needs its own query (`author-date`, not `updated`) and its
 *  own item shape (`commit.message`/`commit.author.date`, not `title`/`updated_at`), but no
 *  special Accept header — the same `application/vnd.github+json` every other call here
 *  already sends.
 *
 *  A real, second bug found immediately after shipping commits: `author:<login>` alone
 *  never searches private repositories on GitHub's commit-search endpoint specifically —
 *  confirmed against GitHub's own docs, and unlike `search/issues` (used for PRs/reviews
 *  above), where `author:` alone does already include private repos once authenticated.
 *  A person asking "what's my latest commit" whose real commits live in private repos (the
 *  common case) got an honest-sounding but wrong "no commit activity" — correctly honest
 *  about what the query found, wrong about what actually happened. Fixed by running a
 *  second query scoped `user:<login>` (repos that account owns, private included once
 *  authenticated as that same account) alongside the original, and merging by commit sha —
 *  the original query still matters on its own, since it also catches commits in repos the
 *  person doesn't own but has pushed to (a public org project, say) that `user:` wouldn't. */

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

async function searchCommits(token: string, query: string): Promise<any[]> {
  const res = await fetch(
    `https://api.github.com/search/commits?q=${encodeURIComponent(query)}&sort=author-date&order=desc&per_page=25`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } },
  );
  if (!res.ok) throw new Error(`GitHub commit search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: any[] };
  return data.items ?? [];
}

export async function getRecentGithubActivity(token: string, login: string, since: Date): Promise<GithubActivityItem[]> {
  const dateStr = since.toISOString().slice(0, 10);
  const [authored, reviewed, committedAnywhere, committedOwnRepos] = await Promise.all([
    searchIssues(token, `type:pr author:${login} updated:>=${dateStr}`),
    searchIssues(token, `type:pr reviewed-by:${login} -author:${login} updated:>=${dateStr}`),
    // Public repos anywhere, or private repos this token can otherwise search — but never
    // private repos on its own, see the module comment above.
    searchCommits(token, `author:${login} author-date:>=${dateStr}`),
    // The other half of that gap: repos this same account owns, private included.
    searchCommits(token, `author:${login} user:${login} author-date:>=${dateStr}`),
  ]);
  // Merged by sha rather than concatenated — the two queries' result sets overlap for any
  // public repo the person owns, and a commit should only ever count once in the digest.
  const committedBySha = new Map<string, any>();
  for (const c of [...committedAnywhere, ...committedOwnRepos]) {
    if (c.sha) committedBySha.set(c.sha, c);
  }
  const committed = [...committedBySha.values()];

  const toPrItem = (kind: 'authored' | 'reviewed') => (i: any): GithubActivityItem => ({
    kind,
    title: i.title,
    repo: String(i.repository_url ?? '').split('/').slice(-2).join('/'),
    url: i.html_url,
    updatedAt: i.updated_at,
  });
  // Commit search's item shape is genuinely different from issue search's — no top-level
  // `title`/`updated_at`, and the repo comes as a full object rather than a URL to slice.
  // Message is trimmed to its first line/120 chars, matching how a PR title reads — never
  // the full commit body, and never a diff or file contents either way.
  const toCommitItem = (c: any): GithubActivityItem => ({
    kind: 'committed',
    title: String(c.commit?.message ?? '').split('\n')[0].slice(0, 120),
    repo: c.repository?.full_name ?? '',
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
