import { useEffect, useState } from 'react';
import { api, type AgentResponse } from '../lib/api';
import { ClaimItem, RefusalGlossary } from '../components/primitives';
import { useMe } from '../lib/MeContext';

const PREVIEW_ROLES = ['Direct manager', 'Skip-level', 'Peer', 'Executive'];

export function Preview() {
  const { meId } = useMe();
  const [role, setRole] = useState('Direct manager');
  const [answer, setAnswer] = useState<AgentResponse | null>(null);

  // A self-preview ("what would X role see about me") — the server recognizes it because
  // your session's own identity is the target.
  useEffect(() => { api.query(meId, role).then((r) => setAnswer(r.response)).catch(() => setAnswer(null)); }, [meId, role]);

  return (
    <>
      <div className="crumb">My agent &middot; preview</div>
      <h1>Preview</h1>
      <p className="sub">
        See what someone in each of these positions would be told about you right now, under the
        rules as they stand. This is a simulation: nothing here is recorded, and nobody is told.
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
