/** Figma connect-and-validate — a personal access token the person creates themselves.
 *  'connectable' tier — see trello.ts's module comment for what that means. */
import {
  saveGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'figma';

export async function fetchFigmaIdentity(token: string): Promise<{ handle: string } | null> {
  const res = await fetch('https://api.figma.com/v1/me', { headers: { 'X-Figma-Token': token } });
  if (!res.ok) return null;
  const data = (await res.json()) as { handle?: string };
  return data.handle ? { handle: data.handle } : null;
}

export async function saveFigmaConnection(personId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchFigmaIdentity(token);
  if (!identity) return { ok: false, error: 'Figma rejected this access token — check it and try again' };
  await saveGenericConnection(PROVIDER, personId, token, identity.handle);
  return { ok: true, label: identity.handle };
}

export const getFigmaStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export const disconnectFigma = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveFigmaAccountConnection(accountId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchFigmaIdentity(token);
  if (!identity) return { ok: false, error: 'Figma rejected this access token — check it and try again' };
  await saveGenericAccountConnection(PROVIDER, accountId, token, identity.handle);
  return { ok: true, label: identity.handle };
}
export const getFigmaAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const disconnectFigmaAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
