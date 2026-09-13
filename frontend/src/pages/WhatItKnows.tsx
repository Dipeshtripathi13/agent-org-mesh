import { useEffect, useState } from 'react';
import { api, type Claim } from '../lib/api';
import { TierBadge } from '../components/primitives';
import { useMe } from '../lib/MeContext';

export function WhatItKnows() {
  const { meId } = useMe();
  const [claims, setClaims] = useState<Claim[]>([]);
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.person(meId).then((d) => setClaims(d.claims));
  useEffect(() => { void load(); }, [meId]);

  const submit = async (id: string) => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      await api.correctClaim(id, note.trim());
      await load();
      setCorrecting(null);
      setNote('');
    } finally {
      setBusy(false);
    }
  };

  const active = claims.filter((c) => !c.supersededBy);
  const corrected = claims.filter((c) => c.supersededBy);

  return (
    <>
      <div className="crumb">My agent &middot; what it knows</div>
      <h1>What it knows</h1>
      <p className="sub">
        What your agent currently says about your work, built from the tools you&rsquo;ve
        connected. Each item links to where it came from. If something is wrong, correct it: the
        correction replaces it in every future answer straight away, and the original stays here
        as history.
      </p>

      <div className="stagger" style={{ display: 'grid', gap: 12, marginTop: 18 }}>
        {active.map((c) => (
          <div key={c.id} className={`item t-${c.tier}`} style={{ marginBottom: 0 }}>
            <div className="row">
              <TierBadge tier={c.tier} />
              <p>{c.text}</p>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 9 }}>
              {c.evidenceId && (
                <button className={`evidence-chip e-${c.tier}`}>{c.evidenceId} &#8599;</button>
              )}
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
                {c.dataClass} class &middot; derived {new Date(c.derivedAt).toISOString().slice(0, 10)}
              </span>
              <span className="spacer" />
              <button
                className="chip"
                onClick={() => { setCorrecting(correcting === c.id ? null : c.id); setNote(''); }}
              >
                This is wrong
              </button>
            </div>

            {correcting === c.id && (
              <div style={{ marginTop: 10, border: '1px solid var(--rule2)', background: '#f8f9fa', padding: '10px 12px' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink3)' }}>
                  Correction &mdash; supersedes this claim
                </div>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What is actually true, and where can it be verified?"
                  style={{ width: '100%', minHeight: 58, marginTop: 8, border: '1px solid var(--rule2)', borderRadius: 2, fontSize: 12, padding: '7px 8px', fontFamily: 'inherit' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                  <button
                    onClick={() => submit(c.id)}
                    disabled={busy || !note.trim()}
                    style={{ height: 28, padding: '0 10px', fontSize: 12, background: 'var(--ink)', color: '#fff', border: '1px solid var(--ink)', borderRadius: 2 }}
                  >
                    Submit correction
                  </button>
                  <button
                    onClick={() => setCorrecting(null)}
                    style={{ height: 28, padding: '0 10px', fontSize: 12, background: '#fff', border: '1px solid var(--rule2)', borderRadius: 2 }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}

        {corrected.length > 0 && (
          <div className="panel" style={{ marginTop: 0 }}>
            <header><span className="label">Corrected &mdash; suppressed from every answer</span></header>
            <div className="inner">
              {corrected.map((c) => (
                <div key={c.id} style={{ padding: '8px 0', borderTop: '1px solid #f1f3f4', fontSize: 12, color: 'var(--ink3)' }}>
                  <TierBadge tier={c.tier} /> <span style={{ marginLeft: 6, textDecoration: 'line-through' }}>{c.text}</span>
                  {c.supersededBy && (
                    <p style={{ margin: '4px 0 0', color: 'var(--ink2)' }}>
                      <strong>Correction:</strong> {c.supersededBy}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {active.length === 0 && corrected.length === 0 && (
          <div className="panel" style={{ marginTop: 0 }}>
            <div className="inner">
              <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Nothing yet</p>
              <p style={{ fontSize: 12, color: 'var(--ink2)', margin: '5px 0 0', maxWidth: '70ch' }}>
                Your agent hasn&rsquo;t summarized any of your work so far. Connect a tool in{' '}
                <strong>Set up my agent</strong>; once it has activity, what your agent says
                about you appears here, and you can correct anything that&rsquo;s wrong.
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
