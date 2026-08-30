/** Real HubSpot reads — a private app access token the person creates themselves (no
 *  OAuth app to register, same PAT-style shape as GitHub). Read-only: deals owned by
 *  them, modified since a given date.
 *
 *  UNVERIFIED AGAINST A REAL PORTAL — built the same way as every other connector in this
 *  project, following HubSpot's documented CRM API exactly, but no real HubSpot portal
 *  was available to test against yet. */
import {
  saveGenericConnection, getGenericConnection, getGenericConnectionStatus, disconnectGeneric,
  saveGenericAccountConnection, getGenericAccountConnection, getGenericAccountConnectionStatus, disconnectGenericAccount,
} from './genericConnection.js';

const PROVIDER = 'hubspot';
const API_URL = 'https://api.hubapi.com';

export interface HubspotActivityItem {
  name: string;
  stage: string;
  updatedAt: string;
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

/** Resolves the token to a real HubSpot portal — doubles as validating it works at all. */
export async function fetchHubspotIdentity(token: string): Promise<{ hubDomain: string } | null> {
  const res = await fetch(`${API_URL}/account-info/v3/details`, { headers: headers(token) });
  if (!res.ok) return null;
  const data = (await res.json()) as { uiDomain?: string; portalId?: number };
  return { hubDomain: data.uiDomain ?? `portal ${data.portalId ?? ''}`.trim() };
}

export async function getRecentHubspotActivity(token: string, since: Date): Promise<HubspotActivityItem[]> {
  const res = await fetch(`${API_URL}/crm/v3/objects/deals/search`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: since.getTime() }] }],
      properties: ['dealname', 'dealstage', 'hs_lastmodifieddate'],
      sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      limit: 25,
    }),
  });
  if (!res.ok) throw new Error(`HubSpot search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { results?: any[] };
  return (data.results ?? []).map((d) => ({
    name: d.properties?.dealname ?? '(unnamed deal)',
    stage: d.properties?.dealstage ?? 'unknown',
    updatedAt: d.properties?.hs_lastmodifieddate ?? new Date().toISOString(),
  }));
}

export function formatHubspotDigest(items: HubspotActivityItem[]): string | null {
  if (items.length === 0) return null;
  return items.map((i) => `- Deal "${i.name}" moved to ${i.stage}`).join('\n');
}

export async function saveHubspotConnection(personId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchHubspotIdentity(token);
  if (!identity) return { ok: false, error: 'HubSpot rejected this access token — check it and try again' };
  await saveGenericConnection(PROVIDER, personId, token, identity.hubDomain);
  return { ok: true, label: identity.hubDomain };
}

export const getHubspotStatus = (personId: number) => getGenericConnectionStatus(PROVIDER, personId);
export const getHubspotConnection = (personId: number) => getGenericConnection(PROVIDER, personId);
export const disconnectHubspot = (personId: number) => disconnectGeneric(PROVIDER, personId);

// Personal (no-org) account variant — same validation, account-keyed storage.
export async function saveHubspotAccountConnection(accountId: number, token: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const identity = await fetchHubspotIdentity(token);
  if (!identity) return { ok: false, error: 'HubSpot rejected this access token — check it and try again' };
  await saveGenericAccountConnection(PROVIDER, accountId, token, identity.hubDomain);
  return { ok: true, label: identity.hubDomain };
}
export const getHubspotAccountStatus = (accountId: number) => getGenericAccountConnectionStatus(PROVIDER, accountId);
export const getHubspotAccountConnection = (accountId: number) => getGenericAccountConnection(PROVIDER, accountId);
export const disconnectHubspotAccount = (accountId: number) => disconnectGenericAccount(PROVIDER, accountId);
