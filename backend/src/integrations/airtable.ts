/** Airtable connect-and-validate — a personal access token the person creates themselves.
 *  'connectable' tier — see trello.ts's module comment for what that means. */
import {
  saveGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'airtable';

export async function fetchAirtableIdentity(token: string): Promise<{ id: string } | null> {
  const res = await fetch('https://api.airtable.com/v0/meta/whoami', { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const data = (await res.json()) as { id?: string };
  return data.id ? { id: data.id } : null;
}

export async function saveAirtableConnection(personId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchAirtableIdentity(token);
  if (!identity) return { ok: false, error: 'Airtable rejected this access token — check it and try again' };
  await saveGenericConnection(PROVIDER, personId, token, identity.id);
  return { ok: true, label: identity.id };
}

export const getAirtableStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export const disconnectAirtable = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveAirtableAccountConnection(accountId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchAirtableIdentity(token);
  if (!identity) return { ok: false, error: 'Airtable rejected this access token — check it and try again' };
  await saveGenericAccountConnection(PROVIDER, accountId, token, identity.id);
  return { ok: true, label: identity.id };
}
export const getAirtableAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const disconnectAirtableAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
