import { useEffect, useState } from 'react';
import { api, type ConnectorStats } from '../lib/api';
import { useOrg } from '../lib/OrgContext';

const PILL_LABEL = { live: 'Live', degraded: 'Degraded', stale: 'Stale' } as const;

function StatePill({ status }: { status: ConnectorStats['status'] }) {
  return (
    <span className={`pill pill-${status}`}>
      <i />{PILL_LABEL[status]}
    </span>
  );
}

export function Connections() {
  const { orgId } = useOrg();
  const [connectors, setConnectors] = useState<ConnectorStats[]>([]);
  const [neverIngested, setNeverIngested] = useState<string[]>([]);

  useEffect(() => {
    api.connections(orgId).then((d) => { setConnectors(d.connectors); setNeverIngested(d.neverIngested); });
  }, [orgId]);

  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Connections</h1>
      <p className="sub">
        Every tool this organization can read from, how strong its answers are, and where it is
        failing. Every count comes from the real chart, not an example.
      </p>

      <div className="panel">
        {connectors.map((c) => {
          const total = c.counts.connected + c.counts.partial + c.counts.stale + c.counts.absent || 1;
          return (
            <div key={c.key} style={{ padding: '14px 16px', borderBottom: '1px solid var(--rule)' }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</span>
                  <StatePill status={c.status} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink4)' }}>feeds {c.feedsTier}</span>
                </div>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
                  {c.connectedCount} of {c.inScopeCount} in-scope people connected
                </span>
              </div>
              <div className="bar" style={{ marginTop: 8 }}>
                <div style={{ flex: c.counts.connected / total, background: 'var(--ok)' }} />
                <div style={{ flex: c.counts.partial / total, background: 'var(--partial)' }} />
                <div style={{ flex: c.counts.stale / total, background: 'var(--stale)' }} />
                <div style={{ flex: c.counts.absent / total, background: 'var(--hatch)' }} />
              </div>
              <p style={{ fontSize: 12, color: 'var(--ink2)', marginTop: 8, maxWidth: '72ch' }}>
                <strong>Reads:</strong> {c.reads}. <strong>Does not read:</strong> {c.doesNotRead}.
              </p>
            </div>
          );
        })}
      </div>

      <div className="panel" style={{ borderColor: 'var(--rule2)' }}>
        <header style={{ background: 'var(--hold-bg)' }}>
          <span className="label" style={{ color: 'var(--hold)' }}>
            &#8856; Can&rsquo;t answer &mdash; systems that never enter an agent&rsquo;s context
          </span>
        </header>
        <div className="inner">
          <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--ink2)', maxWidth: '84ch' }}>
            These aren&rsquo;t things the rules hide at answer time. Nothing here is ever read in the
            first place: no agent holds this data, so no rule change could reveal it and no
            question could leak it.
          </p>
          {neverIngested.map((n) => (
            <div key={n} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', borderTop: '1px solid #f1f3f4', alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>{n}</span>
              <span className="locked">&#8856; never collected</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
