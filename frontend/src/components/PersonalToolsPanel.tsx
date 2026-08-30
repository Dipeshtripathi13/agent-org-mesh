import { useEffect, useState } from 'react';
import { api, INGEST_SOURCES, type AgentRuntime, type IngestSource, type IngestToken, type PersonRuntime } from '../lib/api';
import { SOURCE_LABEL, ingestSnippet } from '../pages/SetUpMyAgent';

/** The personal (no-org) counterpart to OrgSetUpMyAgent's "Connect real tools"/GitHub/Jira
 *  panels — found live, reported directly: these tools "should be there along with" the
 *  generic connector catalog (ConnectorsPanel), not just it. A genuinely separate
 *  component rather than threading an `owner` prop through the org-mode page's own big,
 *  already-working block: that component's state (github/jira/tokens/sub-agent query
 *  results) is deeply intertwined with org-only concepts (org main agent, per-sub-agent
 *  live query), so extracting it cleanly would have meant rewriting working code for no
 *  functional gain. This one is smaller by design — just connect, status, disconnect, and
 *  token generation, the same subset PersonalMainAgentPanel actually needs. */
export function PersonalToolsPanel() {
  const [github, setGithub] = useState<{ connected: boolean; login: string | null } | null>(null);
  const [githubToken, setGithubToken] = useState('');
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);

  const [jira, setJira] = useState<{ connected: boolean; email: string | null; siteUrl: string | null } | null>(null);
  const [jiraSiteUrl, setJiraSiteUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [jiraApiToken, setJiraApiToken] = useState('');
  const [jiraBusy, setJiraBusy] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);

  const [tokens, setTokens] = useState<IngestToken[]>([]);
  const [newTokenLabel, setNewTokenLabel] = useState('');
  const [newTokenSource, setNewTokenSource] = useState<IngestSource>('claude-code');
  const [justCreated, setJustCreated] = useState<{ id: string; token: string; source: IngestSource } | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);

  const [catalog, setCatalog] = useState<AgentRuntime[]>([]);
  const [registered, setRegistered] = useState<PersonRuntime[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);

  const loadGithub = () => api.accountGithubStatus().then(setGithub);
  const loadJira = () => api.accountJiraStatus().then(setJira);
  const loadTokens = () => api.accountIngestTokens().then((d) => setTokens(d.tokens));
  const loadRuntimes = () => api.accountRuntimes().then((d) => { setCatalog(d.catalog); setRegistered(d.registered); });

  useEffect(() => {
    void loadGithub();
    void loadJira();
    void loadTokens();
    void loadRuntimes();
  }, []);

  const byKey = new Map(catalog.map((r) => [r.key, r]));
  const registeredKeys = new Set(registered.map((r) => r.runtimeKey));
  const subAvailable = catalog.filter((r) => !registeredKeys.has(r.key));
  const effectivePicked = picked ?? subAvailable[0]?.key ?? '';
  const pickedEntry = effectivePicked ? byKey.get(effectivePicked) ?? null : null;

  const registerSub = async (key: string) => {
    setRuntimeBusy(true);
    try {
      await api.registerAccountRuntime(key);
      setPicked(null);
      await loadRuntimes();
    } finally {
      setRuntimeBusy(false);
    }
  };
  const disconnectSub = async (key: string) => {
    setRuntimeBusy(true);
    try {
      await api.disconnectAccountRuntime(key);
      await loadRuntimes();
    } finally {
      setRuntimeBusy(false);
    }
  };

  const connectGithub = async () => {
    if (!githubToken.trim()) return;
    setGithubBusy(true);
    setGithubError(null);
    try {
      await api.connectAccountGithub(githubToken.trim());
      setGithubToken('');
      await loadGithub();
    } catch (e) {
      setGithubError(e instanceof Error ? e.message : 'GitHub rejected this token');
    } finally {
      setGithubBusy(false);
    }
  };
  const disconnectGithub = async () => {
    setGithubBusy(true);
    try {
      await api.disconnectAccountGithub();
      await loadGithub();
    } finally {
      setGithubBusy(false);
    }
  };

  const connectJira = async () => {
    if (!jiraSiteUrl.trim() || !jiraEmail.trim() || !jiraApiToken.trim()) return;
    setJiraBusy(true);
    setJiraError(null);
    try {
      await api.connectAccountJira(jiraSiteUrl.trim(), jiraEmail.trim(), jiraApiToken.trim());
      setJiraApiToken('');
      await loadJira();
    } catch (e) {
      setJiraError(e instanceof Error ? e.message : 'Jira rejected these credentials');
    } finally {
      setJiraBusy(false);
    }
  };
  const disconnectJira = async () => {
    setJiraBusy(true);
    try {
      await api.disconnectAccountJira();
      await loadJira();
    } finally {
      setJiraBusy(false);
    }
  };

  const createToken = async () => {
    if (!newTokenLabel.trim()) return;
    setTokenBusy(true);
    try {
      const created = await api.createAccountIngestToken(newTokenLabel.trim());
      setJustCreated({ ...created, source: newTokenSource });
      setNewTokenLabel('');
      await loadTokens();
    } finally {
      setTokenBusy(false);
    }
  };
  const revokeTok = async (tokenId: string) => {
    setTokenBusy(true);
    try {
      await api.revokeAccountIngestToken(tokenId);
      await loadTokens();
    } finally {
      setTokenBusy(false);
    }
  };

  return (
    <>
      <div className="panel" style={{ marginTop: 18 }}>
        <header>
          <span className="label">Your sub-agents</span>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
            just for you — nobody else can query these
          </span>
        </header>
        <div className="inner">
          {registered.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--ink3)', margin: 0 }}>Nothing registered yet.</p>
          ) : (
            <div style={{ display: 'grid', gap: 8, marginBottom: subAvailable.length > 0 ? 14 : 0 }}>
              {registered.map((r) => {
                const entry = byKey.get(r.runtimeKey);
                if (!entry) return null;
                return (
                  <div key={r.runtimeKey} className="runtime-card" style={{ marginBottom: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{entry.name}</span>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>{entry.vendor}</span>
                      <span className="spacer" />
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>added {r.addedAt}</span>
                    </div>
                    <div style={{ marginTop: 9 }}>
                      <button className="chip" disabled={runtimeBusy} onClick={() => disconnectSub(r.runtimeKey)}>Disconnect</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {subAvailable.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', paddingTop: registered.length > 0 ? 12 : 0, borderTop: registered.length > 0 ? '1px solid var(--rule2)' : 'none' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)', flex: 1, minWidth: 200 }}>
                Agent
                <select
                  aria-label="Sub-agent to register"
                  value={effectivePicked}
                  onChange={(e) => setPicked(e.target.value)}
                  style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 8px', fontSize: 12 }}
                >
                  {subAvailable.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                </select>
              </label>
              <button
                disabled={runtimeBusy || !pickedEntry || pickedEntry.blocked}
                onClick={() => pickedEntry && registerSub(pickedEntry.key)}
                style={{ height: 32, padding: '0 12px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2, whiteSpace: 'nowrap' }}
              >
                Connect
              </button>
            </div>
          )}
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
            never shared with anyone else, since there's no org here for it to feed.
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
                      <button className="chip" disabled={tokenBusy} onClick={() => revokeTok(t.id)}>Revoke</button>
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
                  observation here. Only Bash/Edit/Write/NotebookEdit calls are kept;
                  everything else is received and silently dropped. Nobody but you can ever
                  see this — there's no manager or org chart for it to feed.
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
            reads your own activity only — nobody else can ever see it
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
              {' '}(read-only scope is enough).
            </p>
            {githubError && (
              <p style={{ fontSize: 12, color: 'var(--hold)', marginTop: 8 }}>{githubError}</p>
            )}
            <div style={{ marginTop: 9 }}>
              {github?.connected ? (
                <button className="chip" disabled={githubBusy} onClick={disconnectGithub}>Disconnect</button>
              ) : (
                <div style={{ display: 'flex', gap: 7 }}>
                  <input
                    aria-label="GitHub personal access token"
                    type="password"
                    placeholder="ghp_&hellip;"
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && connectGithub()}
                    style={{ flex: 1, height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 12, minWidth: 220 }}
                  />
                  <button
                    disabled={githubBusy || !githubToken.trim()}
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
            reads your own activity only — nobody else can ever see it
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
              </a>, then paste it below with your Atlassian account email and site URL.
            </p>
            {jiraError && (
              <p style={{ fontSize: 12, color: 'var(--hold)', marginTop: 8 }}>{jiraError}</p>
            )}
            <div style={{ marginTop: 9 }}>
              {jira?.connected ? (
                <button className="chip" disabled={jiraBusy} onClick={disconnectJira}>Disconnect</button>
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
