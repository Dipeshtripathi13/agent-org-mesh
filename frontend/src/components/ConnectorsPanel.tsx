import { useEffect, useState } from 'react';
import { api, type ConnectorDef, type IngestSource, type IngestToken } from '../lib/api';
import { ingestSnippet } from '../pages/SetUpMyAgent';

const CATEGORY_LABEL: Record<string, string> = {
  code: 'Code', docs: 'Docs', 'project-mgmt': 'Project management', support: 'Support',
  crm: 'CRM', comms: 'Comms', calendar: 'Calendar', storage: 'Storage', design: 'Design',
  'data-eng': 'Data engineering',
};

/** Which owner this panel is connecting tools for — an org-chart person (the existing
 *  path, `person.surfaces`-backed) or the logged-in account itself (a personal, no-org
 *  account with no `people` row to key off of — account_oauth_tokens-backed instead, see
 *  personalConnectors.ts). Same catalog, same UI, same generic connect/disconnect/status
 *  shape either way — just a different set of three endpoints underneath. */
export type ConnectorsOwner = { kind: 'person'; personId: number } | { kind: 'account' };

/** The one "connect a tool" panel — one dropdown, one dynamic form, driven entirely by
 *  the connector catalog (`GET /api/connectors/catalog`) rather than one bespoke React
 *  block per tool: GitHub, Jira, Google Calendar, and the ingest-token sub-agents (Claude
 *  Code/Codex CLI/Gemini CLI) all live in this same dropdown now, not scattered across
 *  their own separate panels — found live, reported directly: "everything is a tool, it
 *  should be under the same dropdown." Calendar's connect UI is a "Connect Gmail" link
 *  (it rides on Gmail's own OAuth token — Gmail itself stays a genuinely separate concept,
 *  never a `ConnectorDef`, since it must never become a `claims`-row a manager could see).
 *  The three ingest-token tools open the real token-management UI (list, generate, revoke)
 *  instead of a credential form — a fundamentally different transaction, not just a
 *  different field list (multiple independently-revocable tokens, a secret shown exactly
 *  once, vs. "submit once, one Disconnect forever" for every PAT/OAuth connector here).
 *  Connecting a tool here is what makes it show up as connected — for a person, the same
 *  `person.surfaces` state MyAgent.tsx's own Connected Surfaces panel reads, so both views
 *  agree automatically, and the org's main agent picks up a newly-connected surface as a
 *  real discovery candidate (resourceProviders.ts's gatherAll) the very next ask; for a
 *  personal account, the same real discovery happens through the narrower ask-personal
 *  bridge (server.ts, personalConnectors.ts) instead. */
export function ConnectorsPanel({ owner }: { owner: ConnectorsOwner }) {
  const [catalog, setCatalog] = useState<ConnectorDef[]>([]);
  const [statuses, setStatuses] = useState<Record<string, { connected: boolean; label: string | null }>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ingest-token management state — a token isn't tied to one specific source (one token
  // authenticates a push to any of /api/ingest/claude-code|codex|gemini-cli; the "source"
  // only picks which URL/snippet gets shown when generating a new one), so this is one
  // shared list regardless of which of the three tools was clicked to open it.
  const [tokens, setTokens] = useState<IngestToken[]>([]);
  const [newTokenLabel, setNewTokenLabel] = useState('');
  const [justCreated, setJustCreated] = useState<{ id: string; token: string; source: IngestSource } | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);

  // GitHub/Jira/Calendar used to have their own dedicated sections elsewhere on the page;
  // now only Calendar stays excluded, and only for a personal (no-org) account, since it
  // rides on Gmail's own OAuth token and Gmail was never extended there.
  const handledElsewhere = owner.kind === 'account' ? new Set(['calendar']) : new Set<string>();

  const statusReq = () => (owner.kind === 'person' ? api.personConnectors(owner.personId) : api.accountConnectors());
  const connectReq = (key: string, fields: Record<string, string>) =>
    owner.kind === 'person' ? api.connectConnector(owner.personId, key, fields) : api.connectAccountConnector(key, fields);
  const disconnectReq = (key: string) =>
    owner.kind === 'person' ? api.disconnectConnector(owner.personId, key) : api.disconnectAccountConnector(key);
  const tokensReq = () => (owner.kind === 'person' ? api.ingestTokens(owner.personId) : api.accountIngestTokens());
  const createTokenReq = (label: string) =>
    owner.kind === 'person' ? api.createIngestToken(owner.personId, label) : api.createAccountIngestToken(label);
  const revokeTokenReq = (tokenId: string) =>
    owner.kind === 'person' ? api.revokeIngestToken(owner.personId, tokenId) : api.revokeAccountIngestToken(tokenId);

  const load = () =>
    Promise.all([api.connectorsCatalog(), statusReq(), tokensReq()]).then(([catRes, statusRes, tokensRes]) => {
      setCatalog(catRes.catalog.filter((c) => !handledElsewhere.has(c.key)));
      setStatuses(statusRes.statuses);
      setTokens(tokensRes.tokens);
    });

  const ownerKey = owner.kind === 'person' ? `person:${owner.personId}` : 'account';
  useEffect(() => {
    void load();
    setOpenKey(null);
    setFormValues({});
    setJustCreated(null);
    setNewTokenLabel('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey]);

  const hasActiveToken = tokens.some((t) => !t.revoked);
  const connected = catalog.filter((c) => (c.authType === 'ingest-token' ? hasActiveToken : statuses[c.key]?.connected));
  const notConnected = catalog.filter((c) => !(c.authType === 'ingest-token' ? hasActiveToken : statuses[c.key]?.connected));
  const byCategory = new Map<string, ConnectorDef[]>();
  for (const c of notConnected) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }

  const openConnect = (key: string) => {
    setOpenKey(key);
    setFormValues({});
    setJustCreated(null);
    setNewTokenLabel('');
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

  const createToken = async (source: IngestSource) => {
    if (!newTokenLabel.trim()) return;
    setTokenBusy(true);
    try {
      const created = await createTokenReq(newTokenLabel.trim());
      setJustCreated({ ...created, source });
      setNewTokenLabel('');
      await load();
    } finally {
      setTokenBusy(false);
    }
  };

  const revokeTok = async (tokenId: string) => {
    setTokenBusy(true);
    try {
      await revokeTokenReq(tokenId);
      await load();
    } finally {
      setTokenBusy(false);
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
                {c.authType === 'ingest-token' ? (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
                    {tokens.filter((t) => !t.revoked).length} active token(s)
                  </span>
                ) : (
                  statuses[c.key]?.label && (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>{statuses[c.key]?.label}</span>
                  )
                )}
                <span style={{ fontSize: 11, color: 'var(--ink3)' }}>
                  {c.status === 'live' ? 'reads at ask-time' : 'connected — not yet queried at ask-time'}
                </span>
                <span className="spacer" />
                {c.authType === 'ingest-token' ? (
                  <button className="chip" disabled={busy} onClick={() => openConnect(c.key)}>Manage</button>
                ) : (
                  <button className="chip" disabled={busy} onClick={() => disconnect(c.key)}>Disconnect</button>
                )}
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

          {openDef && openDef.authType === 'oauth-google' && owner.kind === 'person' && (
            <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--rule2)', borderRadius: 2 }}>
              <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 0 }}>{openDef.helpText}</p>
              <div style={{ display: 'flex', gap: 7 }}>
                <a
                  className="chip"
                  href={api.gmailConnectUrl(owner.personId)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ height: 32, display: 'inline-flex', alignItems: 'center', padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2, textDecoration: 'none' }}
                >
                  Connect Gmail
                </a>
                <button className="chip" disabled={busy} onClick={() => setOpenKey(null)}>Cancel</button>
              </div>
            </div>
          )}

          {openDef && openDef.authType === 'ingest-token' && (
            <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--rule2)', borderRadius: 2 }}>
              <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 0 }}>{openDef.helpText}</p>

              {tokens.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {tokens.map((t) => (
                    <div key={t.id} className="runtime-card" style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</span>
                        {t.revoked ? (
                          <span className="pill pill-blocked"><i />Revoked</span>
                        ) : (
                          <span className="pill pill-full"><i />Active</span>
                        )}
                        <span className="spacer" />
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>
                          created {t.createdAt.slice(0, 10)}{t.lastUsedAt ? ` · last used ${t.lastUsedAt.slice(0, 10)}` : ' · never used'}
                        </span>
                      </div>
                      {!t.revoked && (
                        <div style={{ marginTop: 9 }}>
                          <button className="chip" disabled={tokenBusy} onClick={() => revokeTok(t.id)}>Revoke</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)' }}>
                  Label
                  <input
                    aria-label="Token label"
                    placeholder="e.g. laptop — payments-core"
                    value={newTokenLabel}
                    onChange={(e) => setNewTokenLabel(e.target.value)}
                    style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 12, minWidth: 220 }}
                  />
                </label>
                <button
                  disabled={tokenBusy || !newTokenLabel.trim()}
                  onClick={() => createToken(openDef.key as IngestSource)}
                  style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2, whiteSpace: 'nowrap' }}
                >
                  {tokenBusy ? 'Generating…' : 'Generate token'}
                </button>
                <button className="chip" disabled={tokenBusy} onClick={() => setOpenKey(null)}>Close</button>
              </div>

              {justCreated && (() => {
                const url = `${window.location.protocol}//${window.location.hostname}:3001/api/ingest/${justCreated.source}`;
                const { file, snippet } = ingestSnippet(justCreated.source, url, justCreated.token);
                return (
                  <div className="coverage-note" style={{ marginTop: 14 }}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--hold)' }}>
                      Shown once — copy it now, it isn't stored anywhere you can retrieve again
                    </span>
                    <p style={{ fontFamily: 'var(--mono)', fontSize: 12, margin: '8px 0', wordBreak: 'break-all', background: 'var(--panel-bg, #f4f4f2)', padding: '7px 9px', borderRadius: 2 }}>
                      {justCreated.token}
                    </p>
                    <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '10px 0 4px' }}>
                      Paste into <strong>{file}</strong>:
                    </p>
                    <pre style={{ fontFamily: 'var(--mono)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--panel-bg, #f4f4f2)', padding: '9px', borderRadius: 2, margin: 0 }}>
                      {snippet}
                    </pre>
                    <p className="glossary" style={{ marginTop: 8 }}>
                      Every command/file-editing tool call will push a real observation. Only
                      Bash/Edit/Write/NotebookEdit calls are kept; everything else is received
                      and silently dropped. One token works for any of these three tools —
                      whichever endpoint your hook config actually posts to.
                    </p>
                  </div>
                );
              })()}
            </div>
          )}

          {openDef && openDef.authType !== 'oauth-google' && openDef.authType !== 'ingest-token' && (
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
