import { useEffect, useState } from 'react';
import {
  api,
  type AccountMainAgent, type AgentRuntime, type IngestSource, type OrgMainAgent, type RuntimeScope,
} from '../lib/api';
import { ConnectorsPanel } from '../components/ConnectorsPanel';
import { CredentialsFields } from '../components/primitives';
import { useAuth } from '../lib/AuthContext';
import { useMe } from '../lib/MeContext';
import { navigate } from '../lib/navigate';

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
  if (source === 'codex') {
    // Codex runs hooks from the project's .codex/hooks.json (same PostToolUse shape as Claude
    // Code). Unlike Claude Code's settings.local.json, git doesn't ignore this file, and it
    // holds the token — found in the end-to-end test, 2026-09-13.
    return {
      file: '.codex/hooks.json in the project you want to report on. It contains your token: add .codex/hooks.json to that project\'s .gitignore. Codex asks you to trust the hook the first time it runs.',
      snippet: JSON.stringify({
        hooks: { PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: curl }] }] },
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
      <h2 className="label" style={{ marginTop: 0 }}>Your private agent</h2>
      <p className="sub">
        Just for you &mdash; separate from your organization&rsquo;s agent. No one else can use
        it, see your chats, or read the tools you connect here.
      </p>
      <div className="panel" style={{ marginTop: 18 }}>
        <header>
          <span className="label">Which AI answers</span>
          <span style={{ fontSize: 11, color: 'var(--ink3)' }}>just for you</span>
        </header>
        <div className="inner">
          {showForm ? (
            <>
              <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 0 }}>
                {main
                  ? 'Changes apply to your next question.'
                  : 'Not chosen yet — your private agent can’t answer until you pick one.'}
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
                  {main ? 'Save changes' : 'Use this AI'}
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
  const { orgRoles } = useAuth();
  const isOrgAdmin = orgRoles[meOrgId] === 'owner' || orgRoles[meOrgId] === 'admin';
  const [catalog, setCatalog] = useState<AgentRuntime[]>([]);
  const [orgMain, setOrgMain] = useState<OrgMainAgent | null>(null);

  // Only needed to resolve the org main agent's own display name/vendor/reads/host below —
  // registration state for *personal* sub-agents now lives entirely in ConnectorsPanel,
  // which fetches its own copy of this same catalog independently.
  useEffect(() => { void api.runtimeCatalog().then((d) => setCatalog(d.catalog)); }, []);
  // The main agent is org-level, not person-level — reload it independently whenever
  // switching to an identity in a different org (a person switch that stays in the same
  // org doesn't need a fresh fetch, but this is cheap enough not to bother distinguishing).
  useEffect(() => { void api.orgMainAgent(meOrgId).then((d) => setOrgMain(d.registered)); }, [meOrgId]);

  const byKey = new Map(catalog.map((r) => [r.key, r]));
  const main = orgMain;

  return (
    <>
      <h2 className="label" style={{ marginTop: 32 }}>Your organization's agent</h2>
      <p className="sub">
        This is the agent that answers when people in your organization ask about each other,
        including about you. One is chosen for the whole organization by its admins. The tools you
        connect below are what it can read about your work.
      </p>

      <div className="panel" style={{ marginTop: 18 }}>
        <header>
          <span className="label">Which AI answers</span>
          <span style={{ fontSize: 11, color: 'var(--ink3)' }}>
            {isOrgAdmin ? 'you can change this in Admin' : 'chosen by your organization’s admins'}
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
                Everyone in the organization shares this one.{' '}
                {isOrgAdmin && <button type="button" className="linklike" onClick={() => navigate('/admin/organizations')}>Change it in Admin</button>}
              </p>
            </div>
          ) : (
            isOrgAdmin ? (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <p style={{ fontSize: 13, color: 'var(--ink2)', margin: 0 }}>
                  Not chosen yet &mdash; no one can get answers until you pick one.
                </p>
                <button type="button" className="btn btn-primary" onClick={() => navigate('/admin/organizations')}>Choose the AI</button>
              </div>
            ) : (
              <p style={{ fontSize: 12, color: 'var(--ink2)', margin: 0 }}>
                Your organization&rsquo;s admins haven&rsquo;t chosen one yet, so no one can get
                answers until they do.
              </p>
            )
          )}
        </div>
      </div>

      <ConnectorsPanel owner={{ kind: 'person', personId: meId }} />
    </>
  );
}
