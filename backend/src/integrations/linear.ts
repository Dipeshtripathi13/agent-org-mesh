/** Real Linear reads — a personal API key the person pastes in themselves (no OAuth app
 *  to register, same PAT-style shape as GitHub). Read-only: issues assigned to them,
 *  updated since a given date.
 *
 *  `getRecentLinearActivity` goes through Linear's own official, remote-hosted MCP server
 *  (`https://mcp.linear.app/mcp`) instead of the GraphQL API — part of the same MCP pilot
 *  batch as github.ts/notion.ts/gitlab.ts, and deliberately the least-confident of the
 *  three: Linear's MCP server is closed-source, its docs never publish a tool reference,
 *  and the live server requires real authentication even for `tools/list` discovery — so
 *  unlike github.ts (real Go source) and notion.ts (real OpenAPI spec confirming an exact
 *  passthrough), there is no way to verify the real tool name or response shape without a
 *  real Linear API key, which wasn't available. What *is* confirmed live: Linear's docs
 *  state the MCP server accepts a plain personal API key as `Authorization: Bearer
 *  <token>` (no OAuth flow required for a server-side integration like this one), and
 *  `list_issues` is the tool name multiple independent, if unofficial, references agree
 *  on, with an `assignedToMe` boolean filter matching this file's own existing intent.
 *  Response field names are genuinely a best guess, so parsing below tries several
 *  plausible key spellings per field rather than assuming one exact shape, and degrades to
 *  an empty digest — never a crash or fabricated data — for anything it can't confidently
 *  read. Revisit this file first, before gitlab.ts or notion.ts, once a real Linear
 *  account is available to test against; it carries by far the least real evidence.
 *
 *  `fetchLinearIdentity`/connection storage stay on Linear's GraphQL API, unchanged and
 *  deliberately not migrated — same reasoning as every sibling connector in this batch.
 *  UNVERIFIED against a real workspace either way — this file has never been tested
 *  against a real Linear account, MCP or GraphQL. */
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';
import { withMcpSession } from './mcpClient.js';

const PROVIDER = 'linear';
const API_URL = 'https://api.linear.app/graphql';
const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';

export interface LinearActivityItem {
  identifier: string;
  title: string;
  status: string;
  url: string;
  updatedAt: string;
}

async function graphql(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(API_URL, {
    method: 'POST',
    // Linear's personal API keys go in Authorization unprefixed — no "Bearer".
    headers: { authorization: apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data?: any; errors?: { message: string }[] };
  if (data.errors?.length) throw new Error(`Linear API error: ${data.errors.map((e) => e.message).join('; ')}`);
  return data.data;
}

/** Resolves the key to a real Linear viewer — doubles as validating it works at all. */
export async function fetchLinearIdentity(apiKey: string): Promise<{ name: string } | null> {
  try {
    const data = await graphql(apiKey, 'query { viewer { name } }');
    return data?.viewer?.name ? { name: data.viewer.name } : null;
  } catch {
    return null;
  }
}

// Genuinely uncertain which of these key spellings the real tool returns — see the module
// comment above. Tries each candidate in order and takes the first defined value, rather
// than assuming one exact shape.
function pick(obj: any, keys: string[]): any {
  for (const k of keys) {
    if (obj?.[k] != null) return obj[k];
  }
  return undefined;
}

export async function getRecentLinearActivity(apiKey: string, since: Date): Promise<LinearActivityItem[]> {
  const result = await withMcpSession(LINEAR_MCP_URL, apiKey, (callTool) => callTool('list_issues', {
    assignedToMe: true,
    sortBy: 'updatedAt',
    sortDirection: 'DESC',
    limit: 25,
  }));
  const nodes: any[] = Array.isArray(result) ? result : ((result as any)?.issues ?? []);
  return nodes
    .map((n) => {
      const status = pick(n, ['status', 'state']);
      return {
        identifier: String(pick(n, ['identifier', 'id']) ?? ''),
        title: String(pick(n, ['title']) ?? ''),
        status: typeof status === 'string' ? status : (status?.name ?? 'unknown'),
        url: String(pick(n, ['url']) ?? ''),
        updatedAt: String(pick(n, ['updatedAt', 'updated_at']) ?? ''),
      };
    })
    .filter((n) => n.identifier && n.updatedAt && new Date(n.updatedAt) >= since);
}

export function formatLinearDigest(items: LinearActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `- ${i.identifier} (${i.status}): "${i.title}"`).join('\n');
}

export async function saveLinearConnection(personId: number, apiKey: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchLinearIdentity(apiKey);
  if (!identity) return { ok: false, error: 'Linear rejected this API key — check it and try again' };
  await saveGenericConnection(PROVIDER, personId, apiKey, identity.name);
  return { ok: true, label: identity.name };
}

export const getLinearStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export const getLinearConnection = (personId: number) => getGenericConnection(PROVIDER, personId);
export const disconnectLinear = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveLinearAccountConnection(accountId: number, apiKey: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchLinearIdentity(apiKey);
  if (!identity) return { ok: false, error: 'Linear rejected this API key — check it and try again' };
  await saveGenericAccountConnection(PROVIDER, accountId, apiKey, identity.name);
  return { ok: true, label: identity.name };
}
export const getLinearAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const getLinearAccountConnection = (accountId: number) => getGenericAccountConnection(PROVIDER, accountId);
export const disconnectLinearAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
