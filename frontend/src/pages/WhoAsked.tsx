import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ClaimItem, RefusalGlossary } from '../components/primitives';
import { useMe } from '../lib/MeContext';
import { EmptyState, LoadingState } from '../components/EmptyState';
import { IconBell, IconChevron } from '../components/icons';

type Data = Awaited<ReturnType<typeof api.auditForSubject>>;

export function WhoAsked() {
  const { meId } = useMe();
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => { api.auditForSubject(meId).then(setData); }, [meId]);
  if (!data) return <LoadingState />;

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
          <EmptyState icon={<IconBell />} title="No one has asked about you yet">
            When someone does, it appears here straight away and the bell at the top of the page lights up.
          </EmptyState>
        ) : (
          data.entries.map((e) => (
            <div key={e.id} className={`entry${open === e.id ? ' is-open' : ''}`}>
              <button
                className="entry-row"
                aria-expanded={open === e.id}
                onClick={() => setOpen(open === e.id ? null : e.id)}
              >
                <span className="entry-toggle"><IconChevron /></span>
                <span className="entry-time">{new Date(e.createdAt).toISOString().slice(11, 19)}Z</span>
                <span className="entry-text">
                  <strong>{e.requesterRole === 'Self' ? 'You' : `As ${e.requesterRole.toLowerCase()}`}</strong>: {e.question}
                </span>
                <span className="entry-rev">rev {e.policyRevisionId}</span>
              </button>

              {open === e.id && (
                <div className="entry-body">
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
