/** Monday.com connect-and-validate — a personal API token, GraphQL API. 'connectable'
 *  tier — see trello.ts's module comment for what that means. */
import {
  saveGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'monday';

export async function fetchMondayIdentity(token: string): Promise<{ name: string } | null> {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { authorization: token, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query { me { name } }' }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { data?: { me?: { name?: string } } };
  return data.data?.me?.name ? { name: data.data.me.name } : null;
}

export async function saveMondayConnection(personId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchMondayIdentity(token);
  if (!identity) return { ok: false, error: 'Monday.com rejected this API token — check it and try again' };
  await saveGenericConnection(PROVIDER, personId, token, identity.name);
  return { ok: true, label: identity.name };
}

export const getMondayStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export const disconnectMonday = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveMondayAccountConnection(accountId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchMondayIdentity(token);
  if (!identity) return { ok: false, error: 'Monday.com rejected this API token — check it and try again' };
  await saveGenericAccountConnection(PROVIDER, accountId, token, identity.name);
  return { ok: true, label: identity.name };
}
export const getMondayAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const disconnectMondayAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
