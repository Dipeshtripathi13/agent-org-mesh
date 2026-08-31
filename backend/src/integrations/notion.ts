/** Real Notion reads — an internal integration secret the person creates at
 *  notion.so/my-integrations and pastes in, then shares the pages they want read with that
 *  integration from Notion's own UI (Notion has no "grant access to everything" scope —
 *  access is per-page, by design). Read-only: pages the integration can see, last edited
 *  since a given date.
 *
 *  `getRecentNotionActivity` briefly went through Notion's own official MCP server
 *  (`mcp.notion.com/mcp`) as part of the same MCP pilot batch as github.ts/gitlab.ts/
 *  linear.ts — real, sourced reasoning for trying it (the server is open-source and
 *  confirmed to be a thin, auto-generated passthrough of Notion's own `POST /v1/search`,
 *  and the hosted endpoint genuinely accepts this stored integration secret as a plain
 *  bearer token) — but reverted back to plain REST after a real, live test: a genuinely
 *  connected integration, with real page access and every relevant capability enabled,
 *  still got `403 {"code":"restricted_resource","message":"Endpoint unavailable."}` from
 *  Notion's own MCP server specifically, confirmed live via the exact production error
 *  (railway logs, once `server.ts`'s own logging gap was fixed to actually see it). Not a
 *  code bug, not a missing setup step, not a schema mismatch — the connect-time REST call
 *  (`fetchNotionIdentity`) and page sharing both worked correctly with the same token; the
 *  MCP server's own `search` capability specifically appears to be gated behind something
 *  (most likely Notion AI access on the workspace) beyond what a plain internal-
 *  integration secret's normal capabilities grant, and there's no integration-level
 *  setting that unlocks it. Matches this whole pilot's own stated principle — MCP only
 *  where it demonstrably helps, never because using MCP was the goal in itself — Notion's
 *  original REST implementation never had a known bug the way github.ts's commit read
 *  did, and this real test is direct evidence MCP is actively *worse* for it here. UNVERIFIED
 *  beyond that one real, if negative, result — no further real workspace testing has
 *  happened since reverting. */
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'notion';
const API_URL = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

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
  const res = await fetch(`${API_URL}/search`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 25,
    }),
  });
  if (!res.ok) throw new Error(`Notion search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { results?: any[] };
  return (data.results ?? [])
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
