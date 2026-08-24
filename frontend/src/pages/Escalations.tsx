import { useEffect, useMemo, useState } from 'react';
import { api, type Escalation, type Person } from '../lib/api';
import { useOrg } from '../lib/OrgContext';
import { describeEscalationStatus } from '../lib/escalationStatus';
import { TierBadge } from '../components/primitives';

export function Escalations() {
  const { orgId } = useOrg();
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [actorId, setActorId] = useState<number | ''>('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.escalations(orgId).then((d) => setEscalations(d.escalations));
    api.org(orgId).then((d) => setPeople(d.people));
  };
  useEffect(() => { load(); setActorId(''); setError(null); }, [orgId]);

  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const act = async (id: string, action: 'acknowledge' | 'resolve') => {
    if (!actorId) return;
    setBusyId(id);
    setError(null);
    try {
      const { escalation } = action === 'acknowledge'
        ? await api.acknowledgeEscalation(id, actorId)
        : await api.resolveEscalation(id, actorId);
      setEscalations((list) => list.map((e) => (e.id === id ? escalation : e)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not update this escalation');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Escalations</h1>
      <p className="sub">
        What the mesh pushed upward on its own, where it landed, and what has not been
        acknowledged. Detected automatically from real activity &mdash; see the three rules
        in docs/escalation-triage.md.
      </p>

      <label style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--ink3)', marginTop: 16 }}>
        Acting as &mdash; required to acknowledge or resolve
        <select
          aria-label="Acting as"
          value={actorId}
          onChange={(e) => setActorId(e.target.value ? Number(e.target.value) : '')}
          style={{ height: 32, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 8px', fontSize: 12, minWidth: 240 }}
        >
          <option value="">Choose a person&hellip;</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name} &middot; {p.title}</option>)}
        </select>
      </label>

      {error && (
        <p style={{ fontSize: 12, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '7px 11px', marginTop: 12 }}>
          {error}
        </p>
      )}

      {escalations.length === 0 && (
        <p className="sub" style={{ marginTop: 18 }}>Nothing has escalated for this organization yet.</p>
      )}
      <div style={{ display: 'grid', gap: 12, marginTop: 18 }}>
        {escalations.map((e) => (
          <div key={e.id} className={`item t-${e.kind}`} style={{ marginBottom: 0 }}>
            <div className="row">
              <TierBadge tier={e.kind} />
              <p style={{ fontWeight: 600 }}>{e.title}</p>
            </div>
            <p style={{ marginTop: 6 }}>{e.detail}</p>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
              <span className="esc-path">{e.path.map((p) => p.name).join(' → ')}</span>
              <span className="esc-path">rule {e.rule}</span>
              <span className="esc-path">age {e.ageDays}d</span>
              <span className="spacer" />
              <span style={{ fontSize: 11, color: 'var(--ink3)' }}>{describeEscalationStatus(e, peopleById)}</span>
              {e.evidenceId && (
                <button className={`evidence-chip e-${e.kind}`}>{e.evidenceId} &#8599;</button>
              )}
            </div>
            {e.status !== 'resolved' && (
              <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                {e.status === 'open' && (
                  <button
                    className="chip"
                    disabled={!actorId || busyId === e.id}
                    title={actorId ? undefined : 'Choose who you are acting as first'}
                    onClick={() => act(e.id, 'acknowledge')}
                  >
                    {busyId === e.id ? 'Working…' : 'Acknowledge'}
                  </button>
                )}
                <button
                  className="chip"
                  disabled={!actorId || busyId === e.id}
                  title={actorId ? undefined : 'Choose who you are acting as first'}
                  onClick={() => act(e.id, 'resolve')}
                >
                  {busyId === e.id ? 'Working…' : 'Resolve'}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
