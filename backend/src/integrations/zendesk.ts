/** Real Zendesk reads — an API token the person generates themselves, alongside their
 *  account email and subdomain (no OAuth app to register, same PAT-style shape as
 *  GitHub/Jira). Read-only: tickets assigned to them, updated since a given date.
 *
 *  UNVERIFIED AGAINST A REAL ACCOUNT — built the same way as every other connector in
 *  this project, following Zendesk's documented REST API exactly, but no real Zendesk
 *  account was available to test against yet. */
import {
  saveGenericConnection, getGenericConnection, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'zendesk';

export interface ZendeskActivityItem {
  subject: string;
  status: string;
  url: string;
  updatedAt: string;
}

function authHeader(email: string, apiToken: string): string {
  // Zendesk's token auth format is "<email>/token:<api_token>", Basic-encoded.
  return `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString('base64')}`;
}

function base(subdomain: string): string {
  return `https://${subdomain.trim().replace(/\.zendesk\.com.*$/i, '')}.zendesk.com`;
}

/** Resolves the credentials to a real Zendesk agent — doubles as validating them. */
export async function fetchZendeskIdentity(subdomain: string, email: string, apiToken: string): Promise<{ name: string } | null> {
  const res = await fetch(`${base(subdomain)}/api/v2/users/me.json`, {
    headers: { authorization: authHeader(email, apiToken), accept: 'application/json' },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { user?: { name?: string } };
  return data.user?.name ? { name: data.user.name } : null;
}

export async function getRecentZendeskActivity(subdomain: string, email: string, apiToken: string, since: Date): Promise<ZendeskActivityItem[]> {
  const query = `assignee:me updated>${since.toISOString().slice(0, 10)}`;
  const res = await fetch(
    `${base(subdomain)}/api/v2/search.json?query=${encodeURIComponent(query)}&sort_by=updated_at&sort_order=desc`,
    { headers: { authorization: authHeader(email, apiToken), accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Zendesk search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { results?: any[] };
  return (data.results ?? [])
    .filter((r) => r.result_type === 'ticket')
    .slice(0, 25)
    .map((t) => ({
      subject: t.subject ?? '(no subject)',
      status: t.status ?? 'unknown',
      url: `${base(subdomain)}/agent/tickets/${t.id}`,
      updatedAt: t.updated_at,
    }));
}

export function formatZendeskDigest(items: ZendeskActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `- Ticket (${i.status}): "${i.subject}"`).join('\n');
}

export async function saveZendeskConnection(
  personId: number,
  subdomain: string,
  email: string,
  apiToken: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchZendeskIdentity(subdomain, email, apiToken);
  if (!identity) return { ok: false, error: 'Zendesk rejected these credentials — check the subdomain, email, and API token' };
  await saveGenericConnection(PROVIDER, personId, apiToken, email, subdomain.trim());
  return { ok: true, label: identity.name };
}

export async function getZendeskStatus(personId: number): Promise<{ connected: boolean; email: string | null; subdomain: string | null }> {
  const conn = await getGenericConnection(PROVIDER, personId);
  return { connected: !!conn, email: conn?.label ?? null, subdomain: conn?.siteUrl ?? null };
}
export async function getZendeskConnection(personId: number) {
  const conn = await getGenericConnection(PROVIDER, personId);
  if (!conn || !conn.label || !conn.siteUrl) return null;
  return { apiToken: conn.accessToken, email: conn.label, subdomain: conn.siteUrl };
}
export const disconnectZendesk = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveZendeskAccountConnection(
  accountId: number,
  subdomain: string,
  email: string,
  apiToken: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchZendeskIdentity(subdomain, email, apiToken);
  if (!identity) return { ok: false, error: 'Zendesk rejected these credentials — check the subdomain, email, and API token' };
  await saveGenericAccountConnection(PROVIDER, accountId, apiToken, email, subdomain.trim());
  return { ok: true, label: identity.name };
}
export async function getZendeskAccountStatus(accountId: number): Promise<{ connected: boolean; email: string | null; subdomain: string | null }> {
  const conn = await getGenericAccountConnection(PROVIDER, accountId);
  return { connected: !!conn, email: conn?.label ?? null, subdomain: conn?.siteUrl ?? null };
}
export async function getZendeskAccountConnection(accountId: number) {
  const conn = await getGenericAccountConnection(PROVIDER, accountId);
  if (!conn || !conn.label || !conn.siteUrl) return null;
  return { apiToken: conn.accessToken, email: conn.label, subdomain: conn.siteUrl };
}
export const disconnectZendeskAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
