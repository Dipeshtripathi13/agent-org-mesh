/** Real GitHub reads — a personal access token the person pastes in themselves (no OAuth
 *  app to register, unlike Gmail). Read-only: pull requests authored and reviews given,
 *  since a given date. Never file contents — matches the surface's own promised contract
 *  in surfaces_catalog ("Pull requests, reviews and commit metadata" / "File contents are
 *  never stored"). Commit metadata is a natural v2 addition (the search/commits endpoint
 *  needs a different Accept header and its own pagination); PRs + reviews is what v1 reads. */

export interface GithubActivityItem {
  kind: 'authored' | 'reviewed';
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

export async function getRecentGithubActivity(token: string, login: string, since: Date): Promise<GithubActivityItem[]> {
  const dateStr = since.toISOString().slice(0, 10);
  const [authored, reviewed] = await Promise.all([
    searchIssues(token, `type:pr author:${login} updated:>=${dateStr}`),
    searchIssues(token, `type:pr reviewed-by:${login} -author:${login} updated:>=${dateStr}`),
  ]);

  const toItem = (kind: GithubActivityItem['kind']) => (i: any): GithubActivityItem => ({
    kind,
    title: i.title,
    repo: String(i.repository_url ?? '').split('/').slice(-2).join('/'),
    url: i.html_url,
    updatedAt: i.updated_at,
  });

  return [...authored.map(toItem('authored')), ...reviewed.map(toItem('reviewed'))];
}

export function formatGithubDigest(items: GithubActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items
    .map((i) => `- ${i.kind === 'authored' ? 'Opened/updated' : 'Reviewed'} PR in ${i.repo}: "${i.title}"`)
    .join('\n');
}
