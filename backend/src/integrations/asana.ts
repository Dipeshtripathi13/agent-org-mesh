/** Real Asana reads — a personal access token the person pastes in themselves (no OAuth
 *  app to register, same PAT-style shape as GitHub). Read-only: tasks assigned to them,
 *  modified since a given date.
 *
 *  UNVERIFIED AGAINST A REAL WORKSPACE — built the same way as every other connector in
 *  this project, following Asana's documented REST API exactly, but no real Asana
 *  workspace was available to test against yet. */
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'asana';
const API_URL = 'https://app.asana.com/api/1.0';

export interface AsanaActivityItem {
  name: string;
  completed: boolean;
  url: string;
  modifiedAt: string;
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Resolves the token to a real Asana user — doubles as validating it works at all.
 *  Also returns their first real workspace gid: the /tasks search below requires one
 *  (a *workspace* gid, not the user's own — a real mistake caught during review), and
 *  `/users/me` is the one call that already returns both in one round trip. */
export async function fetchAsanaIdentity(token: string): Promise<{ name: string; gid: string; workspaceGid: string | null } | null> {
  const res = await fetch(`${API_URL}/users/me?opt_fields=name,workspaces.gid`, { headers: headers(token) });
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: { name?: string; gid?: string; workspaces?: { gid: string }[] } };
  if (!data.data?.gid) return null;
  return { name: data.data.name ?? 'Asana user', gid: data.data.gid, workspaceGid: data.data.workspaces?.[0]?.gid ?? null };
}

export async function getRecentAsanaActivity(token: string, since: Date): Promise<AsanaActivityItem[]> {
  const identity = await fetchAsanaIdentity(token);
  if (!identity?.workspaceGid) return [];
  const params = new URLSearchParams({
    assignee: identity.gid,
    workspace: identity.workspaceGid,
    modified_since: since.toISOString(),
    'opt_fields': 'name,completed,modified_at,permalink_url',
  });
  const res = await fetch(`${API_URL}/tasks?${params.toString()}`, { headers: headers(token) });
  if (!res.ok) throw new Error(`Asana search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data?: any[] };
  return (data.data ?? []).map((t) => ({
    name: t.name,
    completed: !!t.completed,
    url: t.permalink_url,
    modifiedAt: t.modified_at,
  }));
}

export function formatAsanaDigest(items: AsanaActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `- ${i.completed ? 'Completed' : 'Updated'} task "${i.name}"`).join('\n');
}

export async function saveAsanaConnection(personId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchAsanaIdentity(token);
  if (!identity) return { ok: false, error: 'Asana rejected this access token — check it and try again' };
  await saveGenericConnection(PROVIDER, personId, token, identity.name);
  return { ok: true, label: identity.name };
}

export const getAsanaStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export const getAsanaConnection = (personId: number) => getGenericConnection(PROVIDER, personId);
export const disconnectAsana = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveAsanaAccountConnection(accountId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchAsanaIdentity(token);
  if (!identity) return { ok: false, error: 'Asana rejected this access token — check it and try again' };
  await saveGenericAccountConnection(PROVIDER, accountId, token, identity.name);
  return { ok: true, label: identity.name };
}
export const getAsanaAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const getAsanaAccountConnection = (accountId: number) => getGenericAccountConnection(PROVIDER, accountId);
export const disconnectAsanaAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
