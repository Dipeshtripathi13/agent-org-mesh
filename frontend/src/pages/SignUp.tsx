import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/AuthContext';
import { ApiError } from '../lib/api';

/** Self-serve account creation — name, email, password. `POST /api/auth/signup` creates the
 *  account and a one-person workspace in the same step (repo.ts's `createOrganization`). */
export function SignUp({ initialEmail = '', onLogin, onForgot }: {
  initialEmail?: string;
  onLogin: (email: string) => void;
  onForgot: (email: string) => void;
}) {
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || password.length < 8 || busy) return;
    setBusy(true);
    setError(null);
    setExists(false);
    try {
      await signUp(name.trim(), email.trim(), password);
    } catch (err) {
      const taken = (err instanceof ApiError && err.status === 409) || (err instanceof Error && /already exists/i.test(err.message));
      setExists(taken);
      setError(taken ? null : err instanceof Error ? err.message : 'could not create your account');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="auth-title">Create your account</h1>
      <p className="auth-sub">Free during the beta.</p>

      <form className="auth-form" onSubmit={submit} noValidate>
        <label className="auth-field" htmlFor="signup-name">
          <span>Your name</span>
          <input id="signup-name" className="auth-input" type="text" autoComplete="name" value={name}
            onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="auth-field" htmlFor="signup-email">
          <span>Work email</span>
          <input id="signup-email" className="auth-input" type="email" autoComplete="username" inputMode="email" value={email}
            onChange={(e) => { setEmail(e.target.value); setExists(false); }} />
        </label>
        <label className="auth-field" htmlFor="signup-password">
          <span>Password</span>
          <input id="signup-password" className="auth-input" type="password" autoComplete="new-password" value={password}
            onChange={(e) => setPassword(e.target.value)} aria-describedby="signup-password-hint" />
        </label>
        <p id="signup-password-hint" className="auth-hint">At least 8 characters.</p>

        {exists && (
          <div className="auth-error" role="alert">
            An account already exists for <strong>{email.trim()}</strong>.
            <div className="auth-error-actions">
              <button type="button" className="linkbtn" onClick={() => onLogin(email.trim())}>Sign in instead</button>
              <button type="button" className="linkbtn" onClick={() => onForgot(email.trim())}>Reset your password</button>
            </div>
          </div>
        )}
        {error && <p className="auth-error" role="alert">{error}</p>}

        <button type="submit" className="btn btn-primary auth-submit"
          disabled={busy || !name.trim() || !email.trim() || password.length < 8}>
          {busy ? 'Creating your account…' : 'Create account'}
        </button>
      </form>

      <p className="auth-fine">
        By creating an account you agree to the{' '}
        <a href="/legal/terms" target="_blank" rel="noopener noreferrer">Terms of service</a> and acknowledge the{' '}
        <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a>.
      </p>
      <p className="auth-alt">
        Already have an account? <button type="button" className="linkbtn" onClick={() => onLogin(email.trim())}>Sign in</button>
      </p>
    </>
  );
}
