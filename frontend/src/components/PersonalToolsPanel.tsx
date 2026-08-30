import { useEffect, useState } from 'react';
import { api, type AgentRuntime, type PersonRuntime } from '../lib/api';

/** The personal (no-org) counterpart to org mode's "Agents under X"/"Register another
 *  agent" grid — declaring/approving which LLM tool you use as a sub-agent, a different
 *  concept from connecting a data source (that's `ConnectorsPanel`, driven by the same
 *  catalog for both account- and person-scoped owners). GitHub/Jira/ingest-token
 *  connections used to live here too, duplicating what `ConnectorsPanel` already covers
 *  through its own unified "Connect a tool" dropdown — removed once that dropdown grew to
 *  include them, rather than maintaining two ways to connect the same tool. */
export function PersonalToolsPanel() {
  const [catalog, setCatalog] = useState<AgentRuntime[]>([]);
  const [registered, setRegistered] = useState<PersonRuntime[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [runtimeBusy, setRuntimeBusy] = useState(false);

  const loadRuntimes = () => api.accountRuntimes().then((d) => { setCatalog(d.catalog); setRegistered(d.registered); });

  useEffect(() => {
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

  return (
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
  );
}
