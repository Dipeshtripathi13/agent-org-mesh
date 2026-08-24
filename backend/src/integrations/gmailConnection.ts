import * as repo from '../db/repo.js';
import { fetchUserEmail, refreshAccessToken } from './googleOAuth.js';

const PROVIDER = 'gmail';

/** Returns a valid access token for this person's Gmail connection, refreshing it first
 *  if it's expired. Returns null if nothing is connected. */
export async function getValidGmailAccessToken(personId: number): Promise<string | null> {
  const conn = await repo.getOAuthConnection(personId, PROVIDER);
  if (!conn) return null;

  const expiresAt = new Date(conn.expiresAt).getTime();
  if (Date.now() < expiresAt - 60_000) return conn.accessToken;

  if (!conn.refreshToken) return null;
  const refreshed = await refreshAccessToken(conn.refreshToken);
  const expiresIso = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await repo.saveOAuthConnection(personId, {
    provider: PROVIDER,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? conn.refreshToken,
    expiresAt: expiresIso,
    connectedEmail: conn.connectedEmail,
  });
  return refreshed.access_token;
}

export async function saveGmailConnection(personId: number, tokens: {
  accessToken: string; refreshToken: string | null; expiresIn: number;
}): Promise<void> {
  const email = await fetchUserEmail(tokens.accessToken);
  await repo.saveOAuthConnection(personId, {
    provider: PROVIDER,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
    connectedEmail: email,
  });
}

export async function getGmailStatus(personId: number): Promise<{ connected: boolean; email: string | null }> {
  const conn = await repo.getOAuthConnection(personId, PROVIDER);
  return { connected: !!conn, email: conn?.connectedEmail ?? null };
}

export async function disconnectGmail(personId: number): Promise<void> {
  await repo.deleteOAuthConnection(personId, PROVIDER);
}
