/** Trello connect-and-validate, plus real reads — an API key + token the person generates
 *  themselves (trello.com/power-ups/admin), not a single bearer token, so both values are
 *  needed on every call. Storage reuses the generic connection's one `accessToken` column by
 *  concatenating them (`apiKey:token`) at save time and splitting back apart on read — the
 *  same trick genericConnection.ts's other multi-value connectors would use if any needed it.
 *
 *  `getRecentTrelloActivity` reads `GET /1/members/me/actions`, Trello's own real activity
 *  feed for a member (confirmed against Trello's current REST API docs — the "list actions
 *  for a member" endpoint, one of the few in this codebase's connector set with an official,
 *  fully-documented response shape rather than a best guess) — filtered to a handful of
 *  narrative action types (card created/updated/commented/moved/assigned) the same way
 *  eventIngestion.ts's NARRATIVE_TOOLS narrows Claude Code's own hook events, since a raw
 *  actions feed includes plenty of board-administration noise nobody's asking about. */
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'trello';
const API_BASE = 'https://api.trello.com/1';

const NARRATIVE_ACTION_TYPES = ['createCard', 'updateCard', 'commentCard', 'moveCardToBoard', 'addMemberToCard'];
const ACTION_LABEL: Record<string, string> = {
  createCard: 'created', updateCard: 'updated', commentCard: 'commented on',
  moveCardToBoard: 'moved', addMemberToCard: 'was added to',
};

export interface TrelloActivityItem {
  type: string;
  cardName: string | null;
  boardName: string | null;
  date: string;
}

export async function fetchTrelloIdentity(apiKey: string, token: string): Promise<{ username: string } | null> {
  const res = await fetch(`${API_BASE}/members/me?key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { username?: string };
  return data.username ? { username: data.username } : null;
}

/** Real, narrow activity feed: which cards this member touched recently, and how. Throws
 *  on a real API failure (revoked token, real outage) rather than swallowing it — same
 *  contract every other connector's `getRecentXActivity` here follows, since this is what
 *  a future "Verify" check (resourceProviders.ts) also relies on to detect a broken one. */
export async function getRecentTrelloActivity(apiKey: string, token: string, since: Date): Promise<TrelloActivityItem[]> {
  const url = `${API_BASE}/members/me/actions?filter=${NARRATIVE_ACTION_TYPES.join(',')}&limit=50&key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello API failed: ${res.status} ${await res.text()}`);
  const actions = (await res.json()) as { type?: string; date?: string; data?: { card?: { name?: string }; board?: { name?: string } } }[];
  return actions
    .map((a) => ({
      type: String(a.type ?? 'action'),
      cardName: a.data?.card?.name ?? null,
      boardName: a.data?.board?.name ?? null,
      date: String(a.date ?? ''),
    }))
    .filter((a) => a.date && new Date(a.date) >= since);
}

export function formatTrelloDigest(items: TrelloActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items
    .map((i) => {
      const label = ACTION_LABEL[i.type] ?? i.type;
      const card = i.cardName ? `"${i.cardName}"` : 'a card';
      const board = i.boardName ? ` on ${i.boardName}` : '';
      return `- ${label} ${card}${board}`;
    })
    .join('\n');
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

/** Splits the stored `apiKey:token` pair back apart. Neither Trello API keys nor tokens
 *  contain a colon (both are plain hex/alphanumeric), so a simple split is safe here. */
function splitCredential(accessToken: string): { apiKey: string; token: string } | null {
  const idx = accessToken.indexOf(':');
  if (idx === -1) return null;
  return { apiKey: accessToken.slice(0, idx), token: accessToken.slice(idx + 1) };
}

export async function getTrelloConnection(personId: number): Promise<{ apiKey: string; token: string } | null> {
  const conn = await getGenericConnection(PROVIDER, personId);
  return conn ? splitCredential(conn.accessToken) : null;
}

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveTrelloAccountConnection(accountId: number, apiKey: string, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchTrelloIdentity(apiKey, token);
  if (!identity) return { ok: false, error: 'Trello rejected this API key/token pair — check them and try again' };
  await saveGenericAccountConnection(PROVIDER, accountId, `${apiKey}:${token}`, identity.username);
  return { ok: true, label: identity.username };
}
export const getTrelloAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const disconnectTrelloAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
export async function getTrelloAccountConnection(accountId: number): Promise<{ apiKey: string; token: string } | null> {
  const conn = await getGenericAccountConnection(PROVIDER, accountId);
  return conn ? splitCredential(conn.accessToken) : null;
}
