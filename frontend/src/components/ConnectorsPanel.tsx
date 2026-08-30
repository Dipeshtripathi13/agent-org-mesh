import { useEffect, useState } from 'react';
import { api, type ConnectorDef } from '../lib/api';

const CATEGORY_LABEL: Record<string, string> = {
  code: 'Code', docs: 'Docs', 'project-mgmt': 'Project management', support: 'Support',
  crm: 'CRM', comms: 'Comms', calendar: 'Calendar', storage: 'Storage', design: 'Design',
  'data-eng': 'Data engineering',
};

// GitHub, Jira, and Calendar already have their own dedicated sections elsewhere on this
// page (Calendar has no connect form of its own at all — it rides on Gmail's connection,
// see googleCalendar.ts) — showing them here too would just be a second, confusing way to
// do the same thing. For a personal (no-org) account, Calendar is excluded for a second
// reason too: it rides on Gmail's own OAuth token, which personal accounts don't have.
const HANDLED_ELSEWHERE = new Set(['github', 'jira', 'calendar']);

/** Which owner this panel is connecting tools for — an org-chart person (the existing
 *  path, `person.surfaces`-backed) or the logged-in account itself (a personal, no-org
 *  account with no `people` row to key off of — account_oauth_tokens-backed instead, see
 *  personalConnectors.ts). Same catalog, same UI, same generic connect/disconnect/status
 *  shape either way — just a different set of three endpoints underneath. */
export type ConnectorsOwner = { kind: 'person'; personId: number } | { kind: 'account' };

/** The generic "connect a tool" panel — one dropdown, one dynamic form, driven entirely
 *  by the connector catalog (`GET /api/connectors/catalog`) rather than one bespoke React
 *  block per tool. Connecting a tool here is what makes it show up as connected — for a
 *  person, the same `person.surfaces` state MyAgent.tsx's own Connected Surfaces panel
 *  reads, so both views agree automatically, and the org's main agent picks up a newly-
 *  connected surface as a real discovery candidate (resourceProviders.ts's gatherAll) the
 *  very next ask; for a personal account, the same real discovery happens through the
 *  narrower ask-personal bridge (server.ts, personalConnectors.ts) instead. */
export function ConnectorsPanel({ owner }: { owner: ConnectorsOwner }) {
  const [catalog, setCatalog] = useState<ConnectorDef[]>([]);
  const [statuses, setStatuses] = useState<Record<string, { connected: boolean; label: string | null }>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const statusReq = () => (owner.kind === 'person' ? api.personConnectors(owner.personId) : api.accountConnectors());
  const connectReq = (key: string, fields: Record<string, string>) =>
    owner.kind === 'person' ? api.connectConnector(owner.personId, key, fields) : api.connectAccountConnector(key, fields);
  const disconnectReq = (key: string) =>
    owner.kind === 'person' ? api.disconnectConnector(owner.personId, key) : api.disconnectAccountConnector(key);

  const load = () =>
    Promise.all([api.connectorsCatalog(), statusReq()]).then(([catRes, statusRes]) => {
      setCatalog(catRes.catalog.filter((c) => !HANDLED_ELSEWHERE.has(c.key)));
      setStatuses(statusRes.statuses);
    });

  const ownerKey = owner.kind === 'person' ? `person:${owner.personId}` : 'account';
  useEffect(() => {
    void load();
    setOpenKey(null);
    setFormValues({});
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey]);

  const connected = catalog.filter((c) => statuses[c.key]?.connected);
  const notConnected = catalog.filter((c) => !statuses[c.key]?.connected);
  const byCategory = new Map<string, ConnectorDef[]>();
  for (const c of notConnected) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }

  const openConnect = (key: string) => {
    setOpenKey(key);
    setFormValues({});
    setError(null);
  };

  const submitConnect = async (def: ConnectorDef) => {
    setBusy(true);
    setError(null);
    try {
      await connectReq(def.key, formValues);
      setOpenKey(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `could not connect ${def.name}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (key: string) => {
    setBusy(true);
    try {
      await disconnectReq(key);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const openDef = catalog.find((c) => c.key === openKey);

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <header>
        <span className="label">Connected tools</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
          {connected.length} connected
        </span>
      </header>
      <div className="inner">
        {connected.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--ink3)', margin: 0 }}>Nothing connected yet.</p>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {connected.map((c) => (
              <div key={c.key} className="runtime-card" style={{ marginBottom: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</span>
                {statuses[c.key]?.label && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>{statuses[c.key]?.label}</span>
                )}
                <span style={{ fontSize: 11, color: 'var(--ink3)' }}>
                  {c.status === 'live' ? 'reads at ask-time' : 'connected — not yet queried at ask-time'}
                </span>
                <span className="spacer" />
                <button className="chip" disabled={busy} onClick={() => disconnect(c.key)}>Disconnect</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--rule2)' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)', maxWidth: 280 }}>
            Connect a tool
            <select
              aria-label="Connect a tool"
              value=""
              onChange={(e) => { if (e.target.value) openConnect(e.target.value); }}
              style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 8px', fontSize: 12 }}
            >
              <option value="">Choose a tool…</option>
              {[...byCategory.entries()].map(([cat, tools]) => (
                <optgroup key={cat} label={CATEGORY_LABEL[cat] ?? cat}>
                  {tools.map((t) => (
                    <option key={t.key} value={t.key} disabled={t.status === 'coming-soon'}>
                      {t.name}{t.status === 'coming-soon' ? ' — coming soon' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          {openDef && (
            <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--rule2)', borderRadius: 2 }}>
              <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 0 }}>{openDef.helpText}</p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {openDef.fields.map((f) => (
                  <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)' }}>
                    {f.label}{f.optional ? ' (optional)' : ''}
                    {f.multiline ? (
                      <textarea
                        autoComplete="off"
                        placeholder={f.placeholder}
                        value={formValues[f.key] ?? ''}
                        onChange={(e) => setFormValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        rows={6}
                        style={{ border: '1px solid var(--rule2)', borderRadius: 2, padding: '6px 8px', fontSize: 12, minWidth: 260, fontFamily: 'var(--mono)', resize: 'vertical' }}
                      />
                    ) : (
                      <input
                        type={f.secret ? 'password' : 'text'}
                        autoComplete="off"
                        placeholder={f.placeholder}
                        value={formValues[f.key] ?? ''}
                        onChange={(e) => setFormValues((v) => ({ ...v, [f.key]: e.target.value }))}
                        style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 8px', fontSize: 12, minWidth: 200 }}
                      />
                    )}
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                <button
                  disabled={busy}
                  onClick={() => submitConnect(openDef)}
                  style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2 }}
                >
                  {busy ? 'Connecting…' : `Connect ${openDef.name}`}
                </button>
                <button className="chip" disabled={busy} onClick={() => setOpenKey(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        {error && <p style={{ fontSize: 11, color: 'var(--hold)', marginTop: 8 }}>{error}</p>}
      </div>
    </div>
  );
}
