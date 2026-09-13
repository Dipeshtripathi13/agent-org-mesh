import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ClaimItem, RefusalGlossary } from '../components/primitives';
import { useMe } from '../lib/MeContext';

type Data = Awaited<ReturnType<typeof api.auditForSubject>>;

export function WhoAsked() {
  const { meId } = useMe();
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api.auditForSubject(meId).then(setData); }, [meId]);
  if (!data) return <p className="sub">Loading&hellip;</p>;

  return (
    <>
      <div className="crumb">My agent &middot; who asked about me</div>
      <h1>Who asked about me</h1>
      <p className="sub">
        Every time someone asked your agent about you: who, when, and exactly what they were told
        or not told. Nothing here is hidden from you.
      </p>

      <div className="panel">
        <header>
          <span className="label">{data.entries.length === 1 ? '1 question' : `${data.entries.length} questions`}</span>
        </header>

        {data.entries.length === 0 ? (
          <div className="inner">
            <p style={{ margin: 0, fontSize: 12, color: 'var(--ink2)' }}>
              No one has asked about you yet. When someone does, it appears here straight away,
              and the bell at the top of the page lights up.
            </p>
          </div>
        ) : (
          data.entries.map((e) => (
            <div key={e.id} style={{ borderBottom: '1px solid var(--rule)' }}>
              <button
                onClick={() => setOpen(open === e.id ? null : e.id)}
                style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 0, padding: '10px 14px', display: 'grid', gridTemplateColumns: '16px 150px 1fr auto', gap: 12, alignItems: 'center' }}
              >
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--ink3)' }}>
                  {open === e.id ? '−' : '+'}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
                  {new Date(e.createdAt).toISOString().slice(11, 19)}Z
                </span>
                <span style={{ fontSize: 12 }}>
                  <strong>{e.requesterRole === 'Self' ? 'You' : `As ${e.requesterRole.toLowerCase()}`}</strong>: {e.question}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>
                  rev {e.policyRevisionId}
                </span>
              </button>

              {open === e.id && (
                <div style={{ padding: '0 14px 14px 42px' }}>
                  {e.snapshot.items.map((item, i) => <ClaimItem key={i} item={item} />)}
                  <div className="coverage-note">{e.snapshot.coverage.text}</div>
                  <RefusalGlossary />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
