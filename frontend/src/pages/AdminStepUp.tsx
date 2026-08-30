import { useState } from 'react';
import { useAuth } from '../lib/AuthContext';

/** The second factor of "log in as admin" — step-up/re-authentication (the same pattern
 *  GitHub calls "sudo mode": re-enter your password before anything privileged unlocks,
 *  even though you're already logged in). Shown only once an account is already logged in
 *  but hasn't proven itself again recently enough for Admin-scoped access; a fresh login
 *  never skips this, and neither does hiding this screen — every Admin endpoint re-checks
 *  the session's own elevation server-side (requireOrgRole in server.ts), so this form is
 *  a real gate, not cosmetic. */
export function AdminStepUp() {
  const { account, stepUp, logout } = useAuth();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await stepUp(password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not verify your password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px' }}>
      <div className="panel" style={{ width: '100%', maxWidth: 360, marginTop: 0 }}>
        <header><span className="label">Log in as admin</span></header>
        <div className="inner">
          <p className="sub" style={{ marginTop: 0, marginBottom: 16 }}>
            You&rsquo;re signed in as <strong>{account?.name}</strong>, but the Admin panel
            needs its own re-authentication first &mdash; re-enter your password to unlock
            organization setup and admin screens for the next 15 minutes.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink3)' }}>
                Password
              </span>
              <input
                aria-label="Password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                style={{ height: 34, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 13 }}
              />
            </label>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={busy || !password}
              style={{ width: '100%', marginTop: 4 }}
            >
              {busy ? 'Verifying…' : 'Continue to admin'}
            </button>
          </div>
          {error && (
            <p style={{ fontSize: 12, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '7px 11px', marginTop: 12 }}>
              {error}
            </p>
          )}
          <p className="glossary" style={{ marginTop: 16 }}>
            Not you?{' '}
            <button
              onClick={() => void logout()}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}
            >
              Log out
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
