import * as repo from '../db/repo.js';
import { fetchGithubLogin } from './github.js';

const PROVIDER = 'github';
// person_oauth_tokens.expires_at is NOT NULL — a PAT has no refresh-token dance and GitHub
// doesn't hand back a readable expiry for classic tokens, so this is a deliberate "treat
// as long-lived" placeholder, not a real expiry. If GitHub rejects it later (revoked,
// actually expired), ingestion just gets a 401 and the surface silently stops refreshing —
// same as any other stale connection.
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';

export async function saveGithubConnection(personId: number, token: string): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  const login = await fetchGithubLogin(token);
  if (!login) {
    return { ok: false, error: "GitHub rejected this token — check it's valid and has at least read access" };
  }
  await repo.saveOAuthConnection(personId, {
    provider: PROVIDER,
    accessToken: token,
    refreshToken: null,
    expiresAt: FAR_FUTURE,
    connectedEmail: login, // reusing the generic "connected identity" column for the GitHub login
  });
  return { ok: true, login };
}

export async function getGithubStatus(personId: number): Promise<{ connected: boolean; login: string | null }> {
  const conn = await repo.getOAuthConnection(personId, PROVIDER);
  return { connected: !!conn, login: conn?.connectedEmail ?? null };
}

export async function getGithubConnection(personId: number): Promise<{ token: string; login: string } | null> {
  const conn = await repo.getOAuthConnection(personId, PROVIDER);
  if (!conn || !conn.connectedEmail) return null;
  return { token: conn.accessToken, login: conn.connectedEmail };
}

export async function disconnectGithub(personId: number): Promise<void> {
  await repo.deleteOAuthConnection(personId, PROVIDER);
}

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveGithubAccountConnection(accountId: number, token: string): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  const login = await fetchGithubLogin(token);
  if (!login) {
    return { ok: false, error: "GitHub rejected this token — check it's valid and has at least read access" };
  }
  await repo.saveAccountOAuthConnection(accountId, {
    provider: PROVIDER,
    accessToken: token,
    refreshToken: null,
    expiresAt: FAR_FUTURE,
    connectedEmail: login,
  });
  return { ok: true, login };
}

export async function getGithubAccountStatus(accountId: number): Promise<{ connected: boolean; login: string | null }> {
  const conn = await repo.getAccountOAuthConnection(accountId, PROVIDER);
  return { connected: !!conn, login: conn?.connectedEmail ?? null };
}

export async function getGithubAccountConnection(accountId: number): Promise<{ token: string; login: string } | null> {
  const conn = await repo.getAccountOAuthConnection(accountId, PROVIDER);
  if (!conn || !conn.connectedEmail) return null;
  return { token: conn.accessToken, login: conn.connectedEmail };
}

export async function disconnectGithubAccount(accountId: number): Promise<void> {
  await repo.deleteAccountOAuthConnection(accountId, PROVIDER);
}
