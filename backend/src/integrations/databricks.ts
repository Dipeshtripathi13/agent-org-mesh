/** Real Databricks reads — OAuth service-principal client-credentials (M2M), Databricks'
 *  own current recommendation over a personal access token for automated/service access:
 *  a PAT is tied to a human account and inherits that human's full permissions and lifetime
 *  (revoked the moment they leave), while a service principal is an application-only
 *  identity that can be granted CAN VIEW/CAN READ on specific jobs and nothing else
 *  (docs.databricks.com/aws/en/dev-tools/auth/oauth-m2m). No stored access token: the
 *  service principal's client_id/client_secret are exchanged for a fresh, short-lived
 *  (1-hour) bearer token at call time via the workspace's own `/oidc/v1/token` endpoint —
 *  the same "compute fresh at call time" shape snowflake.ts's per-call JWT already
 *  established here, just an HTTP token exchange instead of local signing.
 *
 *  Same Tier A boundary as airflow.ts/dbtCloud.ts/snowflake.ts (see the data-engineering-
 *  connectors research memo): every request below is a fixed, connector-authored GET
 *  against the Jobs API's own run-status endpoint — did a job run, did it succeed — never
 *  a query an agent constructs, and never a read against real notebook/table contents.
 *
 *  UNVERIFIED AGAINST A REAL DATABRICKS WORKSPACE — built the same way as every other
 *  connector in this project, following Databricks' documented OAuth M2M flow and Jobs API
 *  2.2 exactly, but no real workspace was available to test against yet (see CLAUDE.md's
 *  "where to go next" for this project's honesty convention on that). */
import { isSafeExternalUrl } from './urlSafety.js';
import { formatPipelineDigest, type PipelineRunItem } from './pipelineDigest.js';
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'databricks';

function normalizeWorkspaceUrl(workspaceUrl: string): string {
  return workspaceUrl.replace(/\/+$/, '');
}

/** Exchanges the service principal's client_id/client_secret for a fresh OAuth access
 *  token (client_credentials grant, scope `all-apis` — Databricks' own documented value
 *  for "any REST API this principal is otherwise authorized for") — valid one hour, never
 *  cached or persisted, re-requested on every call. These calls are infrequent enough
 *  (once per ask/ingest, not per request) that this is simpler than tracking expiry, the
 *  same tradeoff snowflake.ts makes for its own per-call JWT. */
async function getAccessToken(workspaceUrl: string, clientId: string, clientSecret: string): Promise<string> {
  const tokenUrl = `${normalizeWorkspaceUrl(workspaceUrl)}/oidc/v1/token`;
  const safety = await isSafeExternalUrl(tokenUrl);
  if (!safety.ok) throw new Error(`Databricks workspace URL rejected: ${safety.reason}`);
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=all-apis',
  });
  if (!res.ok) throw new Error(`Databricks OAuth token request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/** A workspace URL is an admin/user-supplied value this server will fetch() — the same
 *  SSRF shape isSafeExternalUrl already guards for Airflow's siteUrl and an org's own
 *  model-provider endpoint, applied here for the same reason: checked before storage and
 *  again at fetch time (DNS can change between the two), and on both the token exchange
 *  and the actual API call since both are built from the same stored URL. */
async function checkedFetch(workspaceUrl: string, path: string, clientId: string, clientSecret: string): Promise<Response> {
  const url = `${normalizeWorkspaceUrl(workspaceUrl)}${path}`;
  const safety = await isSafeExternalUrl(url);
  if (!safety.ok) throw new Error(`Databricks workspace URL rejected: ${safety.reason}`);
  const token = await getAccessToken(workspaceUrl, clientId, clientSecret);
  return fetch(url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
}

export interface DatabricksActivityItem extends PipelineRunItem {}

/** Resolves the connection to a real, working Databricks workspace — doubles as
 *  validating the service principal's credentials and confirming the workspace URL is
 *  actually reachable and safe. Uses the same run-status endpoint real activity reads,
 *  same pattern as every other connector's identity check in this project. */
export async function fetchDatabricksIdentity(workspaceUrl: string, clientId: string, clientSecret: string): Promise<{ label: string } | null> {
  try {
    const res = await checkedFetch(workspaceUrl, '/api/2.2/jobs/runs/list?limit=1', clientId, clientSecret);
    if (!res.ok) return null;
    const data = (await res.json()) as { runs?: unknown[] };
    return { label: `service principal ${clientId} — ${data.runs?.length ?? 0} run(s) visible` };
  } catch {
    return null;
  }
}

const RESULT_MAP: Record<string, DatabricksActivityItem['status']> = {
  SUCCESS: 'success',
  FAILED: 'failed', TIMEDOUT: 'failed', CANCELED: 'failed', UPSTREAM_FAILED: 'failed', UPSTREAM_CANCELED: 'failed',
};
const LIFECYCLE_MAP: Record<string, DatabricksActivityItem['status']> = {
  RUNNING: 'running', PENDING: 'running', QUEUED: 'running', TERMINATING: 'running', WAITING_FOR_RETRY: 'running', BLOCKED: 'running',
};

export async function getRecentDatabricksActivity(workspaceUrl: string, clientId: string, clientSecret: string, since: Date): Promise<DatabricksActivityItem[]> {
  // job_id is deliberately omitted — Databricks' own documented behavior for this endpoint
  // is to list runs across every job in the workspace when it's left out, the one-call
  // "activity across the whole instance" shape Airflow's dag_id=~ wildcard already gives.
  const res = await checkedFetch(workspaceUrl, '/api/2.2/jobs/runs/list?limit=50', clientId, clientSecret);
  if (!res.ok) throw new Error(`Databricks API failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    runs?: {
      run_id: number;
      run_name?: string;
      status?: { life_cycle_state?: string; result_state?: string };
      state?: { life_cycle_state?: string; result_state?: string };
      start_time?: number;
      end_time?: number;
    }[];
  };
  return (data.runs ?? [])
    .filter((r) => !r.start_time || r.start_time >= since.getTime())
    .map((r) => {
      const lifecycle = r.status?.life_cycle_state ?? r.state?.life_cycle_state ?? '';
      const result = r.status?.result_state ?? r.state?.result_state ?? '';
      return {
        name: r.run_name ?? `run ${r.run_id}`,
        status: RESULT_MAP[result] ?? LIFECYCLE_MAP[lifecycle] ?? 'other',
        finishedAt: r.end_time ? new Date(r.end_time).toISOString() : undefined,
      };
    });
}

export const formatDatabricksDigest = (items: DatabricksActivityItem[]) => formatPipelineDigest(items);

// clientId needs to survive alongside workspaceUrl — packed into site_url the same way
// snowflake.ts packs account+username+warehouse, since there's only one extra storage
// slot; clientSecret is the real secret and goes in the accessToken slot.
function packSite(workspaceUrl: string, clientId: string): string {
  return `${workspaceUrl}|${clientId}`;
}
function unpackSite(siteUrl: string | null): { workspaceUrl: string; clientId: string } {
  const [workspaceUrl, clientId] = (siteUrl ?? '').split('|');
  return { workspaceUrl: workspaceUrl ?? '', clientId: clientId ?? '' };
}

export async function saveDatabricksConnection(personId: number, workspaceUrl: string, clientId: string, clientSecret: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchDatabricksIdentity(workspaceUrl, clientId, clientSecret);
  if (!identity) return { ok: false, error: 'Databricks rejected these credentials — check the workspace URL, client ID, and client secret' };
  await saveGenericConnection(PROVIDER, personId, clientSecret, identity.label, packSite(workspaceUrl, clientId));
  return { ok: true, label: identity.label };
}
export const getDatabricksStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export async function getDatabricksConnection(personId: number) {
  const conn = await getGenericConnection(PROVIDER, personId);
  if (!conn) return null;
  const { workspaceUrl, clientId } = unpackSite(conn.siteUrl);
  return { workspaceUrl, clientId, clientSecret: conn.accessToken };
}
export const disconnectDatabricks = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveDatabricksAccountConnection(accountId: number, workspaceUrl: string, clientId: string, clientSecret: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchDatabricksIdentity(workspaceUrl, clientId, clientSecret);
  if (!identity) return { ok: false, error: 'Databricks rejected these credentials — check the workspace URL, client ID, and client secret' };
  await saveGenericAccountConnection(PROVIDER, accountId, clientSecret, identity.label, packSite(workspaceUrl, clientId));
  return { ok: true, label: identity.label };
}
export const getDatabricksAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export async function getDatabricksAccountConnection(accountId: number) {
  const conn = await getGenericAccountConnection(PROVIDER, accountId);
  if (!conn) return null;
  const { workspaceUrl, clientId } = unpackSite(conn.siteUrl);
  return { workspaceUrl, clientId, clientSecret: conn.accessToken };
}
export const disconnectDatabricksAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
