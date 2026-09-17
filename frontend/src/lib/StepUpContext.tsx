import { createContext, useContext, useState, type ReactNode } from 'react';
import { ApiError } from './api';
import { useAuth } from './AuthContext';

/**
 * Action-scoped step-up, replacing a full-page gate on the whole Admin panel — found, after
 * researching how GitHub/Stripe/Google Workspace/NIST 800-63B/OWASP actually handle this,
 * to be a real outlier: none of them re-authenticate on entering an admin area, only on the
 * specific sensitive action itself (GitHub's own sudo-mode docs: triggers on adding an SSH
 * key or authorizing an OAuth app, never on viewing settings). server.ts's requireOrgRole
 * now only requires elevation for the calls that actually need it (inviting/removing an
 * admin, changing an admin's role, removing a person, setting the org's main-agent
 * credentials, editing policy) — this is the frontend half: when one of those genuinely
 * returns 428, prompt for a fresh password right there, then retry the same action once,
 * automatically, rather than losing whatever the person was doing.
 */
interface StepUpContextValue {
  /** Wrap any sensitive action (an api.* call). If the server responds 428, shows an
   *  inline re-auth prompt and retries the same call once on success — the caller's own
   *  try/catch/finally around this still works exactly as if step-up had never been
   *  needed. Rejects (same shape as the original failure) if the user cancels. */
  runWithStepUp: <T,>(fn: () => Promise<T>) => Promise<T>;
}

const StepUpContext = createContext<StepUpContextValue | null>(null);

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  retry: () => Promise<unknown>;
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const { account, stepUp } = useAuth();
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runWithStepUp = <T,>(fn: () => Promise<T>): Promise<T> =>
    fn().catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 428) {
        return new Promise<T>((resolve, reject) => {
          setPassword('');
          setError(null);
          setPending({ resolve: resolve as (v: unknown) => void, reject, retry: fn });
        });
      }
      throw e;
    });

  const submit = async () => {
    if (!pending || !password) return;
    setBusy(true);
    setError(null);
    // Two failures worth telling apart, which this used to collapse into one: the password
    // check failing (stay open, say so, let them retype) versus the *retried action* itself
    // failing for its own reasons. The second one is not an auth problem at all, so showing
    // it inside a "Confirm it's you" box next to a password field actively misleads — found
    // live the first time a step-up-gated action had a plausible non-auth failure of its own
    // (resetting a password the server refuses to reset, which reported "Use Change password
    // for your own account" as though the password had been typed wrong). Now that case
    // closes the prompt and rejects, so the caller's own error handling surfaces it in the
    // place the action was taken.
    try {
      await stepUp(password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not verify your password');
      setBusy(false);
      return;
    }
    try {
      pending.resolve(await pending.retry());
    } catch (e) {
      pending.reject(e);
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const cancel = () => {
    pending?.reject(new Error('cancelled'));
    setPending(null);
  };

  return (
    <StepUpContext.Provider value={{ runWithStepUp }}>
      {children}
      {pending && (
        <div className="stepup-overlay" onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}>
          <div className="panel" style={{ width: '100%', maxWidth: 360, marginTop: 0 }}>
            <header><span className="label">Confirm it&rsquo;s you</span></header>
            <div className="inner">
              <p className="sub" style={{ marginTop: 0, marginBottom: 16 }}>
                {account?.name ? <>Signed in as <strong>{account.name}</strong>. </> : null}
                This action needs a fresh password check &mdash; re-enter it to continue.
              </p>
              <div style={{ display: 'grid', gap: 10 }}>
                <label className="field">
                  <span>
                    Password
                  </span>
                  <input
                    aria-label="Password"
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') cancel(); }}
                    className="input"
                  />
                </label>
                <div style={{ display: 'flex', gap: 7 }}>
                  <button
                    className="btn btn-primary"
                    onClick={submit}
                    disabled={busy || !password}
                    style={{ flex: 1 }}
                  >
                    {busy ? 'Verifying…' : 'Confirm'}
                  </button>
                  <button className="chip" disabled={busy} onClick={cancel}>Cancel</button>
                </div>
              </div>
              {error && (
                <p className="auth-error" style={{ marginTop: 12 }}>
                  {error}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </StepUpContext.Provider>
  );
}

export function useStepUp(): StepUpContextValue {
  const ctx = useContext(StepUpContext);
  if (!ctx) throw new Error('useStepUp must be used within a StepUpProvider');
  return ctx;
}
