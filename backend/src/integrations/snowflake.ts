/** Real Snowflake reads — RSA key-pair JWT auth, Snowflake's own documented preference
 *  over password auth for a service account (docs.snowflake.com/en/user-guide/key-pair-auth).
 *  No JWT library dependency: Node's built-in `crypto` module signs and encodes the token
 *  by hand, the same "no new dependency" convention `domain/auth.ts` already uses for
 *  password/session hashing.
 *
 *  The one real guardrail this file exists to enforce (see the data-engineering-connectors
 *  research memo's Tier A/B split): every query below is fixed, connector-authored SQL
 *  against Snowflake's own metadata views (QUERY_HISTORY/TASK_HISTORY) — never a query an
 *  agent constructs from a person's question, and never a SELECT against a real customer
 *  table. That's what keeps this a Tier A "did it run, did it pass" connector rather than
 *  the ad-hoc warehouse-query product the memo explicitly recommends against building.
 *
 *  UNVERIFIED AGAINST A REAL SNOWFLAKE ACCOUNT — built the same way as every other
 *  connector in this project, following Snowflake's documented SQL API and key-pair auth
 *  exactly, but no real account was available to test against yet (see CLAUDE.md's "where
 *  to go next" for this project's honesty convention on that). */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { formatPipelineDigest, type PipelineRunItem } from './pipelineDigest.js';
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'snowflake';

function base64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Builds a fresh 55-minute JWT per call rather than caching one — Snowflake caps token
 *  lifetime at 1 hour regardless of the requested expiry, and these calls are infrequent
 *  enough (once per ask/ingest, not per request) that re-signing every time is simpler
 *  than tracking expiry. Account identifier and username both get uppercased, and any
 *  period in the account identifier becomes a hyphen — both explicit, documented
 *  requirements of the `iss`/`sub` claim format, not a stylistic choice. */
function buildSnowflakeJwt(account: string, username: string, privateKeyPem: string): string {
  const accountId = account.toUpperCase().replace(/\./g, '-');
  const user = username.toUpperCase();
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const fingerprint = `SHA256:${createHash('sha256').update(publicKeyDer).digest('base64')}`;
  const iss = `${accountId}.${user}.${fingerprint}`;
  const sub = `${accountId}.${user}`;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({ iss, sub, iat: now, exp: now + 3300 })));
  const signature = base64url(sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey));
  return `${header}.${payload}.${signature}`;
}

async function runStatement(account: string, username: string, privateKeyPem: string, warehouse: string | null, statement: string): Promise<any> {
  const jwt = buildSnowflakeJwt(account, username, privateKeyPem);
  const res = await fetch(`https://${account.toLowerCase()}.snowflakecomputing.com/api/v2/statements`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      'x-snowflake-authorization-token-type': 'KEYPAIR_JWT',
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ statement, ...(warehouse ? { warehouse } : {}) }),
  });
  if (!res.ok) throw new Error(`Snowflake API failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Column-name-keyed rows (SQL API's default `resultSetMetaData` + `data` shape needs the
 *  column order looked up) — small helper so the two queries below don't each hand-roll
 *  index lookups. */
function rowsAsObjects(result: { resultSetMetaData?: { rowType?: { name: string }[] }; data?: unknown[][] }): Record<string, unknown>[] {
  const columns = (result.resultSetMetaData?.rowType ?? []).map((c) => c.name);
  return (result.data ?? []).map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
}

export interface SnowflakeActivityItem extends PipelineRunItem {}

export async function fetchSnowflakeIdentity(account: string, username: string, privateKeyPem: string, warehouse: string | null): Promise<{ label: string } | null> {
  try {
    const result = await runStatement(account, username, privateKeyPem, warehouse, 'SELECT CURRENT_USER() AS U, CURRENT_ACCOUNT() AS A');
    const rows = rowsAsObjects(result);
    return rows[0] ? { label: `${rows[0].U ?? username}` } : null;
  } catch {
    return null;
  }
}

const STATUS_MAP: Record<string, PipelineRunItem['status']> = {
  SUCCESS: 'success', FAIL: 'failed', FAILED: 'failed', INCIDENT: 'failed', RUNNING: 'running', QUEUED: 'running',
};

export async function getRecentSnowflakeActivity(account: string, username: string, privateKeyPem: string, warehouse: string | null, since: Date): Promise<SnowflakeActivityItem[]> {
  const sinceLiteral = since.toISOString().slice(0, 19).replace('T', ' ');
  const result = await runStatement(
    account, username, privateKeyPem, warehouse,
    `SELECT QUERY_ID, EXECUTION_STATUS, END_TIME FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY()) WHERE START_TIME >= '${sinceLiteral}'::TIMESTAMP_LTZ ORDER BY START_TIME DESC LIMIT 50`,
  );
  return rowsAsObjects(result).map((r) => ({
    name: `query ${String(r.QUERY_ID ?? '').slice(0, 8)}`,
    status: STATUS_MAP[String(r.EXECUTION_STATUS ?? '').toUpperCase()] ?? 'other',
    finishedAt: r.END_TIME ? String(r.END_TIME) : undefined,
  }));
}

export const formatSnowflakeDigest = (items: SnowflakeActivityItem[]) => formatPipelineDigest(items);

// account/username/warehouse all need to survive alongside the private key — packed into
// site_url the same way dbtCloud.ts packs accountId+host, since there's only one extra
// storage slot; warehouse may be empty (optional field).
function packSite(account: string, username: string, warehouse: string): string {
  return `${account}|${username}|${warehouse}`;
}
function unpackSite(siteUrl: string | null): { account: string; username: string; warehouse: string | null } {
  const [account, username, warehouse] = (siteUrl ?? '').split('|');
  return { account: account ?? '', username: username ?? '', warehouse: warehouse || null };
}

export async function saveSnowflakeConnection(personId: number, account: string, username: string, privateKey: string, warehouse: string | null): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchSnowflakeIdentity(account, username, privateKey, warehouse);
  if (!identity) return { ok: false, error: 'Snowflake rejected this key pair — check the account identifier, username, private key, and warehouse' };
  await saveGenericConnection(PROVIDER, personId, privateKey, identity.label, packSite(account, username, warehouse ?? ''));
  return { ok: true, label: identity.label };
}
export const getSnowflakeStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export async function getSnowflakeConnection(personId: number) {
  const conn = await getGenericConnection(PROVIDER, personId);
  if (!conn) return null;
  const { account, username, warehouse } = unpackSite(conn.siteUrl);
  return { account, username, warehouse, privateKey: conn.accessToken };
}
export const disconnectSnowflake = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveSnowflakeAccountConnection(accountId: number, account: string, username: string, privateKey: string, warehouse: string | null): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchSnowflakeIdentity(account, username, privateKey, warehouse);
  if (!identity) return { ok: false, error: 'Snowflake rejected this key pair — check the account identifier, username, private key, and warehouse' };
  await saveGenericAccountConnection(PROVIDER, accountId, privateKey, identity.label, packSite(account, username, warehouse ?? ''));
  return { ok: true, label: identity.label };
}
export const getSnowflakeAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export async function getSnowflakeAccountConnection(accountId: number) {
  const conn = await getGenericAccountConnection(PROVIDER, accountId);
  if (!conn) return null;
  const { account, username, warehouse } = unpackSite(conn.siteUrl);
  return { account, username, warehouse, privateKey: conn.accessToken };
}
export const disconnectSnowflakeAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
