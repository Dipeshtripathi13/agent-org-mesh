import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useOrg } from '../lib/OrgContext';
import { LoadingState } from '../components/EmptyState';
import { AnimatedNumber, CoverageKey, swatchStyle } from '../components/primitives';

type Data = Awaited<ReturnType<typeof api.overview>>;

export function Overview() {
  const { orgId } = useOrg();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Cleared at the start of every attempt, not just set on failure — orgId briefly
    // starts at 1 (OrgContext's placeholder default) before the real org list loads for
    // whoever's logged in, so this effect's very first run can 403 against an org the
    // account has no role on. `cancelled` additionally guards against that first, failing
    // request's promise settling *after* the follow-up request for the real orgId already
    // has — without it, a slow 403 arriving late could still stomp good data with an error
    // right after it rendered, which is exactly what a brand-new self-serve signup saw:
    // the two org?orgId=1 attempts (StrictMode's dev double-invoke) racing the real
    // org?orgId=N one, sometimes resolving last.
    let cancelled = false;
    setError(null);
    api.overview(orgId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [orgId]);

  if (error) return <p className="sub">Couldn&rsquo;t load the overview. Is the API running?</p>;
  if (!data) return <LoadingState />;

  const { bands } = data.coverage;
  const total = bands.connected + bands.partial + bands.stale + bands.absent || 1;

  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Overview</h1>
      <p className="sub">
        Every number here is counted from what this organization actually has &mdash; none of it is
        illustrative. A tool that doesn&rsquo;t apply to someone&rsquo;s role isn&rsquo;t counted
        against them.
      </p>

      <div className="cards stagger">
        <div className="card">
          <h3>Tool coverage</h3>
          <div className="metric"><AnimatedNumber value={data.coverage.percent} /><small>%</small></div>
          <div className="bar">
            <div style={{ flex: bands.connected / total, ...swatchStyle('connected') }} />
            <div style={{ flex: bands.partial / total, ...swatchStyle('partial') }} />
            <div style={{ flex: bands.stale / total, ...swatchStyle('stale') }} />
            <div style={{ flex: bands.absent / total, ...swatchStyle('absent') }} />
          </div>
          <CoverageKey />
        </div>

        <div className="card">
          <h3>Agents set up</h3>
          <div className="metric">
            <AnimatedNumber value={data.coverage.agentsLive} /><small>/{data.coverage.totalPeople}</small>
          </div>
          <p className="note">
            {data.coverage.agentsLive === data.coverage.totalPeople
              ? 'Every person in this organization has an agent deployed'
              : `${data.coverage.totalPeople - data.coverage.agentsLive} not yet deployed`}
          </p>
        </div>

        <div className="card">
          <h3>Questions answered</h3>
          <div className="metric"><AnimatedNumber value={data.queries} /></div>
          <p className="note">Each one shown to the person it was about, with the asker&rsquo;s name</p>
        </div>

        <div className="card">
          <h3>Refusals</h3>
          <div className="metric"><AnimatedNumber value={data.refusals.total} /></div>
          <p className="note">
            {data.refusals.wont} withheld by your rules &middot; {data.refusals.cant} never collected
          </p>
        </div>

        <div className="card accent">
          <h3>Gaps not named</h3>
          <div className="metric"><AnimatedNumber value={data.silentGaps} /></div>
          <p className="note">Answers that read as complete while tools were missing &mdash; drive this to zero</p>
        </div>
      </div>

      <div className="panel">
        <header><span className="label">Policy revision {data.policyRevision}</span></header>
        <div className="inner">
          <p className="sub" style={{ margin: 0 }}>
            Editing the policy matrix writes a new revision rather than updating in place. Every
            logged answer records the revision in force when it was returned, so changing policy
            today cannot rewrite what someone was told last week.
          </p>
        </div>
      </div>
    </>
  );
}
