/** Real Notion reads — an internal integration secret the person creates at
 *  notion.so/my-integrations and pastes in, then shares the pages they want read with that
 *  integration from Notion's own UI (Notion has no "grant access to everything" scope —
 *  access is per-page, by design). Read-only: pages the integration can see, last edited
 *  since a given date.
 *
 *  The activity read (`getRecentNotionActivity`) goes through Notion's own official,
 *  open-source MCP server (`github.com/makenotion/notion-mcp-server`, hosted remotely at
 *  `https://mcp.notion.com/mcp`) instead of a direct REST call — part of the same MCP
 *  pilot batch as github.ts/gitlab.ts/linear.ts, following github.ts's own established
 *  discipline of verifying the real schema before writing mapping code rather than
 *  guessing. Confirmed directly against the server's real source, not assumed: its `search`
 *  tool (`post-search`, name taken from the OpenAPI `operationId` the server is generated
 *  from — `scripts/notion-openapi.json`) is a thin, auto-generated passthrough of Notion's
 *  own `POST /v1/search` — same request shape (`query`/`sort`/`filter`), same response
 *  shape, confirmed by the README's own description of how it plans tool calls
 *  ("v1/search and v1/comments") and by the OpenAPI spec's request schema matching this
 *  file's existing request body field-for-field. Also live-confirmed the hosted endpoint
 *  genuinely accepts this same stored integration secret as a plain bearer token (not
 *  OAuth-only, unlike the interactive-client default): a deliberately invalid token
 *  produced Notion's own real REST API error shape
 *  (`{"object":"error","status":401,"code":"unauthorized","message":"API token is invalid."}`),
 *  proving the request reached Notion's real auth layer through the MCP endpoint. Because
 *  the tool is a thin passthrough, the existing response-parsing logic below
 *  (`pageTitle`, `results[].url`/`last_edited_time`) needed no changes at all — same as
 *  github.ts's own commit mapping.
 *
 *  `fetchNotionIdentity`/connection storage stay on plain REST, deliberately not migrated
 *  — same reasoning as github.ts's `fetchGithubLogin`: not part of what this migration
 *  fixes, and keeping it means "connect a token" still works even if the MCP path has a
 *  bad day. UNVERIFIED against a real workspace either way — this file has never been
 *  tested against a real Notion account, MCP or REST. */
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';
import { withMcpSession } from './mcpClient.js';

const PROVIDER = 'notion';
const API_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const NOTION_MCP_URL = 'https://mcp.notion.com/mcp';

export interface NotionActivityItem {
  title: string;
  url: string;
  lastEditedAt: string;
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'content-type': 'application/json' };
}

/** Resolves the token to the real bot/integration identity — doubles as validating it
 *  works at all. */
export async function fetchNotionIdentity(token: string): Promise<{ name: string } | null> {
  const res = await fetch(`${API_URL}/users/me`, { headers: headers(token) });
  if (!res.ok) return null;
  const data = (await res.json()) as { name?: string; bot?: { owner?: { user?: { name?: string } } } };
  return { name: data.name ?? data.bot?.owner?.user?.name ?? 'Notion integration' };
}

function pageTitle(page: any): string {
  const props = page.properties ?? {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const text = prop.title.map((t: any) => t.plain_text).join('');
      if (text) return text;
    }
  }
  return '(untitled page)';
}

export async function getRecentNotionActivity(token: string, since: Date): Promise<NotionActivityItem[]> {
  const data = await withMcpSession(NOTION_MCP_URL, token, (callTool) => callTool('post-search', {
    filter: { property: 'object', value: 'page' },
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
    page_size: 25,
  })) as { results?: any[] } | null;
  return (data?.results ?? [])
    .filter((p) => new Date(p.last_edited_time) >= since)
    .map((p) => ({ title: pageTitle(p), url: p.url, lastEditedAt: p.last_edited_time }));
}

export function formatNotionDigest(items: NotionActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `- Edited "${i.title}"`).join('\n');
}

export async function saveNotionConnection(personId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchNotionIdentity(token);
  if (!identity) return { ok: false, error: 'Notion rejected this integration secret — check it and try again' };
  await saveGenericConnection(PROVIDER, personId, token, identity.name);
  return { ok: true, label: identity.name };
}

export const getNotionStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export const getNotionConnection = (personId: number) => getGenericConnection(PROVIDER, personId);
export const disconnectNotion = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveNotionAccountConnection(accountId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchNotionIdentity(token);
  if (!identity) return { ok: false, error: 'Notion rejected this integration secret — check it and try again' };
  await saveGenericAccountConnection(PROVIDER, accountId, token, identity.name);
  return { ok: true, label: identity.name };
}
export const getNotionAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const getNotionAccountConnection = (accountId: number) => getGenericAccountConnection(PROVIDER, accountId);
export const disconnectNotionAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
