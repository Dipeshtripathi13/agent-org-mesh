import { useEffect, useState } from 'react';
import { api, type AgentRuntime, type ConnectorDef, type IngestSource, type IngestToken, type PersonRuntime } from '../lib/api';
import { ingestSnippet, ScopePill } from '../pages/SetUpMyAgent';

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

/** The one "connect a tool" panel — one dropdown covering data connectors, sub-agent LLM
 *  runtimes, and (person/org mode only) Gmail, rather than three separate pickers —
 *  found live, reported directly: "the subagent and tools [should be] in [the] same
 *  drop down... put Gmail also under the drop down, it's just a tool." Sub-agents and
 *  Gmail are structurally *not* `ConnectorDef` catalog entries — a runtime registration
 *  (`person_runtimes`/`account_runtimes`) is a different backend table from
 *  `person_oauth_tokens`, and Gmail can never become one at all (it isn't a `SurfaceKey`;
 *  it must never become a `claims`-row a manager could see via cross-person Ask). Rather
 *  than forcing either into the catalog's `SurfaceKey`-typed shape, this component fetches
 *  the runtime catalog/registration state (and, for a person owner, Gmail's own status)
 *  alongside the connector catalog and merges all three into one dropdown and one
 *  "Connected" list purely on the frontend — the backend architecture, and the hard rule
 *  above, are both untouched.
 *  GitHub, Jira, Google Calendar, and the three ingest-token sub-agents (Claude Code/Codex
 *  CLI/Gemini CLI) are real `ConnectorDef` entries and live in this dropdown too. Calendar's
 *  connect UI is a "Connect Gmail" link (it rides on Gmail's own OAuth token) — kept
 *  alongside the separate, first-class Gmail entry below because the two represent
 *  genuinely different state: Calendar is a real org-visible surface with real claims;
 *  Gmail is a self-ask-only digest source that is never one. The three ingest-token tools
 *  open the real token-management UI (list, generate, revoke) instead of a credential form.
 *  A sub-agent's own detail card (vendor/context/host/note, blocked/unapproved state) and
 *  the query/"ask it live" affordances are exactly what the old "Register another agent"
 *  grid had — relocated here, not rebuilt. Connecting a data connector here is what makes
 *  it show up as connected — for a person, the same `person.surfaces` state MyAgent.tsx's
 *  own Connected Surfaces panel reads, so both views agree automatically, and the org's
 *  main agent picks up a newly-connected surface as a real discovery candidate
 *  (resourceProviders.ts's gatherAll) the very next ask; for a personal account, the same
 *  real discovery happens through the narrower ask-personal bridge instead. */
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

  // Sub-agent (LLM runtime) registration state — a wholly different backend concept and
  // table from every ConnectorDef above (person_runtimes/account_runtimes, not
  // person_oauth_tokens), merged into this one dropdown/list on the frontend only.
  const [runtimeCatalog, setRuntimeCatalog] = useState<AgentRuntime[]>([]);
  const [registeredRuntimes, setRegisteredRuntimes] = useState<PersonRuntime[]>([]);
  const [queryOpen, setQueryOpen] = useState<Record<string, { text: string; real: boolean }>>({});
  const [queryBusy, setQueryBusy] = useState<string | null>(null);
  const [liveQuestion, setLiveQuestion] = useState('');
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveResult, setLiveResult] = useState<{ text: string } | { error: string } | null>(null);

  // Gmail — person/org mode only (it was never extended to personal accounts, and it can
  // never become a real ConnectorDef; see the module comment above). `openKey === 'gmail'`
  // is a reserved sentinel that can never collide with a real SurfaceKey or runtime key.
  const [gmail, setGmail] = useState<{ connected: boolean; email: string | null } | null>(null);
  const gmailAvailable = owner.kind === 'person';

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
  const runtimesReq = () => (owner.kind === 'person' ? api.personRuntimes(owner.personId) : api.accountRuntimes());
  const registerRuntimeReq = (key: string) =>
    owner.kind === 'person' ? api.registerRuntime(owner.personId, key) : api.registerAccountRuntime(key);
  const disconnectRuntimeReq = (key: string) =>
    owner.kind === 'person' ? api.disconnectRuntime(owner.personId, key) : api.disconnectAccountRuntime(key);
  const gmailReq = () => (owner.kind === 'person' ? api.gmailStatus(owner.personId) : Promise.resolve(null));

  const load = () =>
    Promise.all([api.connectorsCatalog(), statusReq(), tokensReq(), runtimesReq(), gmailReq()]).then(
      ([catRes, statusRes, tokensRes, runtimeRes, gmailRes]) => {
        setCatalog(catRes.catalog.filter((c) => !handledElsewhere.has(c.key)));
        setStatuses(statusRes.statuses);
        setTokens(tokensRes.tokens);
        setRuntimeCatalog(runtimeRes.catalog);
        setRegisteredRuntimes(runtimeRes.registered);
        setGmail(gmailRes);
      },
    );

  const ownerKey = owner.kind === 'person' ? `person:${owner.personId}` : 'account';
  useEffect(() => {
    void load();
    setOpenKey(null);
    setFormValues({});
    setJustCreated(null);
    setNewTokenLabel('');
    setError(null);
    setQueryOpen({});
    setLiveQuestion('');
    setLiveResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey]);
  // Returning from the Google consent tab refocuses this one — pick up the new Gmail status.
  useEffect(() => {
    if (!gmailAvailable) return;
    const onFocus = () => void gmailReq().then(setGmail);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
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

  const runtimeByKey = new Map(runtimeCatalog.map((r) => [r.key, r]));
  const registeredRuntimeKeys = new Set(registeredRuntimes.map((r) => r.runtimeKey));
  const availableRuntimes = runtimeCatalog.filter((r) => !registeredRuntimeKeys.has(r.key));

  const gmailConnected = gmailAvailable && !!gmail?.connected;
  const totalConnectedCount = connected.length + registeredRuntimes.length + (gmailConnected ? 1 : 0);

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

  const registerRuntime = async (entry: AgentRuntime) => {
    setBusy(true);
    setError(null);
    try {
      await registerRuntimeReq(entry.key);
      setOpenKey(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `could not register ${entry.name}`);
    } finally {
      setBusy(false);
    }
  };

  const disconnectRuntime = async (key: string) => {
    setBusy(true);
    try {
      await disconnectRuntimeReq(key);
      setQueryOpen((q) => { const { [key]: _drop, ...rest } = q; return rest; });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const queryRuntime = async (key: string) => {
    if (owner.kind !== 'person') return;
    setQueryBusy(key);
    setError(null);
    try {
      const { text, real } = await api.queryRuntime(owner.personId, key);
      setQueryOpen((q) => ({ ...q, [key]: { text, real } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not query this agent');
    } finally {
      setQueryBusy(null);
    }
  };

  const askLive = async () => {
    if (owner.kind !== 'person' || !liveQuestion.trim()) return;
    setLiveBusy(true);
    setLiveResult(null);
    try {
      const { text } = await api.askClaudeCliLive(owner.personId, liveQuestion.trim());
      setLiveResult({ text });
    } catch (e) {
      setLiveResult({ error: e instanceof Error ? e.message : 'the claude CLI failed' });
    } finally {
      setLiveBusy(false);
    }
  };

  const disconnectGmailAction = async () => {
    if (owner.kind !== 'person') return;
    setBusy(true);
    try {
      await api.disconnectGmail(owner.personId);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const openDef = catalog.find((c) => c.key === openKey);
  const openRuntime = runtimeCatalog.find((r) => r.key === openKey);
  const openIsGmail = openKey === 'gmail';

  return (
    <div className="panel" style={{ marginTop: 18 }}>
      <header>
        <span className="label">Connected tools</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
          {totalConnectedCount} connected
        </span>
      </header>
      <div className="inner">
        {totalConnectedCount === 0 ? (
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

            {gmailConnected && owner.kind === 'person' && (
              <div className="runtime-card" style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Gmail</span>
                  {gmail?.email && (
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>{gmail.email}</span>
                  )}
                  <span style={{ fontSize: 11, color: 'var(--ink3)' }}>feeds your own daily summary only, never the org</span>
                  <span className="spacer" />
                  <button className="chip" disabled={busy} onClick={disconnectGmailAction}>Disconnect</button>
                </div>
              </div>
            )}

            {registeredRuntimes.map((r) => {
              const entry = runtimeByKey.get(r.runtimeKey);
              if (!entry) return null;
              return (
                <div key={`runtime:${r.runtimeKey}`} className="runtime-card" style={{ marginBottom: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{entry.name}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>{entry.vendor}</span>
                    {r.scope === 'pending' && <ScopePill scope={r.scope} />}
                    <span className="spacer" />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>added {r.addedAt}</span>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '6px 0 0' }}>
                    <strong>Hosted:</strong> {entry.host}.
                  </p>
                  {r.scope === 'pending' ? (
                    <div style={{ marginTop: 9 }}>
                      <p style={{ fontSize: 11, color: 'var(--ink3)', margin: '0 0 8px' }}>
                        Registration filed. Awaiting IT &amp; Security approval.
                      </p>
                      <button className="chip" disabled={busy} onClick={() => disconnectRuntime(r.runtimeKey)}>Withdraw request</button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
                      {owner.kind === 'person' && (
                        <button className="chip" disabled={queryBusy === r.runtimeKey} onClick={() => queryRuntime(r.runtimeKey)}>
                          {queryBusy === r.runtimeKey ? 'Asking…' : 'What did it complete today?'}
                        </button>
                      )}
                      <button className="chip" disabled={busy} onClick={() => disconnectRuntime(r.runtimeKey)}>Disconnect</button>
                    </div>
                  )}
                  {queryOpen[r.runtimeKey] && (
                    <p className="coverage-note" style={{ marginTop: 9 }}>
                      {queryOpen[r.runtimeKey].real && (
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ok)', marginRight: 6 }}>REAL</span>
                      )}
                      {queryOpen[r.runtimeKey].text}
                    </p>
                  )}
                  {owner.kind === 'person' && r.runtimeKey === 'claude-code' && r.scope !== 'pending' && (
                    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--rule)' }}>
                      <span className="label" style={{ display: 'block', marginBottom: 6 }}>
                        Ask it live &mdash; a fresh, read-only investigation right now
                      </span>
                      <div style={{ display: 'flex', gap: 7 }}>
                        <input
                          aria-label="Ask Claude Code live"
                          placeholder="e.g. What changed in this repo recently?"
                          value={liveQuestion}
                          onChange={(e) => setLiveQuestion(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && askLive()}
                          style={{ flex: 1, height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 12 }}
                        />
                        <button
                          disabled={liveBusy || !liveQuestion.trim()}
                          onClick={askLive}
                          style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2, whiteSpace: 'nowrap' }}
                        >
                          {liveBusy ? 'Investigating…' : 'Ask live'}
                        </button>
                      </div>
                      <p className="glossary" style={{ marginTop: 6 }}>
                        Shells out to your own logged-in <code>claude</code> CLI, read-only
                        tools only, scoped to this project directory. This is a live look
                        right now, not a summary of what already happened &mdash; and it
                        spends real usage against your subscription each time you ask.
                      </p>
                      {liveResult && 'text' in liveResult && (
                        <p className="coverage-note" style={{ marginTop: 9 }}>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ok)', marginRight: 6 }}>LIVE</span>
                          {liveResult.text}
                        </p>
                      )}
                      {liveResult && 'error' in liveResult && (
                        <p style={{ fontSize: 12, color: 'var(--hold)', marginTop: 9 }}>{liveResult.error}</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
              {gmailAvailable && !gmailConnected && (
                <optgroup label="Gmail">
                  <option value="gmail">Gmail</option>
                </optgroup>
              )}
              {availableRuntimes.length > 0 && (
                <optgroup label="Sub-agents">
                  {availableRuntimes.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}{r.blocked ? ' — blocked' : !r.approved ? ' — unapproved' : ''}
                    </option>
                  ))}
                </optgroup>
              )}
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

          {openIsGmail && owner.kind === 'person' && (
            <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--rule2)', borderRadius: 2 }}>
              <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 0 }}>
                Read-only, today's messages only (subject and snippet, never full bodies).
                Feeds your own daily summary and self-ask only — never the org. Connecting
                also enables Calendar automatically, via the same one-time Google consent.
              </p>
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

          {openRuntime && (
            <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--rule2)', borderRadius: 2 }}>
              <div className={`runtime-card${openRuntime.blocked ? ' is-blocked' : ''}`} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{openRuntime.name}</span>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>{openRuntime.vendor} &middot; {openRuntime.contextWindow} context</span>
                </div>
                <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '6px 0 0' }}>
                  <strong>Hosted:</strong> {openRuntime.host}.
                </p>
                <p style={{ fontSize: 12, color: 'var(--ink3)', margin: '6px 0 0' }}>{openRuntime.note}</p>
                {openRuntime.blocked && (
                  <p className="locked" style={{ marginTop: 10 }}>&#8856; cannot be registered &mdash; no data-processing agreement</p>
                )}
              </div>
              <div style={{ display: 'flex', gap: 7 }}>
                <button
                  disabled={busy || openRuntime.blocked}
                  onClick={() => registerRuntime(openRuntime)}
                  style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2 }}
                >
                  {busy ? 'Connecting…' : !openRuntime.approved ? 'Request approval' : 'Connect'}
                </button>
                <button className="chip" disabled={busy} onClick={() => setOpenKey(null)}>Cancel</button>
              </div>
              <p className="glossary" style={{ marginTop: 10 }}>
                A sub-agent never reads your org surfaces and nobody outside you can query it
                directly{owner.kind === 'person' ? ' — only your organization\'s main agent can ask it what it\'s been up to, and that\'s a personal status check, not an org read.' : '.'}
              </p>
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
