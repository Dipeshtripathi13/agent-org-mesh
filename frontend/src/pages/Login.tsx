import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/AuthContext';
import { AuthLayout } from '../components/AuthScene';
import { SignUp } from './SignUp';
import { ForgotPassword } from './EmailLinks';

// Read once at module load — before Shell's own mount effect normalizes the URL (it
// replaceState's the query string away almost immediately, and Login itself doesn't
// mount until the async auth check resolves, well after that happens). A lazy useState
// initializer inside the component would run too late and always see it already gone.
const wantsSignupOnLoad = new URLSearchParams(window.location.search).get('signup') === '1';

type Mode = 'login' | 'signup' | 'forgot';

/** Sign in, create an account, or reset a password — one layout, the form swaps, the scene
 *  keeps playing. `embedded` renders just the form (the invitation page has its own frame). */
export function Login({ initialEmail = '', embedded = false }: { initialEmail?: string; embedded?: boolean } = {}) {
  // A marketing-site "Try it for free" link can land straight on signup via ?signup=1.
  const [mode, setMode] = useState<Mode>(wantsSignupOnLoad ? 'signup' : 'login');
  const [email, setEmail] = useState(initialEmail);

  const go = (next: Mode, withEmail?: string) => {
    if (withEmail != null) setEmail(withEmail);
    setMode(next);
  };

  const form = mode === 'signup'
    ? <SignUp initialEmail={email} onLogin={(e) => go('login', e)} onForgot={(e) => go('forgot', e)} />
    : mode === 'forgot'
      ? <ForgotPassword initialEmail={email} onBack={() => go('login')} />
      : <SignInForm email={email} setEmail={setEmail} onSignup={() => go('signup')} onForgot={() => go('forgot')} />;

  const card = <div key={mode} className="auth-card">{form}</div>;
  return embedded ? <div className="auth-embedded">{card}</div> : <AuthLayout>{card}</AuthLayout>;
}

function SignInForm({ email, setEmail, onSignup, onForgot }: {
  email: string; setEmail: (v: string) => void; onSignup: () => void; onForgot: () => void;
}) {
  const { login } = useAuth();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="auth-title">Welcome back</h1>
      <p className="auth-sub">Sign in to ask your team’s agents for an update.</p>

      <form className="auth-form" onSubmit={submit} noValidate>
        <label className="auth-field" htmlFor="login-email">
          <span>Email</span>
          <input id="login-email" className="auth-input" type="email" autoComplete="username" inputMode="email"
            value={email} onChange={(e) => setEmail(e.target.value)} autoFocus={!email} />
        </label>
        <label className="auth-field" htmlFor="login-password">
          <span className="auth-field-row">
            Password
            <button type="button" className="linkbtn auth-field-link" onClick={onForgot}>Forgot password?</button>
          </span>
          <input id="login-password" className="auth-input" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!email} />
        </label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy || !email.trim() || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="auth-alt">
        New here? <button type="button" className="linkbtn" onClick={onSignup}>Create an account</button>
      </p>
      <p className="auth-fine">
        <a href="/legal/privacy">Privacy</a> · <a href="/legal/terms">Terms</a> · <a href="/legal/subprocessors">Subprocessors</a>
      </p>
      {import.meta.env.DEV && (
        <p className="auth-fine">
          Local dev only: <code>jordan@</code>, <code>marta@</code>, <code>hana@</code> or <code>diego@agentorgmesh.local</code> /{' '}
          <code>admin-dev-only</code> after <code>npm run db:seed</code>. Never shown in a production build.
        </p>
      )}
    </>
  );
}
