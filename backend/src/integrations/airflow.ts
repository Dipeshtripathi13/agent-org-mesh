/** Real Airflow reads — HTTP Basic auth against a dedicated Viewer-role user, the closest
 *  thing OSS Airflow's REST API has to a scoped read-only token (see the connector-
 *  research memo: Airflow 3.x moved to short-lived JWTs unsuited to a long-lived stored
 *  credential, and managed offerings diverge further — this targets OSS/2.x's Basic-auth
 *  API, the one shape that actually behaves like every other PAT-style connector here).
 *  Read-only by construction: everything below is a GET against Airflow's own REST API,
 *  never a DAG trigger or task action.
 *
 *  UNVERIFIED AGAINST A REAL AIRFLOW INSTANCE — built the same way as every other
 *  connector in this project, following Airflow's documented REST API v1 exactly, but no
 *  real Airflow webserver was available to test against yet (see CLAUDE.md's "where to go
 *  next" for this project's honesty convention on that). */
import { isSafeExternalUrl } from './urlSafety.js';
import { formatPipelineDigest, type PipelineRunItem } from './pipelineDigest.js';
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'airflow';

function authHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/** Self-hosted Airflow webservers commonly sit on a private/internal network — the exact
 *  SSRF shape isSafeExternalUrl already guards for an org's own model-provider endpoint,
 *  applied here for the same reason: this siteUrl is an admin-supplied value this server
 *  will fetch(), checked before storage and again at fetch time (DNS can change between
 *  the two). */
async function checkedFetch(siteUrl: string, path: string, username: string, password: string): Promise<Response> {
  const safety = await isSafeExternalUrl(`${siteUrl}${path}`);
  if (!safety.ok) throw new Error(`Airflow instance URL rejected: ${safety.reason}`);
  return fetch(`${siteUrl.replace(/\/$/, '')}${path}`, {
    headers: { authorization: authHeader(username, password), accept: 'application/json' },
  });
}

export interface AirflowActivityItem extends PipelineRunItem {}

/** Resolves the connection to a real, working Airflow instance — doubles as validating
 *  the credential and confirming the instance URL is actually reachable and safe. */
export async function fetchAirflowIdentity(siteUrl: string, username: string, password: string): Promise<{ label: string } | null> {
  try {
    const res = await checkedFetch(siteUrl, '/api/v1/dags?limit=1', username, password);
    if (!res.ok) return null;
    const data = (await res.json()) as { total_entries?: number };
    return { label: `${username} — ${data.total_entries ?? 0} DAG(s) visible` };
  } catch {
    return null;
  }
}

const STATE_MAP: Record<string, AirflowActivityItem['status']> = {
  success: 'success', failed: 'failed', running: 'running', queued: 'running',
};

export async function getRecentAirflowActivity(siteUrl: string, username: string, password: string, since: Date): Promise<AirflowActivityItem[]> {
  // dag_id=~ is Airflow's own documented wildcard for "every DAG this user can see" on
  // the DAG-runs list endpoint — one call for activity across the whole instance rather
  // than one call per DAG.
  const qs = new URLSearchParams({
    start_date_gte: since.toISOString(),
    order_by: '-start_date',
    limit: '50',
  });
  const res = await checkedFetch(siteUrl, `/api/v1/dags/~/dagRuns?${qs}`, username, password);
  if (!res.ok) throw new Error(`Airflow API failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { dag_runs?: { dag_id: string; state: string; end_date: string | null }[] };
  return (data.dag_runs ?? []).map((r) => ({
    name: r.dag_id,
    status: STATE_MAP[r.state] ?? 'other',
    finishedAt: r.end_date ?? undefined,
  }));
}

export const formatAirflowDigest = (items: AirflowActivityItem[]) => formatPipelineDigest(items);

export async function saveAirflowConnection(personId: number, siteUrl: string, username: string, password: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchAirflowIdentity(siteUrl, username, password);
  if (!identity) return { ok: false, error: 'Airflow rejected these credentials — check the instance URL, username, and password' };
  await saveGenericConnection(PROVIDER, personId, password, identity.label, siteUrl);
  return { ok: true, label: identity.label };
}
export async function getAirflowStatus(personId: number): Promise<{ connected: boolean; label: string | null }> {
  return getGenericConnectionStatus(PROVIDER, personId);
}
export async function getAirflowConnection(personId: number) {
  const conn = await getGenericConnection(PROVIDER, personId);
  if (!conn || !conn.siteUrl) return null;
  return { siteUrl: conn.siteUrl, username: conn.label?.split(' — ')[0] ?? '', password: conn.accessToken };
}
export const disconnectAirflow = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveAirflowAccountConnection(accountId: number, siteUrl: string, username: string, password: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchAirflowIdentity(siteUrl, username, password);
  if (!identity) return { ok: false, error: 'Airflow rejected these credentials — check the instance URL, username, and password' };
  await saveGenericAccountConnection(PROVIDER, accountId, password, identity.label, siteUrl);
  return { ok: true, label: identity.label };
}
export async function getAirflowAccountStatus(accountId: number): Promise<{ connected: boolean; label: string | null }> {
  return getGenericAccountConnectionStatus(PROVIDER, accountId);
}
export async function getAirflowAccountConnection(accountId: number) {
  const conn = await getGenericAccountConnection(PROVIDER, accountId);
  if (!conn || !conn.siteUrl) return null;
  return { siteUrl: conn.siteUrl, username: conn.label?.split(' — ')[0] ?? '', password: conn.accessToken };
}
export const disconnectAirflowAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
