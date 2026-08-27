import { useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { SignUp } from './SignUp';

// Read once at module load — before Shell's own mount effect normalizes the URL (it
// replaceState's the query string away almost immediately, and Login itself doesn't
// mount until the async auth check resolves, well after that happens). A lazy useState
// initializer inside the component would run too late and always see it already gone.
const wantsSignupOnLoad = new URLSearchParams(window.location.search).get('signup') === '1';

export function Login() {
  const { login } = useAuth();
  // A marketing-site "Try it for free" link can land straight on org creation via
  // ?signup=1, instead of forcing an extra manual click past the login form first.
  const [mode, setMode] = useState<'login' | 'signup'>(wantsSignupOnLoad ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not log in');
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'signup') return <SignUp onBack={() => setMode('login')} />;

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px' }}>
      <div className="panel" style={{ width: '100%', maxWidth: 360, marginTop: 0 }}>
        <header><span className="label">Sign in</span></header>
        <div className="inner">
          <p className="sub" style={{ marginTop: 0, marginBottom: 16 }}>
            One login for everyone — real, session-based, whether you're here as an org
            admin, a person someone added to a chart, or both. What you can see and do is
            governed by your actual role, not just whoever loaded the page.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink3)' }}>
                Email
              </span>
              <input
                aria-label="Email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                style={{ height: 34, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 13 }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink3)' }}>
                Password
              </span>
              <input
                aria-label="Password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                style={{ height: 34, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 13 }}
              />
            </label>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={busy || !email.trim() || !password}
              style={{ width: '100%', marginTop: 4 }}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
          {error && (
            <p style={{ fontSize: 12, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '7px 11px', marginTop: 12 }}>
              {error}
            </p>
          )}
          <p className="glossary" style={{ marginTop: 16 }}>
            New here?{' '}
            <button
              onClick={() => setMode('signup')}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}
            >
              Create your organization
            </button>{' '}
            — no existing admin required.
          </p>
          <p className="glossary" style={{ marginTop: 8 }}>
            Dev seed: <code>jordan@agentorgmesh.local</code> / <code>admin-dev-only</code> — see
            the console output of <code>npm run db:seed</code>.
          </p>
        </div>
      </div>
    </div>
  );
}
