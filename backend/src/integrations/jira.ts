/** Real Jira Cloud reads — an API token the person generates at
 *  id.atlassian.com/manage-profile/security/api-tokens and pastes in alongside their
 *  account email and site URL (no OAuth app to register, same PAT-style shape as GitHub).
 *  Read-only: issues assigned to or reported by them, updated since a given date.
 *
 *  Found live, on the very first real connect: `POST /rest/api/3/search` — what this file
 *  was built against — is gone. Atlassian removed it outright; the real production error
 *  was a clean `410 {"errorMessages":["The requested API has been removed. Please migrate
 *  to the /rest/api/3/search/jql API..."]}`, not a malformed-request failure, confirming
 *  the request shape itself was otherwise correct. `searchIssues` now posts to
 *  `/rest/api/3/search/jql` instead — same `jql`/`fields`/`maxResults` request body, same
 *  response shape (`issues[].key`/`fields.summary`/`fields.status.name`/`fields.updated`),
 *  confirmed via Atlassian's own community documentation of the replacement endpoint. The
 *  new endpoint's pagination uses `nextPageToken` instead of `startAt`/`total` — irrelevant
 *  here, since this connector only ever fetches one page of 25. `fetchJiraIdentity`
 *  (`/rest/api/3/myself`) is untouched — that endpoint was never deprecated.
 *
 *  LIVE-VERIFIED against a real Jira Cloud site, which is what turned up the removal above:
 *  a real person connected their own site in production, the connector reached Atlassian's
 *  real API and came back with that 410, and after the migration the same person confirmed
 *  a real ask answered from their real issues. Worth noting what this replaced — the note
 *  here previously said the request shapes "follow Jira Cloud's documented REST API v3
 *  exactly" and had been checked against invalid credentials, which was true and still left
 *  a connector that could not work at all against a live site. Documented-shape agreement
 *  is not verification. */

export interface JiraActivityItem {
  key: string;
  summary: string;
  status: string;
  role: 'assignee' | 'reporter';
  updatedAt: string;
}

function authHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`;
}

/** Resolves the credentials to a real Jira account — doubles as validating they work at
 *  all. Returns null for invalid credentials/site URL rather than throwing. */
export async function fetchJiraIdentity(siteUrl: string, email: string, apiToken: string): Promise<{ accountId: string; displayName: string } | null> {
  const res = await fetch(`${siteUrl.replace(/\/$/, '')}/rest/api/3/myself`, {
    headers: { authorization: authHeader(email, apiToken), accept: 'application/json' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { accountId?: string; displayName?: string };
  if (!data.accountId) return null;
  return { accountId: data.accountId, displayName: data.displayName ?? email };
}

async function searchIssues(siteUrl: string, email: string, apiToken: string, jql: string, role: JiraActivityItem['role']): Promise<JiraActivityItem[]> {
  const res = await fetch(`${siteUrl.replace(/\/$/, '')}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: {
      authorization: authHeader(email, apiToken),
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jql, fields: ['summary', 'status', 'updated'], maxResults: 25 }),
  });
  if (!res.ok) throw new Error(`Jira search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { issues?: any[] };
  return (data.issues ?? []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary ?? '(no summary)',
    status: i.fields?.status?.name ?? 'unknown',
    role,
    updatedAt: i.fields?.updated ?? new Date().toISOString(),
  }));
}

export async function getRecentJiraActivity(siteUrl: string, email: string, apiToken: string, since: Date): Promise<JiraActivityItem[]> {
  const dateStr = since.toISOString().slice(0, 10);
  const [assigned, reported] = await Promise.all([
    searchIssues(siteUrl, email, apiToken, `assignee = currentUser() AND updated >= "${dateStr}" ORDER BY updated DESC`, 'assignee'),
    searchIssues(siteUrl, email, apiToken, `reporter = currentUser() AND assignee != currentUser() AND updated >= "${dateStr}" ORDER BY updated DESC`, 'reporter'),
  ]);
  return [...assigned, ...reported];
}

export function formatJiraDigest(items: JiraActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items
    .map((i) => `- ${i.role === 'assignee' ? 'Assigned' : 'Reported'} ${i.key} (${i.status}): "${i.summary}"`)
    .join('\n');
}
