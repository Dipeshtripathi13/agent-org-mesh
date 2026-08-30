/** Discord connect-and-validate — a bot token the person creates in Discord's developer
 *  portal and adds to a server themselves. 'connectable' tier — see trello.ts's module
 *  comment for what that means. */
import {
  saveGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'discord';

export async function fetchDiscordIdentity(token: string): Promise<{ username: string } | null> {
  const res = await fetch('https://discord.com/api/v10/users/@me', { headers: { authorization: `Bot ${token}` } });
  if (!res.ok) return null;
  const data = (await res.json()) as { username?: string };
  return data.username ? { username: data.username } : null;
}

export async function saveDiscordConnection(personId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchDiscordIdentity(token);
  if (!identity) return { ok: false, error: 'Discord rejected this bot token — check it and try again' };
  await saveGenericConnection(PROVIDER, personId, token, identity.username);
  return { ok: true, label: identity.username };
}

export const getDiscordStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export const disconnectDiscord = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveDiscordAccountConnection(accountId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchDiscordIdentity(token);
  if (!identity) return { ok: false, error: 'Discord rejected this bot token — check it and try again' };
  await saveGenericAccountConnection(PROVIDER, accountId, token, identity.username);
  return { ok: true, label: identity.username };
}
export const getDiscordAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const disconnectDiscordAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
