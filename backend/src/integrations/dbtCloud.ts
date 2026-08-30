/** Real dbt Cloud reads — a Service Account Token, which dbt's own docs recommend over a
 *  Personal Access Token for exactly this kind of system integration: it can be scoped to
 *  a Read-Only/Metadata permission set and to specific projects, rather than inheriting
 *  whatever the creating human can do. Read-only by construction: everything below is a
 *  GET against the Admin API, never a job trigger.
 *
 *  UNVERIFIED AGAINST A REAL DBT CLOUD ACCOUNT — built the same way as every other
 *  connector in this project, following dbt Cloud's documented Admin API exactly, but no
 *  real account was available to test against yet (see CLAUDE.md's "where to go next" for
 *  this project's honesty convention on that). */
import { formatPipelineDigest, type PipelineRunItem } from './pipelineDigest.js';
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'dbt';
const DEFAULT_HOST = 'https://cloud.getdbt.com';

// dbt's own run-status codes (Admin API): 1 Queued, 2 Starting, 3 Running, 10 Success,
// 20 Error, 30 Cancelled.
const STATUS_MAP: Record<number, PipelineRunItem['status']> = {
  10: 'success', 20: 'failed', 30: 'failed', 1: 'running', 2: 'running', 3: 'running',
};

function apiBase(host: string | null): string {
  return (host?.trim() || DEFAULT_HOST).replace(/\/$/, '');
}

export interface DbtActivityItem extends PipelineRunItem {}

/** Resolves the token + account id to a real dbt Cloud account — doubles as validating
 *  the token works at all. */
export async function fetchDbtIdentity(token: string, accountId: string, host: string | null): Promise<{ name: string } | null> {
  try {
    const res = await fetch(`${apiBase(host)}/api/v2/accounts/${accountId}/`, {
      headers: { authorization: `Token ${token}`, accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { name?: string } };
    return data.data?.name ? { name: data.data.name } : null;
  } catch {
    return null;
  }
}

export async function getRecentDbtActivity(token: string, accountId: string, host: string | null, since: Date): Promise<DbtActivityItem[]> {
  const qs = new URLSearchParams({ order_by: '-finished_at', limit: '50' });
  const res = await fetch(`${apiBase(host)}/api/v2/accounts/${accountId}/runs/?${qs}`, {
    headers: { authorization: `Token ${token}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`dbt Cloud API failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data?: { job_id: number; job?: { name?: string }; status: number; finished_at: string | null; finished_at_humanized?: string }[] };
  return (data.data ?? [])
    .filter((r) => r.finished_at == null || new Date(r.finished_at) >= since)
    .map((r) => ({
      name: r.job?.name ?? `job ${r.job_id}`,
      status: STATUS_MAP[r.status] ?? 'other',
      finishedAt: r.finished_at ?? undefined,
    }));
}

export const formatDbtDigest = (items: DbtActivityItem[]) => formatPipelineDigest(items);

// account_id and an optional custom host both need to survive alongside the token —
// stored the same way GitLab's optional self-hosted instance URL does, in site_url,
// packed as "accountId|host" (host may be empty) since there's only one extra slot.
function packSite(accountId: string, host: string): string {
  return `${accountId}|${host}`;
}
function unpackSite(siteUrl: string | null): { accountId: string; host: string | null } {
  const [accountId, host] = (siteUrl ?? '').split('|');
  return { accountId: accountId ?? '', host: host || null };
}

export async function saveDbtConnection(personId: number, token: string, accountId: string, host: string | null): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchDbtIdentity(token, accountId, host);
  if (!identity) return { ok: false, error: 'dbt Cloud rejected this token — check the token, account ID, and host' };
  await saveGenericConnection(PROVIDER, personId, token, identity.name, packSite(accountId, host ?? ''));
  return { ok: true, label: identity.name };
}
export const getDbtStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export async function getDbtConnection(personId: number) {
  const conn = await getGenericConnection(PROVIDER, personId);
  if (!conn) return null;
  const { accountId, host } = unpackSite(conn.siteUrl);
  return { token: conn.accessToken, accountId, host };
}
export const disconnectDbt = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveDbtAccountConnection(accountId2: number, token: string, accountId: string, host: string | null): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchDbtIdentity(token, accountId, host);
  if (!identity) return { ok: false, error: 'dbt Cloud rejected this token — check the token, account ID, and host' };
  await saveGenericAccountConnection(PROVIDER, accountId2, token, identity.name, packSite(accountId, host ?? ''));
  return { ok: true, label: identity.name };
}
export const getDbtAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export async function getDbtAccountConnection(accountId: number) {
  const conn = await getGenericAccountConnection(PROVIDER, accountId);
  if (!conn) return null;
  const { accountId: dbtAccountId, host } = unpackSite(conn.siteUrl);
  return { token: conn.accessToken, accountId: dbtAccountId, host };
}
export const disconnectDbtAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
