import { useEffect, useMemo, useState } from 'react';
import { api, type Disposition, type Person } from '../lib/api';
import { useMe } from '../lib/MeContext';
import { deriveAllowedRoles } from '../lib/roles';

// Priority order for picking one representative role to display when someone qualifies
// for more than one simultaneously (e.g. a peer who's also IT). Matches roughly how much
// standing each role typically carries — display-only; a real ask still verifies whatever
// specific role is actually claimed against the org graph, same as everywhere else.
const ROLE_PRIORITY = ['Direct manager', 'Skip-level', 'Executive', 'IT admin', 'Peer'] as const;
const RELATION_LABEL: Record<string, string> = {
  'Direct manager': 'your manager', 'Skip-level': 'your skip-level manager',
  Executive: 'executive', 'IT admin': 'IT', Peer: 'your team',
};

export function OrgStructure() {
  const { meId, meOrgId } = useMe();
  const [people, setPeople] = useState<Person[]>([]);
  const [grid, setGrid] = useState<Record<string, Record<string, Disposition>> | null>(null);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  useEffect(() => {
    api.org(meOrgId).then((d) => setPeople(d.people));
    api.policy(meOrgId).then((d) => setGrid(d.revision.grid));
  }, [meOrgId]);

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

  // The real, authoritative relationship — the same function that gates an actual ask
  // server-side, not a hand-rolled approximation. Walking the whole management chain and
  // calling everyone in it "Direct manager"-level access (the previous approach) was
  // simply wrong for anyone beyond your immediate and skip-level manager: they hold no
  // real role at all unless they're separately Executive or IT.
  const bestRole = (id: number): string | null => {
    const roles = deriveAllowedRoles(id, meId, people);
    return ROLE_PRIORITY.find((r) => roles.includes(r)) ?? null;
  };

  const relation = (id: number) => {
    if (id === meId) return 'you';
    const role = bestRole(id);
    return role ? RELATION_LABEL[role] : 'elsewhere in the org';
  };

  const access = (id: number) => {
    if (id === meId) return 'you see everything';
    if (!grid) return '…';
    const role = bestRole(id);
    if (!role) return 'cannot ask about you';
    return `can ask · Sensitive ${grid[role].Sensitive}`;
  };

  const rows: { person: Person; depth: number; hasKids: boolean }[] = [];
  const walk = (p: Person, depth: number) => {
    const kids = children.get(p.id) ?? [];
    rows.push({ person: p, depth, hasKids: kids.length > 0 });
    if (!collapsed[p.id]) for (const k of kids) walk(k, depth + 1);
  };
  for (const p of people) if (p.managerId == null) walk(p, 0);

  return (
    <>
      <div className="crumb">My agent &middot; org structure</div>
      <h1>Org structure</h1>
      <p className="sub">
        Who is where, and who is allowed to ask about you &mdash; taken from the rules as they
        stand right now. You see the shape of the organization, not what anyone else&rsquo;s tools
        say about them or who has asked about them; that one-sidedness is deliberate.
      </p>

      <div className="panel">
        <header>
          <button className="chip" onClick={() => setCollapsed(Object.fromEntries(people.filter((p) => (children.get(p.id) ?? []).length).map((p) => [p.id, true])))}>
            Collapse all
          </button>
          <button className="chip" onClick={() => setCollapsed({})}>Expand all</button>
        </header>

        <div>
          {rows.map(({ person: p, depth, hasKids }) => (
            <div key={p.id} className="tree-row" style={p.id === meId ? { background: '#f8f9fa' } : undefined}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, paddingLeft: depth * 18, minWidth: 0 }}>
                {hasKids ? (
                  <button className="tree-toggle" onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}>
                    {collapsed[p.id] ? '+' : '−'}
                  </button>
                ) : (
                  <span className="tree-toggle leaf">&middot;</span>
                )}
                <span style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</span>
                <span style={{ fontSize: 11, color: 'var(--ink3)' }}>{p.title}</span>
                <span style={{
                  fontFamily: 'var(--mono)', fontSize: 10, padding: '1px 5px', borderRadius: 2,
                  border: p.id === meId ? 'none' : '1px solid var(--rule2)',
                  background: p.id === meId ? 'var(--ink)' : '#fff',
                  color: p.id === meId ? '#fff' : 'var(--ink2)',
                }}>
                  {relation(p.id)}
                </span>
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: access(p.id).startsWith('cannot') ? 'var(--ink4)' : 'var(--ink2)' }}>
                {access(p.id)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
