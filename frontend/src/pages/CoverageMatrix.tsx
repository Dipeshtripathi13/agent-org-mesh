import { useEffect, useMemo, useState } from 'react';
import { api, type Person, type Surface } from '../lib/api';
import { useOrg } from '../lib/OrgContext';
import { CoverageKey, swatchStyle } from '../components/primitives';

type Filter = 'all' | 'gaps' | 'low';
type Sort = 'coverage' | 'name';

export function CoverageMatrix() {
  const { orgId } = useOrg();
  const [people, setPeople] = useState<Person[]>([]);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('coverage');
  const [q, setQ] = useState('');

  useEffect(() => {
    api.org(orgId).then((d) => { setPeople(d.people); setSurfaces(d.surfaces); });
  }, [orgId]);

  const rows = useMemo(() => {
    let out = people;
    if (q.trim()) {
      const needle = q.toLowerCase();
      out = out.filter((p) => `${p.name} ${p.title} ${p.team}`.toLowerCase().includes(needle));
    }
    if (filter === 'gaps') out = out.filter((p) => p.coverage.gaps.length > 0);
    if (filter === 'low') out = out.filter((p) => p.coverage.percent !== null && p.coverage.percent < 60);
    return [...out].sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : (a.coverage.percent ?? -1) - (b.coverage.percent ?? -1),
    );
  }, [people, filter, sort, q]);

  const gapTotal = people.reduce((n, p) => n + p.coverage.gaps.length, 0);

  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Coverage matrix</h1>
      <p className="sub">
        People &times; surfaces. This is what makes an answer authoritative, so gaps are shown
        rather than averaged away.
      </p>

      <div className="panel">
        <header>
          <span className="search-field">
            <span className="glass" aria-hidden="true">&#9906;</span>
            <input
              aria-label="Filter people"
              placeholder="Filter people&hellip;"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </span>
          {(['all', 'gaps', 'low'] as Filter[]).map((f) => (
            <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? `All ${people.length}` : f === 'gaps' ? 'Gaps only' : 'Below 60%'}
            </button>
          ))}
          <span className="spacer" />
          {(['coverage', 'name'] as Sort[]).map((s) => (
            <button key={s} className="chip" aria-pressed={sort === s} onClick={() => setSort(s)}>
              sort: {s}
            </button>
          ))}
        </header>

        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                {surfaces.map((s) => (
                  <th key={s.key}>{s.name}<div style={{ color: 'var(--ink4)' }}>{s.feedsTier}</div></th>
                ))}
                <th style={{ textAlign: 'right' }}>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div style={{ fontWeight: 500 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--ink3)' }}>{p.title}</div>
                  </td>
                  {surfaces.map((s) => (
                    <td key={s.key}>
                      <div
                        className="cell"
                        title={`${s.name} — ${p.surfaces[s.key]}`}
                        style={swatchStyle(p.surfaces[s.key])}
                      />
                    </td>
                  ))}
                  <td style={{ textAlign: 'right' }}>
                    <span className="pct" style={{
                      color: p.coverage.percent === null ? 'var(--ink3)'
                        : p.coverage.percent >= 80 ? 'var(--ok)'
                        : p.coverage.percent >= 60 ? 'var(--partial)' : '#8a3630',
                    }}>
                      {p.coverage.percent === null ? 'no agent' : `${p.coverage.percent}%`}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="inner" style={{ borderTop: '1px solid var(--rule)', background: '#f8f9fa' }}>
          <CoverageKey />
          <p className="glossary" style={{ marginTop: 10 }}>
            {rows.length} shown &middot; {gapTotal} connector gaps org-wide. Rows sort by connector
            state only &mdash; never by anything about the person.
          </p>
        </div>
      </div>
    </>
  );
}
