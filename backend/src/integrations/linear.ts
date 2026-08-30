/** Real Linear reads — a personal API key the person pastes in themselves (no OAuth app
 *  to register, same PAT-style shape as GitHub). Read-only: issues assigned to them,
 *  updated since a given date, via Linear's GraphQL API.
 *
 *  UNVERIFIED AGAINST A REAL WORKSPACE — built the same way as every other connector in
 *  this project, following Linear's documented GraphQL API exactly, but no real Linear
 *  workspace was available to test against yet (see CLAUDE.md's "where to go next" for
 *  this project's honesty convention on that). */
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'linear';
const API_URL = 'https://api.linear.app/graphql';

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

export async function getRecentLinearActivity(apiKey: string, since: Date): Promise<LinearActivityItem[]> {
  const data = await graphql(
    apiKey,
    `query($since: DateTimeOrDuration) {
      issues(filter: { assignee: { isMe: { eq: true } }, updatedAt: { gte: $since } }, first: 25) {
        nodes { identifier title url updatedAt state { name } }
      }
    }`,
    { since: since.toISOString() },
  );
  const nodes = data?.issues?.nodes ?? [];
  return nodes.map((n: any) => ({
    identifier: n.identifier,
    title: n.title,
    status: n.state?.name ?? 'unknown',
    url: n.url,
    updatedAt: n.updatedAt,
  }));
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
