import { useEffect, useMemo, useState } from 'react';
import { api, type Escalation, type Person, type Surface } from '../lib/api';
import { useOrg } from '../lib/OrgContext';
import { describeEscalationStatus } from '../lib/escalationStatus';
import { CoverageBar, CoverageKey } from '../components/primitives';

export function OrgGraph() {
  const { orgId } = useOrg();
  const [people, setPeople] = useState<Person[]>([]);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [escalations, setEscalations] = useState<Escalation[]>([]);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    setSelected(null);
    api.org(orgId).then((d) => { setPeople(d.people); setSurfaces(d.surfaces); });
    api.escalations(orgId).then((d) => setEscalations(d.escalations));
  }, [orgId]);

  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const children = useMemo(() => {
    const m = new Map<number, Person[]>();
    for (const p of people) {
      if (p.managerId == null) continue;
      const arr = m.get(p.managerId) ?? [];
      arr.push(p);
      m.set(p.managerId, arr);
    }
    return m;
  }, [people]);
  const escByPerson = useMemo(() => {
    const m = new Map<number, number>();
    // Only open ones flag the org chart — an acknowledged or resolved item has a human
    // already on it, so it shouldn't keep reading as unattended.
    for (const e of escalations) if (e.status === 'open') m.set(e.personId, (m.get(e.personId) ?? 0) + 1);
    return m;
  }, [escalations]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out: { person: Person; depth: number; hasKids: boolean }[] = [];
    if (needle) {
      for (const p of people) {
        if (`${p.name} ${p.title} ${p.team}`.toLowerCase().includes(needle)) {
          out.push({ person: p, depth: 0, hasKids: false });
        }
      }
      return out;
    }
    const walk = (p: Person, depth: number) => {
      const kids = children.get(p.id) ?? [];
      out.push({ person: p, depth, hasKids: kids.length > 0 });
      if (!collapsed[p.id]) for (const k of kids) walk(k, depth + 1);
    };
    for (const p of people) if (p.managerId == null) walk(p, 0);
    return out;
  }, [people, children, collapsed, q]);

  const sel = selected != null ? byId.get(selected) : null;

  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Org graph</h1>
      <p className="sub">
        Reporting structure with connector state per person. Nodes carry coverage and open
        escalation count only &mdash; no assessment of anyone&rsquo;s work.
      </p>

      <div className="panel">
        <header>
          <input
            aria-label="Search name, title, team"
            placeholder="Search name, title, team&hellip;"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="input" style={{ minWidth: 220 }}
          />
          <button className="chip" onClick={() => setCollapsed(Object.fromEntries(people.filter((p) => (children.get(p.id) ?? []).length).map((p) => [p.id, true])))}>
            Collapse all
          </button>
          <button className="chip" onClick={() => setCollapsed({})}>Expand all</button>
          <span className="spacer" />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink3)' }}>
            {rows.length} of {people.length} shown
          </span>
        </header>

        <div className="stagger">
          {rows.map(({ person: p, depth, hasKids }) => (
            <div key={p.id} className={`tree-row${p.agentDeployed ? '' : ' no-agent'}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingLeft: depth * 18, minWidth: 0 }}>
                {hasKids ? (
                  <button
                    className="tree-toggle"
                    onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}
                  >
                    {collapsed[p.id] ? '+' : '−'}
                  </button>
                ) : (
                  <span className="tree-toggle leaf">&middot;</span>
                )}
                <button className="tree-name" onClick={() => setSelected(selected === p.id ? null : p.id)}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--ink3)' }}>{p.title}</span>
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {(escByPerson.get(p.id) ?? 0) > 0 && (
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 10, border: '1px solid #d9bd7a', background: '#fdf6e7', color: '#6f5010', padding: '1px 5px', borderRadius: 2 }}>
                    {escByPerson.get(p.id)} open
                  </span>
                )}
                <div style={{ width: 72 }}>
                  <CoverageBar states={surfaces.map((s) => p.surfaces[s.key])} height={6} />
                </div>
                <span className="pct" style={{
                  color: p.coverage.percent === null ? 'var(--ink3)'
                    : p.coverage.percent >= 80 ? 'var(--ok)'
                    : p.coverage.percent >= 60 ? 'var(--partial)' : '#8a3630',
                  width: 62, textAlign: 'right', display: 'inline-block',
                }}>
                  {p.coverage.percent === null ? 'no agent' : `${p.coverage.percent}%`}
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="inner" style={{ borderTop: '1px solid var(--rule)', background: '#f8f9fa' }}>
          <CoverageKey />
        </div>
      </div>

      {sel && (
        <div className="panel">
          <header>
            <span className="label">{sel.name} &middot; {sel.title}</span>
            <span style={{ fontSize: 12, color: 'var(--ink3)' }}>{sel.team}</span>
          </header>
          <div className="inner">
            {sel.agentDeployed ? (
              <>
                <CoverageBar states={surfaces.map((s) => sel.surfaces[s.key])} height={8} />
                <CoverageKey />
                <div className="coverage-note">
                  {sel.coverage.gaps.length
                    ? `Gaps: ${sel.coverage.gaps.join(' · ')}. Any answer touching these areas carries a coverage caveat.`
                    : 'All in-scope surfaces are live and inside the freshness window.'}
                </div>
              </>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: 'var(--ink2)' }}>
                No agent is deployed for this person. They are excluded from every answer, and
                nothing is inferred about them from other people&rsquo;s data.
              </p>
            )}
            {escalations.filter((e) => e.personId === sel.id).map((e) => (
              <div key={e.id} className={`item t-${e.kind}`} style={{ marginTop: 10 }}>
                <div className="row"><p style={{ fontWeight: 600 }}>{e.title}</p></div>
                <p>{e.detail}</p>
                <p className="esc-path" style={{ marginTop: 6 }}>
                  {e.path.map((p) => p.name).join(' → ')} &middot; {describeEscalationStatus(e, byId)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
