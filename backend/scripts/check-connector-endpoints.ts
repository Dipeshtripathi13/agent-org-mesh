/**
 * Endpoint-liveness check for every connector whose read endpoint lives on a fixed,
 * publicly reachable host.
 *
 * Why this exists: this project already checks connectors by sending a deliberately
 * invalid credential to the vendor's real API and confirming a clean rejection. Jira
 * passed that check from 2026-08-17 until the first real connect, and still could not
 * work at all — Atlassian had *removed* `POST /rest/api/3/search` outright. An invalid
 * credential returns a clean 401 whether or not the endpoint you're calling still exists,
 * so that check is structurally incapable of catching a vendor deleting or moving an
 * endpoint underneath us. This one is: it reads the *status code* as the signal instead of
 * just "did it fail cleanly".
 *
 *   401 / 403        endpoint is alive, the credential was rejected  -> healthy
 *   404 / 410        endpoint is GONE or moved                       -> the Jira failure mode
 *   400 / 422        ambiguous — reached something, shape may differ
 *   2xx              suspicious: a junk credential should not succeed
 *   network error    inconclusive (DNS/TLS/offline)
 *
 * Deliberately checks the *read* endpoints, not the identity ones: Jira's
 * `/rest/api/3/myself` kept working the whole time it was broken — only the search
 * endpoint had been removed. Checking identity would have reported everything healthy.
 *
 * Not covered, and not a gap this can close: connectors whose host is per-tenant (Jira,
 * Confluence, Zendesk, Airflow, Snowflake, Databricks, self-hosted GitLab) have no fixed
 * URL to probe without a real customer's site. Those still depend on a real connect.
 *
 * **Run this from production, not a laptop, before believing a network failure.** Confirmed
 * the hard way: `api.githubcopilot.com` (GitHub's MCP server, which backs the commit read)
 * resets every connection from at least one dev environment while `api.github.com` from the
 * same machine is fine — so locally it looks exactly like GitHub deleted the endpoint. From
 * the deployed container the same request returns `401 unauthorized: AuthenticateToken
 * authentication failed`, i.e. perfectly healthy. A reset/timeout here is a statement about
 * your egress until you've reproduced it somewhere that actually serves users:
 *
 *   railway ssh 'cd /app/backend && npx tsx scripts/check-connector-endpoints.ts'
 *
 * Note GitHub's MCP server rejects a *malformed* Authorization header with 400 before it
 * ever evaluates the credential, so probe it with something PAT-shaped (`ghp_` + 36 chars)
 * to get the meaningful 401 rather than a shape complaint.
 *
 * The URLs below intentionally mirror the client modules rather than importing from them —
 * the modules build URLs inline, mid-request, from per-connection values. Keep them in
 * sync when a connector's endpoint changes; a drift here shows up as a false 404.
 *
 *   npx tsx scripts/check-connector-endpoints.ts
 */
interface Probe {
  tool: string;
  what: string;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

const JUNK = 'definitely-not-a-real-credential-0000';
// GitHub's MCP server 400s on a malformed Authorization header before it ever checks the
// credential, so its probes need something PAT-shaped to reach the real 401.
const JUNK_PAT = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

const PROBES: Probe[] = [
  {
    tool: 'linear', what: 'MCP list_issues (mcp.linear.app)', url: 'https://mcp.linear.app/mcp', method: 'POST',
    headers: { authorization: `Bearer ${JUNK}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  },
  {
    tool: 'linear', what: 'GraphQL identity (api.linear.app)', url: 'https://api.linear.app/graphql', method: 'POST',
    headers: { authorization: JUNK, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query { viewer { name } }' }),
  },
  {
    tool: 'github', what: 'MCP list_commits (api.githubcopilot.com)', url: 'https://api.githubcopilot.com/mcp/', method: 'POST',
    headers: { authorization: `Bearer ${JUNK_PAT}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  },
  {
    tool: 'github', what: 'REST repo list (api.github.com)', url: 'https://api.github.com/user/repos?sort=pushed&per_page=1',
    headers: { authorization: `Bearer ${JUNK_PAT}`, accept: 'application/vnd.github+json' },
  },
  {
    tool: 'gitlab', what: 'MCP list_merge_requests (gitlab.com)', url: 'https://gitlab.com/api/v4/mcp', method: 'POST',
    headers: { authorization: `Bearer ${JUNK}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  },
  {
    tool: 'notion', what: 'REST search (api.notion.com)', url: 'https://api.notion.com/v1/search', method: 'POST',
    headers: { authorization: `Bearer ${JUNK}`, 'Notion-Version': '2022-06-28', 'content-type': 'application/json' },
    body: JSON.stringify({ filter: { property: 'object', value: 'page' }, page_size: 1 }),
  },
  {
    tool: 'asana', what: 'tasks read', url: 'https://app.asana.com/api/1.0/tasks?limit=1',
    headers: { authorization: `Bearer ${JUNK}` },
  },
  {
    tool: 'hubspot', what: 'deals search', url: 'https://api.hubapi.com/crm/v3/objects/deals/search', method: 'POST',
    headers: { authorization: `Bearer ${JUNK}`, 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 1 }),
  },
  { tool: 'airtable', what: 'meta/whoami', url: 'https://api.airtable.com/v0/meta/whoami', headers: { authorization: `Bearer ${JUNK}` } },
  { tool: 'figma', what: 'v1/me', url: 'https://api.figma.com/v1/me', headers: { 'X-Figma-Token': JUNK } },
  { tool: 'discord', what: 'users/@me', url: 'https://discord.com/api/v10/users/@me', headers: { authorization: `Bot ${JUNK}` } },
  { tool: 'trello', what: 'members/me', url: `https://api.trello.com/1/members/me?key=${JUNK}&token=${JUNK}` },
  {
    tool: 'monday', what: 'v2 GraphQL', url: 'https://api.monday.com/v2', method: 'POST',
    headers: { authorization: JUNK, 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ me { name } }' }),
  },
  { tool: 'dbt', what: 'cloud API accounts', url: 'https://cloud.getdbt.com/api/v2/accounts/', headers: { authorization: `Token ${JUNK}` } },
];

function classify(status: number): { verdict: string; ok: boolean | null } {
  if (status === 401 || status === 403) return { verdict: 'alive (credential rejected)', ok: true };
  if (status === 404 || status === 410) return { verdict: 'ENDPOINT GONE', ok: false };
  if (status >= 200 && status < 300) return { verdict: 'SUSPICIOUS: junk credential accepted', ok: false };
  if (status === 400 || status === 422) return { verdict: 'ambiguous (reached it; shape may differ)', ok: null };
  if (status === 429) return { verdict: 'rate-limited (alive)', ok: true };
  return { verdict: `unexpected ${status}`, ok: null };
}

let gone = 0;
let inconclusive = 0;

for (const p of PROBES) {
  const label = `${p.tool.padEnd(9)} ${p.what.padEnd(38)}`;
  try {
    const res = await fetch(p.url, {
      method: p.method ?? 'GET',
      headers: p.headers,
      body: p.body,
      signal: AbortSignal.timeout(20000),
    });
    const { verdict, ok } = classify(res.status);
    if (ok === false) gone += 1;
    if (ok === null) inconclusive += 1;
    const mark = ok === true ? 'ok  ' : ok === false ? 'FAIL' : '??  ';
    console.log(`${mark} ${label} ${String(res.status).padEnd(4)} ${verdict}`);
  } catch (e) {
    inconclusive += 1;
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`??   ${label} ---  network/TLS error: ${msg}`);
    console.log(`     ${' '.repeat(label.length)}      probably local egress, not the vendor — re-run from the deployed container before concluding anything`);
  }
}

console.log(`\n${PROBES.length} probes · ${gone} endpoint(s) gone or suspicious · ${inconclusive} inconclusive`);
if (gone > 0) process.exitCode = 1;
