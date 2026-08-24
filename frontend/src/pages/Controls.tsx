import { useEffect, useState } from 'react';
import { api, type Person, type Surface } from '../lib/api';
import { swatchStyle } from '../components/primitives';
import { useMe } from '../lib/MeContext';

const STATE_LABEL: Record<string, string> = {
  connected: 'connected', partial: 'partial scope', stale: 'stale',
  absent: 'not connected', outOfScope: 'out of scope for role',
};

export function Controls() {
  const { meId, meOrgId } = useMe();
  const [me, setMe] = useState<Person | null>(null);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [exportState, setExportState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');

  const load = () => api.org(meOrgId).then((d) => {
    setMe(d.people.find((p) => p.id === meId) ?? null);
    setSurfaces(d.surfaces);
  });

  useEffect(() => { void load(); setExportState('idle'); }, [meId, meOrgId]);

  const cycle = async (surfaceKey: string) => {
    await api.cycleSurface(meId, surfaceKey);
    await load();
  };

  const requestExport = async () => {
    setExportState('busy');
    try {
      const bundle = await api.exportPerson(meId);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${me?.name ?? 'export'}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExportState('done');
    } catch {
      setExportState('error');
    }
  };

  if (!me) return <p className="sub">Loading&hellip;</p>;

  return (
    <>
      <div className="crumb">My agent &middot; controls</div>
      <h1>Controls</h1>
      <p className="sub">
        Narrow what your agent may read, and take everything it holds with you. Connecting or
        disconnecting a surface changes your coverage immediately, and is never hidden from
        requesters &mdash; gaps are named in every answer.
      </p>

      <div className="grid2" style={{ marginTop: 18 }}>
        <div className="panel" style={{ marginTop: 0 }}>
          <header>
            <span className="label">Your work surfaces</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
              {me.coverage.connectedCount} of {me.coverage.inScopeCount} connected &middot; {me.coverage.percent}%
            </span>
          </header>
          <div>
            {surfaces.map((s) => {
              const state = me.surfaces[s.key];
              const outOfScope = state === 'outOfScope';
              return (
                <div key={s.key} style={{ padding: '11px 14px', borderBottom: '1px solid #f1f3f4' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <i style={{ width: 9, height: 9, display: 'inline-block', ...swatchStyle(state) }} />
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink4)' }}>feeds {s.feedsTier}</span>
                    <span className="spacer" />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>{STATE_LABEL[state]}</span>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--ink3)', margin: '5px 0 0' }}>{s.reads}</p>
                  <div style={{ marginTop: 9 }}>
                    {outOfScope ? (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
                        nothing to connect &mdash; excluded from your coverage denominator
                      </span>
                    ) : (
                      <button className="chip" onClick={() => cycle(s.key)}>
                        Cycle: connected &rarr; partial &rarr; disconnect
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 18 }}>
          <div className="panel" style={{ marginTop: 0 }}>
            <header><span className="label">Export everything held about you</span></header>
            <div className="inner">
              <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--ink2)' }}>
                All claims, their tiers, their evidence links, and every audit entry where
                you were the subject &mdash; including every refusal &mdash; as a JSON file,
                downloaded immediately.
              </p>
              <button
                onClick={requestExport}
                disabled={exportState === 'busy'}
                style={{ height: 30, padding: '0 11px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2 }}
              >
                {exportState === 'busy' ? 'Preparing…' : exportState === 'done' ? 'Downloaded — request again' : 'Request export'}
              </button>
              {exportState === 'error' && (
                <p style={{ fontSize: 12, color: 'var(--hold)', marginTop: 8 }}>Could not prepare the export — try again.</p>
              )}
            </div>
          </div>

          <div className="panel" style={{ marginTop: 0 }}>
            <header><span className="label">Retention</span></header>
            <div className="inner">
              <div style={{ display: 'grid', gap: 7, fontSize: 12, color: 'var(--ink2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span>Derived claims</span><span style={{ fontFamily: 'var(--mono)', color: 'var(--ink3)' }}>30 days</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span>T3 signals</span><span style={{ fontFamily: 'var(--mono)', color: 'var(--ink3)' }}>7 days</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span>Query log (who asked)</span><span style={{ fontFamily: 'var(--mono)', color: 'var(--ink3)' }}>immutable</span>
                </div>
              </div>
              <p className="glossary" style={{ marginTop: 12 }}>
                The query log is the one thing you cannot delete &mdash; it exists to protect
                you, and deleting it would let a read go unrecorded.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
