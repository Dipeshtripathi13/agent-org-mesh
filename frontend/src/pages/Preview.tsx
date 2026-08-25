import { useEffect, useState } from 'react';
import { api, type AgentResponse } from '../lib/api';
import { ClaimItem, RefusalGlossary } from '../components/primitives';
import { useMe } from '../lib/MeContext';

const PREVIEW_ROLES = ['Direct manager', 'Skip-level', 'Peer', 'Executive'];

export function Preview() {
  const { meId } = useMe();
  const [role, setRole] = useState('Direct manager');
  const [answer, setAnswer] = useState<AgentResponse | null>(null);

  // requesterId explicitly set to meId — this is a self-preview ("what would X role see
  // about me"), and the backend's preview gate (server.ts's POST /api/query) requires
  // requesterId === targetId to recognize it as one, rather than an api.query() default.
  useEffect(() => { api.query(meId, role, false, '', meId).then((r) => setAnswer(r.response)); }, [meId, role]);

  return (
    <>
      <div className="crumb">My agent &middot; preview</div>
      <h1>Preview</h1>
      <p className="sub">
        See the answer each requester would get right now, under the policy as it stands. No
        surprises &mdash; this is a simulation and is never written to your log.
      </p>

      <div className="panel">
        <header>
          <span className="label">If they asked right now, they&rsquo;d get</span>
        </header>
        <div className="inner">
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 12 }}>
            {PREVIEW_ROLES.map((r) => (
              <button key={r} className="chip" aria-pressed={role === r} onClick={() => setRole(r)}>
                {r}
              </button>
            ))}
          </div>
          {answer && (
            <>
              {answer.items.map((item, i) => <ClaimItem key={i} item={item} />)}
              <div className="coverage-note">{answer.coverage.text}</div>
              <RefusalGlossary />
            </>
          )}
        </div>
      </div>
    </>
  );
}
