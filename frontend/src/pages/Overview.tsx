import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useOrg } from '../lib/OrgContext';
import { CoverageKey, swatchStyle } from '../components/primitives';

type Data = Awaited<ReturnType<typeof api.overview>>;

export function Overview() {
  const { orgId } = useOrg();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Cleared at the start of every attempt, not just set on failure — orgId briefly
    // starts at 1 (OrgContext's placeholder default) before the real org list loads for
    // whoever's logged in, so this effect's very first run can 403 against an org the
    // account has no role on. Without clearing here, that transient failure stuck
    // forever: the follow-up fetch against the *correct* orgId would succeed, set real
    // data, and still render the error underneath it — first thing a brand-new self-serve
    // signup saw was "Couldn't load the overview," even though it had, a moment later.
    setError(null);
    api.overview(orgId).then(setData).catch((e) => setError(String(e)));
  }, [orgId]);

  if (error) return <p className="sub">Couldn&rsquo;t load the overview. Is the API running?</p>;
  if (!data) return <p className="sub">Loading&hellip;</p>;

  const { bands } = data.coverage;
  const total = bands.connected + bands.partial + bands.stale + bands.absent || 1;

  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Deployment overview</h1>
      <p className="sub">
        Every number here is computed from the org, never a literal. Coverage is weighted by
        surfaces in scope for each role &mdash; surfaces that don&rsquo;t apply are excluded from
        the denominator rather than counted as failures.
      </p>

      <div className="cards">
        <div className="card">
          <h3>Org coverage</h3>
          <div className="metric">{data.coverage.percent}<small>%</small></div>
          <div className="bar">
            <div style={{ flex: bands.connected / total, ...swatchStyle('connected') }} />
            <div style={{ flex: bands.partial / total, ...swatchStyle('partial') }} />
            <div style={{ flex: bands.stale / total, ...swatchStyle('stale') }} />
            <div style={{ flex: bands.absent / total, ...swatchStyle('absent') }} />
          </div>
          <CoverageKey />
        </div>

        <div className="card">
          <h3>Agents live</h3>
          <div className="metric">
            {data.coverage.agentsLive}<small>/{data.coverage.totalPeople}</small>
          </div>
          <p className="note">
            {data.coverage.agentsLive === data.coverage.totalPeople
              ? 'Every person in this organization has an agent deployed'
              : `${data.coverage.totalPeople - data.coverage.agentsLive} not yet deployed`}
          </p>
        </div>

        <div className="card">
          <h3>Queries logged</h3>
          <div className="metric">{data.queries}</div>
          <p className="note">Each written to the subject&rsquo;s own log, attributed</p>
        </div>

        <div className="card">
          <h3>Refusals</h3>
          <div className="metric">{data.refusals.total}</div>
          <p className="note">
            {data.refusals.wont} won&rsquo;t answer &middot; {data.refusals.cant} can&rsquo;t answer
          </p>
        </div>

        <div className="card accent">
          <h3>Silent gaps</h3>
          <div className="metric">{data.silentGaps}</div>
          <p className="note">Confident answers on incomplete coverage &mdash; drive this to zero</p>
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
