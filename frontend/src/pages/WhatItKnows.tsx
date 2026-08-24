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
        Your current work picture as your agent would describe it. Every claim carries its tier
        and evidence &mdash; and a way to correct it. A correction supersedes the claim; it drops
        out of every future answer immediately, but stays visible here as history.
      </p>

      <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
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

        <div style={{ border: '1px dashed var(--rule2)', background: 'repeating-linear-gradient(135deg, #f4f6f7 0 5px, #fbfcfc 5px 10px)', padding: 14 }}>
          <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>What your agent could not form a view on</p>
          <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 5, marginBottom: 0, maxWidth: '80ch' }}>
            Design-doc work (Confluence) and anything customer-facing (Salesforce, out of scope
            for your role). Rather than infer from Slack, your agent leaves these blank.
          </p>
        </div>
      </div>
    </>
  );
}
