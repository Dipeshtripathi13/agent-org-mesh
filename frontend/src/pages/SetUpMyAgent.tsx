import { useEffect, useState } from 'react';
import {
  api,
  type AccountMainAgent, type AgentRuntime, type IngestSource, type OrgMainAgent, type PersonRuntime, type RuntimeScope,
} from '../lib/api';
import { ConnectorsPanel } from '../components/ConnectorsPanel';
import { PersonalToolsPanel } from '../components/PersonalToolsPanel';
import { CredentialsFields } from '../components/primitives';
import { useAuth } from '../lib/AuthContext';
import { useMe } from '../lib/MeContext';

const SCOPE_LABEL: Record<RuntimeScope, string> = {
  full: 'Full scope', narrow: 'Narrowed scope', pending: 'Awaiting approval',
};

export const SOURCE_LABEL: Record<IngestSource, string> = {
  'claude-code': 'Claude Code', codex: 'Codex CLI', 'gemini-cli': 'Gemini CLI',
};

export function ingestSnippet(source: IngestSource, url: string, token: string): { file: string; snippet: string } {
  const curl = `curl -s -X POST ${url} -H 'Authorization: Bearer ${token}' -H 'Content-Type: application/json' -d @-`;
  if (source === 'claude-code') {
    return {
      file: '.claude/settings.local.json (in the project you want to report on)',
      snippet: JSON.stringify({
        hooks: {
          PostToolUse: [{
            matcher: 'Bash|Edit|Write|NotebookEdit',
            hooks: [{ type: 'command', command: curl }],
          }],
        },
      }, null, 2),
    };
  }
  return {
    file: `your ${SOURCE_LABEL[source]} hook config — the exact key varies by version, but any hook/telemetry mechanism that can run a shell command works`,
    snippet: curl,
  };
}

export function ScopePill({ scope }: { scope: RuntimeScope }) {
  return (
    <span className={`pill pill-${scope}`}>
      <i />{SCOPE_LABEL[scope]}
    </span>
  );
}

/** The personal counterpart to OrgSetup.tsx's OrgMainAgentPanel — always editable (it's
 *  your own credential, no admin/owner gate to check), no scope/pending-approval workflow
 *  (no IT/Security gate makes sense for an individual's own key). Mirrors that component's
 *  shape closely enough to share CredentialsFields; the runtime picker and submit button
 *  stay separately written since the two forms diverge on the scope UI. */
function PersonalMainAgentPanel() {
  const [catalog, setCatalog] = useState<AgentRuntime[]>([]);
  const [main, setMain] = useState<AccountMainAgent | null>(null);
  const [editing, setEditing] = useState(false);
  const [formRuntime, setFormRuntime] = useState('');
  const [useOwnCredentials, setUseOwnCredentials] = useState(false);
  const [formApiKey, setFormApiKey] = useState('');
  const [formBaseUrl, setFormBaseUrl] = useState('');
  const [formModel, setFormModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.accountMainAgent().then((d) => { setCatalog(d.catalog); setMain(d.registered); });
  useEffect(() => { void load(); }, []);

  const byKey = new Map(catalog.map((r) => [r.key, r]));
  const mainOptions = catalog.filter((r) => r.mainEligible && r.apiFamily !== 'unsupported' && !r.blocked);
  const showForm = !main || editing;
  const effectiveRuntime = formRuntime || main?.runtimeKey || mainOptions[0]?.key || '';
  const formEntry = byKey.get(effectiveRuntime) ?? null;
  const supportsBaseUrl = formEntry?.apiFamily === 'openai-compatible';

  const openEdit = () => {
    setFormRuntime(main?.runtimeKey ?? mainOptions[0]?.key ?? '');
    setUseOwnCredentials(!!(main?.hasCustomApiKey || main?.baseUrl || main?.model));
    setFormApiKey('');
    setFormBaseUrl(main?.baseUrl ?? '');
    setFormModel(main?.model ?? '');
    setEditing(true);
  };
  const submit = async () => {
    if (!effectiveRuntime) return;
    setBusy(true);
    setError(null);
    try {
      const credentials = useOwnCredentials
        ? {
            apiKey: formApiKey.trim() === '' ? undefined : formApiKey.trim(),
            baseUrl: supportsBaseUrl ? (formBaseUrl.trim() || null) : null,
            model: formModel.trim() || null,
          }
        : { apiKey: null, baseUrl: null, model: null };
      await api.setAccountMainAgent(effectiveRuntime, credentials);
      setEditing(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not set your main agent');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2 className="label" style={{ marginTop: 0 }}>Your personal agent</h2>
      <p className="sub">
        Separate from any organization's agent — the one that answers in <strong>My
        agent</strong>'s personal mode. Nobody else can ever see or use this, whether or
        not you're also part of an organization.
      </p>
      <div className="panel" style={{ marginTop: 18 }}>
        <header>
          <span className="label">Your main agent</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>just for you</span>
        </header>
        <div className="inner">
          {showForm ? (
            <>
              <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 0 }}>
                {main
                  ? 'Editing your main agent. New questions will read through it immediately.'
                  : 'No main agent set yet — nothing will answer in "Ask yourself" until you set one.'}
              </p>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)', maxWidth: 260 }}>
                Agent
                <select
                  aria-label="Main agent runtime"
                  value={effectiveRuntime}
                  onChange={(e) => setFormRuntime(e.target.value)}
                  style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 8px', fontSize: 12, minWidth: 200 }}
                >
                  {mainOptions.map((o) => (
                    <option key={o.key} value={o.key}>{o.name} — {o.vendor}</option>
                  ))}
                </select>
              </label>
              {formEntry && (
                <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '10px 0 0' }}>
                  <strong>Reads:</strong> {formEntry.reads}. <strong>Hosted:</strong> {formEntry.host}.
                </p>
              )}
              <CredentialsFields
                useOwnCredentials={useOwnCredentials}
                setUseOwnCredentials={setUseOwnCredentials}
                hasCustomApiKey={!!main?.hasCustomApiKey}
                hasBaseUrlOrModel={!!(main?.baseUrl || main?.model)}
                supportsBaseUrl={supportsBaseUrl}
                formApiKey={formApiKey}
                setFormApiKey={setFormApiKey}
                formBaseUrl={formBaseUrl}
                setFormBaseUrl={setFormBaseUrl}
                formModel={formModel}
                setFormModel={setFormModel}
                ownerLabel="you"
              />
              <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
                <button
                  disabled={busy || !effectiveRuntime}
                  onClick={submit}
                  style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2 }}
                >
                  {main ? 'Save changes' : 'Set main agent'}
                </button>
                {main && (
                  <button className="chip" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
                )}
              </div>
            </>
          ) : (
            <div className="runtime-card" style={{ marginBottom: 0 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{byKey.get(main.runtimeKey)?.name ?? main.runtimeKey}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>{byKey.get(main.runtimeKey)?.vendor}</span>
                <span className="spacer" />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>added {main.addedAt}</span>
              </div>
              <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '6px 0 0' }}>
                <strong>Reads:</strong> {byKey.get(main.runtimeKey)?.reads}. <strong>Hosted:</strong> {byKey.get(main.runtimeKey)?.host}.
              </p>
              <p style={{ fontSize: 11, color: 'var(--ink3)', margin: '8px 0 0' }}>
                {main.hasCustomApiKey || main.baseUrl || main.model
                  ? <>Using your own credentials{main.baseUrl ? <> — <strong>{main.baseUrl}</strong></> : ''}{main.model ? <> (model: <strong>{main.model}</strong>)</> : ''}.</>
                  : "Using the platform's shared key."}
              </p>
              <div style={{ marginTop: 9 }}>
                <button className="chip" disabled={busy} onClick={openEdit}>Edit</button>
              </div>
            </div>
          )}
          {error && <p style={{ fontSize: 11, color: 'var(--hold)', marginTop: 8 }}>{error}</p>}
        </div>
      </div>
      <PersonalToolsPanel />
      <ConnectorsPanel owner={{ kind: 'account' }} />
    </>
  );
}

/** Every logged-in account gets its own personal agent section — found live, reported
 *  directly: "I may be part of an organization, but I should ALSO be able to set up my
 *  own personal main agent and connect my own tools to it... separate from the
 *  organizational main agent." The backend for this already worked regardless of org
 *  membership (account_main_agent/account_oauth_tokens/ask-personal are all keyed purely
 *  on the logged-in account, never on `people` rows) — this was previously a strict
 *  either/or purely in this component. Now both render: the personal section always,
 *  Northbeam's (or whichever org's) section additionally, only when this account actually
 *  has a real org-chart identity. See MyAgent.tsx's own comment for the matching change
 *  on the "Ask yourself" side. */
export function SetUpMyAgent() {
  const { people: identities } = useAuth();
  return (
    <>
      <div className="crumb">My agent &middot; set up</div>
      <h1>Set up my agent</h1>
      <PersonalMainAgentPanel />
      {identities.length > 0 && <OrgSetUpMyAgent />}
    </>
  );
}

function OrgSetUpMyAgent() {
  const { meId, meOrgId } = useMe();
  const [catalog, setCatalog] = useState<AgentRuntime[]>([]);
  const [registered, setRegistered] = useState<PersonRuntime[]>([]);
  const [orgMain, setOrgMain] = useState<OrgMainAgent | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queryOpen, setQueryOpen] = useState<Record<string, { text: string; real: boolean }>>({});
  const [queryBusy, setQueryBusy] = useState<string | null>(null);
  const [gmail, setGmail] = useState<{ connected: boolean; email: string | null } | null>(null);
  const [liveQuestion, setLiveQuestion] = useState('');
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveResult, setLiveResult] = useState<{ text: string } | { error: string } | null>(null);

  const load = () => api.personRuntimes(meId).then((d) => {
    setCatalog(d.catalog);
    setRegistered(d.registered);
  });
  const loadOrgMain = () => api.orgMainAgent(meOrgId).then((d) => setOrgMain(d.registered));
  const loadGmail = () => api.gmailStatus(meId).then(setGmail);

  useEffect(() => {
    void load();
    void loadGmail();
    // Switching who "My agent" acts as — clear anything cached for the previous person.
    setQueryOpen({});
    setLiveQuestion('');
    setLiveResult(null);
  }, [meId]);
  // The main agent is org-level, not person-level — reload it independently whenever
  // switching to an identity in a different org (a person switch that stays in the same
  // org doesn't need a fresh fetch, but this is cheap enough not to bother distinguishing).
  useEffect(() => {
    void loadOrgMain();
  }, [meOrgId]);
  // Returning from the Google consent tab refocuses this one — pick up the new status.
  useEffect(() => {
    const onFocus = () => void loadGmail();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const byKey = new Map(catalog.map((r) => [r.key, r]));
  const registeredKeys = new Set(registered.map((r) => r.runtimeKey));
  const main = orgMain;
  const subs = registered;
  const subAvailable = catalog.filter((r) => !registeredKeys.has(r.key));
  const effectivePicked = picked ?? subAvailable[0]?.key ?? '';
  const pickedEntry = effectivePicked ? byKey.get(effectivePicked) ?? null : null;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const register = (key: string) => run(async () => {
    await api.registerRuntime(meId, key);
    setPicked(null);
  });
  const disconnect = (key: string) => run(async () => {
    await api.disconnectRuntime(meId, key);
    setQueryOpen((q) => { const { [key]: _drop, ...rest } = q; return rest; });
  });

  const query = async (key: string) => {
    setQueryBusy(key);
    setError(null);
    try {
      const { text, real } = await api.queryRuntime(meId, key);
      setQueryOpen((q) => ({ ...q, [key]: { text, real } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not query this agent');
    } finally {
      setQueryBusy(null);
    }
  };

  const askLive = async () => {
    if (!liveQuestion.trim()) return;
    setLiveBusy(true);
    setLiveResult(null);
    try {
      const { text } = await api.askClaudeCliLive(meId, liveQuestion.trim());
      setLiveResult({ text });
    } catch (e) {
      setLiveResult({ error: e instanceof Error ? e.message : 'the claude CLI failed' });
    } finally {
      setLiveBusy(false);
    }
  };

  const disconnectGmail = () => run(async () => {
    await api.disconnectGmail(meId);
    await loadGmail();
  });

  return (
    <>
      <h2 className="label" style={{ marginTop: 32 }}>Your organization's agent</h2>
      <p className="sub">
        The only one connected to the org &mdash; it's the one that reads through your
        surfaces on <strong>Controls</strong> and the one other people's questions reach.
        It's set once for everyone by an organization admin, not chosen here. Everything
        else you register below is a personal sub-agent: it never touches org surfaces,
        and nobody outside you can query it directly.
      </p>

      {error && (
        <p style={{ fontSize: 12, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '7px 11px', marginTop: 12 }}>
          {error}
        </p>
      )}

      <div className="panel" style={{ marginTop: 18 }}>
        <header>
          <span className="label">Main &middot; aggregator agent</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
            set by your organization's admin
          </span>
        </header>
        <div className="inner">
          {main ? (
            <div className="runtime-card">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{byKey.get(main.runtimeKey)?.name ?? main.runtimeKey}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>{byKey.get(main.runtimeKey)?.vendor}</span>
                <ScopePill scope={main.scope} />
                <span className="spacer" />
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>added {main.addedAt}</span>
              </div>
              <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '6px 0 0' }}>
                <strong>Reads:</strong> {byKey.get(main.runtimeKey)?.reads}. <strong>Hosted:</strong> {byKey.get(main.runtimeKey)?.host}.
              </p>
              {main.scope === 'pending' && (
                <p style={{ fontSize: 11, color: 'var(--ink3)', margin: '8px 0 0' }}>
                  Registration filed. Nothing connects until IT &amp; Security approves this runtime.
                </p>
              )}
              {(main.hasCustomApiKey || main.baseUrl || main.model) && (
                <p style={{ fontSize: 11, color: 'var(--ink3)', margin: '8px 0 0' }}>
                  This organization uses its own provider credentials for this agent
                  {main.baseUrl ? <> &mdash; questions and authorized data are sent to <strong>{main.baseUrl}</strong></> : ''},
                  not this platform's shared default.
                </p>
              )}
              <p className="glossary" style={{ marginTop: 9 }}>
                Read-only here &mdash; an organization admin sets this for everyone from
                Admin &rarr; Organizations. Everyone in the org shares the same one.
              </p>
            </div>
          ) : (
            <p style={{ fontSize: 12, color: 'var(--ink2)', margin: 0 }}>
              Your organization admin hasn't set up a main agent yet &mdash; nothing is
              connected to the org until they do.
            </p>
          )}
        </div>
      </div>

      {!main ? (
        <p className="sub" style={{ marginTop: 18 }}>
          Waiting on your organization admin to set a main agent &mdash; sub-agents route through it.
        </p>
      ) : (
        <div className="grid2" style={{ marginTop: 18 }}>
          <div className="panel" style={{ marginTop: 0 }}>
            <header>
              <span className="label">Agents under {byKey.get(main.runtimeKey)?.name ?? main.runtimeKey}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>{subs.length} registered</span>
            </header>
            <div className="inner">
              {subs.length === 0 && (
                <p style={{ fontSize: 12, color: 'var(--ink3)' }}>No sub-agents yet &mdash; register one from the catalog.</p>
              )}
              {subs.map((r) => {
                const entry = byKey.get(r.runtimeKey);
                if (!entry) return null;
                return (
                  <div key={r.runtimeKey} className="runtime-card">
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
                        <button className="chip" disabled={busy} onClick={() => disconnect(r.runtimeKey)}>Withdraw request</button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
                        <button className="chip" disabled={queryBusy === r.runtimeKey} onClick={() => query(r.runtimeKey)}>
                          {queryBusy === r.runtimeKey ? 'Asking…' : 'What did it complete today?'}
                        </button>
                        <button className="chip" disabled={busy} onClick={() => disconnect(r.runtimeKey)}>Disconnect</button>
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

                    {r.runtimeKey === 'claude-code' && r.scope !== 'pending' && (
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
          </div>

          <div className="panel" style={{ marginTop: 0 }}>
            <header><span className="label">Register another agent</span></header>
            <div className="inner">
              {subAvailable.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--ink3)' }}>Every catalog runtime is already registered.</p>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)', flex: 1, minWidth: 200 }}>
                      Agent
                      <select
                        aria-label="Sub-agent to register"
                        value={effectivePicked}
                        onChange={(e) => setPicked(e.target.value)}
                        style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 8px', fontSize: 12 }}
                      >
                        {subAvailable.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.name}{r.blocked ? ' — blocked' : !r.approved ? ' — unapproved' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={busy || !pickedEntry || pickedEntry.blocked}
                      onClick={() => pickedEntry && register(pickedEntry.key)}
                      style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2, whiteSpace: 'nowrap' }}
                    >
                      {pickedEntry && !pickedEntry.approved ? 'Request approval' : 'Connect'}
                    </button>
                  </div>

                  {pickedEntry && (
                    <div className={`runtime-card${pickedEntry.blocked ? ' is-blocked' : ''}`} style={{ marginTop: 12 }}>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{pickedEntry.name}</span>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>{pickedEntry.vendor} &middot; {pickedEntry.contextWindow} context</span>
                      </div>
                      <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '6px 0 0' }}>
                        <strong>Hosted:</strong> {pickedEntry.host}.
                      </p>
                      <p style={{ fontSize: 12, color: 'var(--ink3)', margin: '6px 0 0' }}>{pickedEntry.note}</p>
                      {pickedEntry.blocked && (
                        <p className="locked" style={{ marginTop: 10 }}>&#8856; cannot be registered &mdash; no data-processing agreement</p>
                      )}
                    </div>
                  )}
                </>
              )}

              <p className="glossary" style={{ marginTop: 12 }}>
                A sub-agent never reads your org surfaces and nobody outside you can query it
                directly &mdash; only {byKey.get(main.runtimeKey)?.name ?? 'your main agent'} can
                ask it what it's been up to, and that's a personal status check, not an org read.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="panel" style={{ marginTop: 18 }}>
        <header>
          <span className="label">Personal data sources</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
            feed the daily summary only &mdash; never the org
          </span>
        </header>
        <div className="inner">
          <div className="runtime-card" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Gmail</span>
              {gmail?.connected ? (
                <span className="pill pill-full"><i />Connected</span>
              ) : (
                <span className="pill pill-blocked"><i />Not connected</span>
              )}
              <span className="spacer" />
              {gmail?.connected && gmail.email && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>{gmail.email}</span>
              )}
            </div>
            <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '6px 0 0' }}>
              Read-only, today's messages only (subject and snippet, never full bodies).
              Requires a one-time Google consent in a new tab.
            </p>
            <div style={{ marginTop: 9 }}>
              {gmail?.connected ? (
                <button className="chip" disabled={busy} onClick={disconnectGmail}>Disconnect</button>
              ) : (
                <a
                  className="chip"
                  href={api.gmailConnectUrl(meId)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ textDecoration: 'none', display: 'inline-block' }}
                >
                  Connect Gmail
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      <ConnectorsPanel owner={{ kind: 'person', personId: meId }} />
    </>
  );
}
