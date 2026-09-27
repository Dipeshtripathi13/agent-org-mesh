import { useCallback, useEffect, useState } from 'react';
import { api, type AgentResponse, type Disposition, type Person } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useOrg } from '../lib/OrgContext';
import { LoadingState } from '../components/EmptyState';
import { useStepUp } from '../lib/StepUpContext';
import { ClaimItem, RefusalGlossary } from '../components/primitives';

const ROLES = ['Self', 'Peer', 'Direct manager', 'Skip-level', 'Executive', 'IT admin'];
const CLASSES = ['Open', 'Internal', 'Sensitive'];
const LABEL: Record<Disposition, string> = {
  allow: 'Allow', redact: 'Redact', refuse: '\u25EB Refuse visibly',
};

export function PolicyMatrix() {
  const { orgId } = useOrg();
  const { orgRoles } = useAuth();
  // Server enforces the real boundary on every /api/policy/cycle request regardless —
  // this just grays out what it would reject anyway, same convenience/boundary split
  // roles.ts already documents for Ask's role chips.
  const canEdit = orgRoles[orgId] === 'owner' || orgRoles[orgId] === 'admin';
  const { runWithStepUp } = useStepUp();
  const [grid, setGrid] = useState<Record<string, Record<string, Disposition>> | null>(null);
  const [revision, setRevision] = useState(0);
  const [role, setRole] = useState('Direct manager');
  const [target, setTarget] = useState<number | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [answer, setAnswer] = useState<AgentResponse | null>(null);

  useEffect(() => {
    setTarget(null);
    api.org(orgId).then((d) => {
      setPeople(d.people);
      setTarget((d.people.find((p) => p.agentDeployed) ?? d.people[0])?.id ?? null);
    });
  }, [orgId]);

  const loadPolicy = useCallback(async () => {
    const p = await api.policy(orgId);
    setGrid(p.revision.grid);
    setRevision(p.revision.id);
  }, [orgId]);

  useEffect(() => { void loadPolicy(); }, [loadPolicy]);

  // Re-runs whenever the grid, role, or target changes — the test panel is live.
  useEffect(() => {
    if (!grid || target == null) { setAnswer(null); return; }
    api.query(target, role).then((r) => setAnswer(r.response));
  }, [grid, role, target, revision]);

  const cycle = async (r: string, c: string) => {
    await runWithStepUp(() => api.cyclePolicy(orgId, r, c));
    await loadPolicy();
  };

  if (!grid) return <LoadingState />;

  return (
    <>
      <div className="crumb">Admin &middot; governance</div>
      <h1>Policy matrix</h1>
      <p className="sub">
        Who may learn what about whom. Pay, performance, health and legal matters are never read
        by any agent at all, so they aren&rsquo;t a permission you could grant here. Editing starts
        revision {revision + 1}; answers already given keep the rules they were given under.
      </p>

      <div className="grid2" style={{ marginTop: 18 }}>
        <div className="panel" style={{ marginTop: 0 }}>
          <header>
            <span className="label">Who&rsquo;s asking &times; kind of information</span>
            <span style={{ fontSize: 12, color: 'var(--ink3)' }}>
              Click a cell to cycle: allow &rarr; redact &rarr; refuse
            </span>
          </header>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Role</th>
                  {CLASSES.map((c) => <th key={c}>{c}</th>)}
                  <th style={{ background: 'var(--hold-bg)' }}>Excluded &#9707;</th>
                </tr>
              </thead>
              <tbody>
                {ROLES.map((r) => (
                  <tr key={r}>
                    <td style={{ whiteSpace: 'nowrap' }}>{r}</td>
                    {CLASSES.map((c) => (
                      <td key={c}>
                        <button
                          className={`disp d-${grid[r][c]}`}
                          onClick={() => cycle(r, c)}
                          disabled={!canEdit}
                          title={canEdit ? undefined : 'Viewers can see the policy grid but not edit it'}
                          style={canEdit ? undefined : { opacity: 0.5, cursor: 'not-allowed' }}
                        >
                          {LABEL[grid[r][c]]}
                        </button>
                      </td>
                    ))}
                    <td style={{ background: 'var(--hold-bg)' }}>
                      <span className="locked">&#9707; locked</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="inner" style={{ borderTop: '1px solid var(--rule)', background: '#f8f9fa' }}>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--ink2)' }}>
              <strong>Excluded is not a permission.</strong> Compensation, terminations, legal
              matters and health data are never ingested, so this column has no editable state.
              There is nothing to allow.
            </p>
          </div>
        </div>

        <div className="panel accent" style={{ marginTop: 0, borderColor: 'var(--ink)' }}>
          <header style={{ background: '#f1f3f4' }}>
            <div>
              <div className="label">Test this policy</div>
              <div style={{ fontSize: 12, color: 'var(--ink3)', marginTop: 3 }}>
                Generated from the grid as it stands, against the target&rsquo;s real coverage.
              </div>
            </div>
          </header>
          <div className="inner">
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
              {ROLES.filter((r) => r !== 'Self').map((r) => (
                <button key={r} className="chip" aria-pressed={role === r} onClick={() => setRole(r)}>
                  {r}
                </button>
              ))}
            </div>
            {people.length === 0 ? (
              <p style={{ fontSize: 12, color: 'var(--ink3)', marginBottom: 12 }}>
                No one in this organization yet — add people from the Organizations tab.
              </p>
            ) : (
              <select
                aria-label="Target agent"
                value={target ?? ''}
                onChange={(e) => setTarget(Number(e.target.value))}
                className="input" style={{ width: '100%', marginBottom: 12 }}
              >
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} &middot; {p.coverage.percent === null ? 'no agent' : `${p.coverage.percent}% coverage`}
                  </option>
                ))}
              </select>
            )}

            {answer && (
              <>
                {answer.items.map((item, i) => <ClaimItem key={i} item={item} />)}
                <div className="coverage-note">{answer.coverage.text}</div>
                <RefusalGlossary />
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
