import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useOrg } from '../lib/OrgContext';
import { ClaimItem, RefusalGlossary } from '../components/primitives';
import { EmptyState, LoadingState } from '../components/EmptyState';
import { IconChevron, IconLedger } from '../components/icons';

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
  if (!data) return <LoadingState />;

  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Audit log</h1>
      <p className="sub">
        Every answer this organization has given, kept exactly as it was sent. Entries can only be
        added &mdash; never edited or deleted &mdash; and each one is sealed against tampering, so
        changing the rules later can&rsquo;t rewrite what was already said.
      </p>

      <div className="panel stagger">
        <header>
          <span className="label">
            {data.entries.length} answers &middot; tamper check{' '}
            {data.integrity.valid
              ? 'passed'
              : data.chain.alteredRows > 0
                ? `FAILED — ${data.chain.alteredRows} answer${data.chain.alteredRows === 1 ? ' was' : 's were'} altered`
                : `incomplete from entry ${(data.integrity.brokenAt ?? 0) + 1}`}
          </span>
          <span className="small muted">current policy revision {data.currentRevision}</span>
        </header>

        {!data.integrity.valid && data.chain.alteredRows === 0 && (
          <p className="glossary" style={{ padding: '10px 14px', margin: 0 }}>
            Some entries below this point aren&rsquo;t linked to the ones before them. That came
            from a defect in how entries were ordered, fixed on 2026-09-27 &mdash; every answer
            still matches its own seal, so none of them has been altered. Entries can never be
            rewritten, so the earlier break stays visible here rather than being tidied away.
          </p>
        )}

        {data.entries.length === 0 ? (
          <EmptyState icon={<IconLedger />} title="Nothing asked yet">
            Ask about someone from the Ask screen and it appears here &mdash; and in their own &ldquo;Who asked about me&rdquo; at the same moment.
          </EmptyState>
        ) : (
          data.entries.map((e) => (
            <div key={e.id} className={`entry${open === e.id ? ' is-open' : ''}`}>
              <button className="entry-row" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                <span className="entry-toggle"><IconChevron /></span>
                <span className="entry-time">{new Date(e.createdAt).toISOString().slice(11, 19)}Z</span>
                <span className="entry-text">{e.question}</span>
                <span className="entry-rev">rev {e.policyRevisionId}</span>
              </button>

              {open === e.id && (
                <div className="entry-body">
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
