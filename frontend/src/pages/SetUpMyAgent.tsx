import { useEffect, useState } from 'react';
import {
  api, INGEST_SOURCES,
  type AgentRuntime, type IngestSource, type IngestToken, type OrgMainAgent, type PersonRuntime, type RuntimeScope,
} from '../lib/api';
import { useMe } from '../lib/MeContext';

const SCOPE_LABEL: Record<RuntimeScope, string> = {
  full: 'Full scope', narrow: 'Narrowed scope', pending: 'Awaiting approval',
};

const SOURCE_LABEL: Record<IngestSource, string> = {
  'claude-code': 'Claude Code', codex: 'Codex CLI', 'gemini-cli': 'Gemini CLI',
};

function ingestSnippet(source: IngestSource, url: string, token: string): { file: string; snippet: string } {
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

function ScopePill({ scope }: { scope: RuntimeScope }) {
  return (
    <span className={`pill pill-${scope}`}>
      <i />{SCOPE_LABEL[scope]}
    </span>
  );
}

export function SetUpMyAgent() {
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
  const [tokens, setTokens] = useState<IngestToken[]>([]);
  const [newTokenLabel, setNewTokenLabel] = useState('');
  const [newTokenSource, setNewTokenSource] = useState<IngestSource>('claude-code');
  const [justCreated, setJustCreated] = useState<{ id: string; token: string; source: IngestSource } | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [github, setGithub] = useState<{ connected: boolean; login: string | null } | null>(null);
  const [githubTokenInput, setGithubTokenInput] = useState('');
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [jira, setJira] = useState<{ connected: boolean; email: string | null; siteUrl: string | null } | null>(null);
  const [jiraSiteUrl, setJiraSiteUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [jiraApiToken, setJiraApiToken] = useState('');
  const [jiraBusy, setJiraBusy] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const [liveQuestion, setLiveQuestion] = useState('');
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveResult, setLiveResult] = useState<{ text: string } | { error: string } | null>(null);

  const load = () => api.personRuntimes(meId).then((d) => {
    setCatalog(d.catalog);
    setRegistered(d.registered);
  });
  const loadOrgMain = () => api.orgMainAgent(meOrgId).then((d) => setOrgMain(d.registered));
  const loadGmail = () => api.gmailStatus(meId).then(setGmail);
  const loadTokens = () => api.ingestTokens(meId).then((d) => setTokens(d.tokens));
  const loadGithub = () => api.githubStatus(meId).then(setGithub);
  const loadJira = () => api.jiraStatus(meId).then(setJira);

  useEffect(() => {
    void load();
    void loadGmail();
    void loadTokens();
    void loadGithub();
    void loadJira();
    // Switching who "My agent" acts as — clear anything cached for the previous person.
    setQueryOpen({});
    setJustCreated(null);
    setGithubTokenInput('');
    setGithubError(null);
    setLiveQuestion('');
    setLiveResult(null);
    setJiraSiteUrl('');
    setJiraEmail('');
    setJiraApiToken('');
    setJiraError(null);
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

  const connectGithub = async () => {
    if (!githubTokenInput.trim()) return;
    setGithubBusy(true);
    setGithubError(null);
    try {
      await api.connectGithub(meId, githubTokenInput.trim());
      setGithubTokenInput('');
      await loadGithub();
    } catch (e) {
      setGithubError(e instanceof Error ? e.message : 'GitHub rejected this token');
    } finally {
      setGithubBusy(false);
    }
  };
  const disconnectGithubAction = () => run(async () => {
    await api.disconnectGithub(meId);
    await loadGithub();
  });

  const connectJira = async () => {
    if (!jiraSiteUrl.trim() || !jiraEmail.trim() || !jiraApiToken.trim()) return;
    setJiraBusy(true);
    setJiraError(null);
    try {
      await api.connectJira(meId, jiraSiteUrl.trim(), jiraEmail.trim(), jiraApiToken.trim());
      setJiraApiToken('');
      await loadJira();
    } catch (e) {
      setJiraError(e instanceof Error ? e.message : 'Jira rejected these credentials');
    } finally {
      setJiraBusy(false);
    }
  };
  const disconnectJiraAction = () => run(async () => {
    await api.disconnectJira(meId);
    await loadJira();
  });

  const createToken = async () => {
    if (!newTokenLabel.trim()) return;
    setTokenBusy(true);
    setError(null);
    try {
      const created = await api.createIngestToken(meId, newTokenLabel.trim());
      setJustCreated({ ...created, source: newTokenSource });
      setNewTokenLabel('');
      await loadTokens();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not create token');
    } finally {
      setTokenBusy(false);
    }
  };
  const revokeTok = (tokenId: string) => run(async () => {
    await api.revokeIngestToken(meId, tokenId);
    if (justCreated?.id === tokenId) setJustCreated(null);
    await loadTokens();
  });

  return (
    <>
      <div className="crumb">My agent &middot; set up</div>
      <h1>Set up my agent</h1>
      <p className="sub">
        Your organization's main agent is the only one connected to the org &mdash; it's the
        one that reads through your surfaces on <strong>Controls</strong> and the one other
        people's questions reach. It's set once for everyone by an organization admin, not
        chosen here. Everything else you register below is a personal sub-agent: it never
        touches org surfaces, and nobody outside you can query it directly.
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

      <div className="panel" style={{ marginTop: 18 }}>
        <header>
          <span className="label">Connect real tools</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
            self-service &mdash; your tool pushes its own activity
          </span>
        </header>
        <div className="inner">
          <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 0 }}>
            Generate a token, paste it into your own Claude Code, Codex CLI, or Gemini CLI
            hook config, and that tool reports real activity straight to this mesh &mdash;
            from wherever it actually runs, not just this machine. The token is the only
            thing that authenticates a pushed event; nothing else in the request is trusted.
          </p>

          {tokens.length > 0 && (
            <div style={{ marginBottom: 14 }}>
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
                      <button className="chip" disabled={busy} onClick={() => revokeTok(t.id)}>Revoke</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
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
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)' }}>
              Tool
              <select
                aria-label="Tool"
                value={newTokenSource}
                onChange={(e) => setNewTokenSource(e.target.value as IngestSource)}
                style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 8px', fontSize: 12 }}
              >
                {INGEST_SOURCES.map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
              </select>
            </label>
            <button
              disabled={tokenBusy || !newTokenLabel.trim()}
              onClick={createToken}
              style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2 }}
            >
              {tokenBusy ? 'Generating…' : 'Generate token'}
            </button>
          </div>

          {justCreated && (() => {
            const url = `${window.location.protocol}//${window.location.hostname}:3001/api/ingest/${justCreated.source}`;
            const { file, snippet } = ingestSnippet(justCreated.source, url, justCreated.token);
            return (
              <div className="coverage-note" style={{ marginTop: 14 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--hold)' }}>
                  Shown once &mdash; copy it now, it isn't stored anywhere you can retrieve again
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
                  Every command/file-editing tool call in that project will push a real
                  observation to this mesh. Only Bash/Edit/Write/NotebookEdit calls are kept;
                  everything else is received and silently dropped, same as this demo's local
                  session-log read. Your first pushed event connects this surface for real —
                  after that, it feeds real claims anyone can Ask about you through the same
                  policy grid as anything else.
                </p>
              </div>
            );
          })()}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 18 }}>
        <header>
          <span className="label">GitHub</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
            a real org surface &mdash; unlike Gmail, this feeds the org, not just you
          </span>
        </header>
        <div className="inner">
          <div className="runtime-card" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>GitHub</span>
              {github?.connected ? (
                <span className="pill pill-full"><i />Connected</span>
              ) : (
                <span className="pill pill-blocked"><i />Not connected</span>
              )}
              <span className="spacer" />
              {github?.connected && github.login && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>@{github.login}</span>
              )}
            </div>
            <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '6px 0 0' }}>
              Reads pull requests you opened and reviews you gave &mdash; never file contents.
              Paste a personal access token from{' '}
              <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">github.com/settings/tokens</a>
              {' '}(read-only scope is enough). Once connected, it becomes a real claim source
              through the same policy grid as anything else &mdash; whoever your role allows can
              see it, same as Claude Code activity.
            </p>
            {githubError && (
              <p style={{ fontSize: 12, color: 'var(--hold)', marginTop: 8 }}>{githubError}</p>
            )}
            <div style={{ marginTop: 9 }}>
              {github?.connected ? (
                <button className="chip" disabled={busy} onClick={disconnectGithubAction}>Disconnect</button>
              ) : (
                <div style={{ display: 'flex', gap: 7 }}>
                  <input
                    aria-label="GitHub personal access token"
                    type="password"
                    placeholder="ghp_&hellip;"
                    value={githubTokenInput}
                    onChange={(e) => setGithubTokenInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && connectGithub()}
                    style={{ flex: 1, height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 12, minWidth: 220 }}
                  />
                  <button
                    disabled={githubBusy || !githubTokenInput.trim()}
                    onClick={connectGithub}
                    style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2, whiteSpace: 'nowrap' }}
                  >
                    {githubBusy ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 18 }}>
        <header>
          <span className="label">Jira</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
            a real org surface &mdash; unverified, no instance to test against yet
          </span>
        </header>
        <div className="inner">
          <div className="runtime-card" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Jira</span>
              {jira?.connected ? (
                <span className="pill pill-full"><i />Connected</span>
              ) : (
                <span className="pill pill-blocked"><i />Not connected</span>
              )}
              <span className="spacer" />
              {jira?.connected && jira.email && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>{jira.email}</span>
              )}
            </div>
            <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '6px 0 0' }}>
              Reads issues assigned to or reported by you &mdash; never comments or
              attachments. Generate an API token at{' '}
              <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">
                id.atlassian.com/manage-profile/security/api-tokens
              </a>, then paste it below with your Atlassian account email and site URL
              (e.g. https://yourteam.atlassian.net). Built the same way as every other
              connector here, but nobody's tested it against a real site yet &mdash; if
              something breaks, that's why.
            </p>
            {jiraError && (
              <p style={{ fontSize: 12, color: 'var(--hold)', marginTop: 8 }}>{jiraError}</p>
            )}
            <div style={{ marginTop: 9 }}>
              {jira?.connected ? (
                <button className="chip" disabled={busy} onClick={disconnectJiraAction}>Disconnect</button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 7, maxWidth: 420 }}>
                  <input
                    aria-label="Jira site URL"
                    placeholder="https://yourteam.atlassian.net"
                    value={jiraSiteUrl}
                    onChange={(e) => setJiraSiteUrl(e.target.value)}
                    style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 12 }}
                  />
                  <input
                    aria-label="Jira account email"
                    placeholder="you@company.com"
                    value={jiraEmail}
                    onChange={(e) => setJiraEmail(e.target.value)}
                    style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 12 }}
                  />
                  <div style={{ display: 'flex', gap: 7 }}>
                    <input
                      aria-label="Jira API token"
                      type="password"
                      placeholder="API token"
                      value={jiraApiToken}
                      onChange={(e) => setJiraApiToken(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && connectJira()}
                      style={{ flex: 1, height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 12 }}
                    />
                    <button
                      disabled={jiraBusy || !jiraSiteUrl.trim() || !jiraEmail.trim() || !jiraApiToken.trim()}
                      onClick={connectJira}
                      style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2, whiteSpace: 'nowrap' }}
                    >
                      {jiraBusy ? 'Connecting…' : 'Connect'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
