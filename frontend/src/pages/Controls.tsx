import { useEffect, useState } from 'react';
import { api, type Person, type Surface } from '../lib/api';
import { swatchStyle } from '../components/primitives';
import { useMe } from '../lib/MeContext';
import { navigate } from '../lib/navigate';

const STATE_LABEL: Record<string, string> = {
  connected: 'Reading', partial: 'Reading (limited)', stale: 'Out of date',
  absent: 'Not reading', outOfScope: 'Not used for your role',
};

/** Tier codes mean something to the policy engine, not to people. */
const TIER_WORDS: Record<string, string> = {
  T1: 'records', T2: 'activity', T3: 'signals only',
};

export function Controls() {
  const { meId, meOrgId } = useMe();
  const [me, setMe] = useState<Person | null>(null);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [exportState, setExportState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [rowError, setRowError] = useState<{ key: string; message: string } | null>(null);

  const load = () => api.org(meOrgId).then((d) => {
    setMe(d.people.find((p) => p.id === meId) ?? null);
    setSurfaces(d.surfaces);
  });

  useEffect(() => { void load(); setExportState('idle'); }, [meId, meOrgId]);

  const cycle = async (surfaceKey: string) => {
    setRowError(null);
    try {
      await api.cycleSurface(meId, surfaceKey);
      await load();
    } catch (e) {
      setRowError({ key: surfaceKey, message: e instanceof Error ? e.message : 'That didn’t work. Try again.' });
    }
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
        Pause any tool your agent reads, and download everything it holds about you. Pausing takes
        effect straight away, and people who ask about you are told which tools weren&rsquo;t
        checked. To connect a new tool, use <strong>Set up my agent</strong>.
      </p>

      <div className="grid2" style={{ marginTop: 18 }}>
        <div className="panel" style={{ marginTop: 0 }}>
          <header>
            <span className="label">Tools your agent reads</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
              {me.coverage.connectedCount} of {me.coverage.inScopeCount} reading
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
                    <span style={{ fontSize: 11, color: 'var(--ink4)' }}>{TIER_WORDS[s.feedsTier] ?? s.feedsTier}</span>
                    <span className="spacer" />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>{STATE_LABEL[state]}</span>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--ink3)', margin: '5px 0 0' }}>{s.reads}</p>
                  <div style={{ marginTop: 9 }}>
                    {outOfScope ? (
                      <span style={{ fontSize: 11, color: 'var(--ink3)' }}>
                        Not used for your role, so it doesn&rsquo;t count against you.
                      </span>
                    ) : (
                      state === 'absent' ? (
                        <span style={{ fontSize: 12, color: 'var(--ink3)' }}>
                          <button type="button" className="linklike" onClick={() => navigate('/me/setup')}>Connect it</button>
                          {' '}in Set up my agent, or{' '}
                          <button type="button" className="linklike" onClick={() => cycle(s.key)}>resume</button>
                          {' '}if you paused it.
                        </span>
                      ) : (
                        <button className="chip" onClick={() => cycle(s.key)}>Pause reading</button>
                      )
                    )}
                    {rowError?.key === s.key && (
                      <p role="alert" style={{ fontSize: 12, color: 'var(--hold)', margin: '6px 0 0' }}>{rowError.message}</p>
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
                Everything your agent says about you, where each item came from, and every time
                someone asked about you &mdash; including what they weren&rsquo;t told &mdash; as
                one JSON file.
              </p>
              <button
                onClick={requestExport}
                disabled={exportState === 'busy'}
                style={{ height: 30, padding: '0 11px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2 }}
              >
                {exportState === 'busy' ? 'Preparing…' : exportState === 'done' ? 'Downloaded — download again' : 'Download my data'}
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
                  <span>What your agent says about you</span><span style={{ fontFamily: 'var(--mono)', color: 'var(--ink3)' }}>30 days</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span>Signals from chat tools</span><span style={{ fontFamily: 'var(--mono)', color: 'var(--ink3)' }}>7 days</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span>Record of who asked</span><span style={{ fontFamily: 'var(--mono)', color: 'var(--ink3)' }}>kept permanently</span>
                </div>
              </div>
              <p className="glossary" style={{ marginTop: 12 }}>
                The record of who asked is the one thing no one can delete, you included &mdash;
                it exists to protect you, so no question about you can go unrecorded.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
