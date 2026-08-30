/** Trello connect-and-validate — an API key + token the person generates themselves.
 *  `connectorCatalog.ts` marks this 'connectable', not 'live': the credential is
 *  validated live against Trello's real API and stored for real, but no ResourceProvider
 *  reads from it yet (see that file's own module comment on the 'connectable' tier). */
import {
  saveGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'trello';

export async function fetchTrelloIdentity(apiKey: string, token: string): Promise<{ username: string } | null> {
  const res = await fetch(`https://api.trello.com/1/members/me?key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { username?: string };
  return data.username ? { username: data.username } : null;
}

export async function saveTrelloConnection(personId: number, apiKey: string, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchTrelloIdentity(apiKey, token);
  if (!identity) return { ok: false, error: 'Trello rejected this API key/token pair — check them and try again' };
  // Both values are needed to call Trello's API again later — stored concatenated, split
  // back apart on read the same way the pair was combined here.
  await saveGenericConnection(PROVIDER, personId, `${apiKey}:${token}`, identity.username);
  return { ok: true, label: identity.username };
}

export const getTrelloStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export const disconnectTrello = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveTrelloAccountConnection(accountId: number, apiKey: string, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchTrelloIdentity(apiKey, token);
  if (!identity) return { ok: false, error: 'Trello rejected this API key/token pair — check them and try again' };
  await saveGenericAccountConnection(PROVIDER, accountId, `${apiKey}:${token}`, identity.username);
  return { ok: true, label: identity.username };
}
export const getTrelloAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const disconnectTrelloAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
