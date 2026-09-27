import { useEffect, useMemo, useState } from 'react';
import { api, type Escalation, type Person } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useOrg } from '../lib/OrgContext';
import { describeEscalationStatus } from '../lib/escalationStatus';
import { TierBadge } from '../components/primitives';

export function Escalations() {
  const { orgId } = useOrg();
  const { people: myIdentities } = useAuth();
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // You act on an escalation as yourself — your own place in this org's chart — never as
  // someone picked from a list. The server derives the same identity from your session.
  const me = myIdentities.find((p) => p.orgId === orgId) ?? null;

  const load = () => {
    api.escalations(orgId).then((d) => setEscalations(d.escalations)).catch((e) => setError(e.message));
    api.org(orgId).then((d) => setPeople(d.people)).catch(() => setPeople([]));
  };
  useEffect(() => { load(); setError(null); }, [orgId]);

  const peopleById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);

  const act = async (id: string, action: 'acknowledge' | 'resolve') => {
    setBusyId(id);
    setError(null);
    try {
      const { escalation } = action === 'acknowledge'
        ? await api.acknowledgeEscalation(id)
        : await api.resolveEscalation(id);
      setEscalations((list) => list.map((e) => (e.id === id ? escalation : e)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not update this escalation');
    } finally {
      setBusyId(null);
    }
  };

  const disabledReason = me ? undefined : 'You need a place in this organization’s chart to act on escalations';

  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Escalations</h1>
      <p className="sub">
        What the agents raised on their own, who it reached, and what nobody has acknowledged
        yet. Raised automatically from real activity &mdash; never from a person filing it.
      </p>

      <p className="sub" style={{ fontSize: 12, marginTop: 12 }}>
        {me
          ? <>Acting as <strong>{me.name}</strong> &middot; {me.title}. You can act on escalations on your path, or where you are IT admin or Executive for the person.</>
          : <>You administer this organization but aren&rsquo;t in its chart, so you can view escalations but not acknowledge or resolve them.</>}
      </p>

      {error && (
        <p style={{ fontSize: 12, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '7px 11px', marginTop: 12 }}>
          {error}
        </p>
      )}

      {escalations.length === 0 && (
        <p className="sub" style={{ marginTop: 18 }}>Nothing has escalated for this organization yet.</p>
      )}
      <div className="stagger" style={{ display: 'grid', gap: 12, marginTop: 18 }}>
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
                    disabled={!me || busyId === e.id}
                    title={disabledReason}
                    onClick={() => act(e.id, 'acknowledge')}
                  >
                    {busyId === e.id ? 'Working…' : 'Acknowledge'}
                  </button>
                )}
                <button
                  className="chip"
                  disabled={!me || busyId === e.id}
                  title={disabledReason}
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
