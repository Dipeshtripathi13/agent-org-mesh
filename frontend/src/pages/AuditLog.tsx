import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useOrg } from '../lib/OrgContext';
import { ClaimItem, RefusalGlossary } from '../components/primitives';

type Data = Awaited<ReturnType<typeof api.audit>>;

export function AuditLog() {
  const { orgId, organizations } = useOrg();
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  // Only fetch once `orgId` is confirmed to be one of this account's real orgs — orgId
  // starts at a hardcoded default before the org list arrives, and this admin-only
  // endpoint 403s on a stale/inaccessible org in that brief window (same fix as
  // OrgSetup.tsx's OrgAdmins).
  const known = organizations.some((o) => o.id === orgId);
  useEffect(() => { if (known) api.audit(orgId).then(setData); }, [orgId, known]);
  if (!data) return <p className="sub">Loading&hellip;</p>;

  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Audit log</h1>
      <p className="sub">
        Append-only and hash-chained. Each entry stores the answer exactly as it was returned,
        never re-derived &mdash; so a later policy change cannot rewrite it.
      </p>

      <div className="panel stagger">
        <header>
          <span className="label">
            {data.entries.length} exchanges &middot; chain {data.integrity.valid ? 'verified' : 'BROKEN'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--ink3)' }}>
            current policy revision {data.currentRevision}
          </span>
        </header>

        {data.entries.length === 0 ? (
          <div className="inner">
            <p style={{ margin: 0, fontSize: 12, color: 'var(--ink2)' }}>
              No reads yet. Run a query from the Ask screen and it will appear here &mdash; and in
              the subject&rsquo;s own log at the same instant.
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
                  {open === e.id ? '\u2212' : '+'}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
                  {new Date(e.createdAt).toISOString().slice(11, 19)}Z
                </span>
                <span style={{ fontSize: 12 }}>{e.question}</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)' }}>
                  rev {e.policyRevisionId}
                </span>
              </button>

              {open === e.id && (
                <div style={{ padding: '0 14px 14px 42px' }}>
                  {e.policyChangedSince && (
                    <p className="changed">
                      Policy has changed since this read. This record shows what was actually
                      returned under revision {e.policyRevisionId}.
                    </p>
                  )}
                  {e.snapshot.synthesizedAnswer && (
                    <div className="coverage-note" style={{ marginBottom: 10 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink3)', display: 'block', marginBottom: 4 }}>
                        ANSWER GIVEN
                      </span>
                      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{e.snapshot.synthesizedAnswer}</p>
                    </div>
                  )}
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
