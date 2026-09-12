import { useState } from 'react';
import { useAuth } from '../lib/AuthContext';

/** Self-serve account creation — just name/email/password, no company name to type.
 *  `POST /api/auth/signup` (server.ts) creates the account *and* a one-person "workspace"
 *  org for it atomically in the same step (repo.ts's `createOrganization`, the org name
 *  auto-derived as "<name>'s workspace") — who you are and what org you administer are
 *  still two decoupled facts (an account can in principle exist with zero orgs, e.g. one
 *  only ever linked into someone else's chart by email), but signup itself always
 *  produces both, since most people trying this out are one person, not a company
 *  standing up a multi-person chart. See MeContext's "zero orgs" empty state on "My agent"
 *  for the now-rare case a real account ends up with none. */
export function SignUp({ onBack, initialEmail = '' }: { onBack: () => void; initialEmail?: string }) {
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !email.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await signUp(name.trim(), email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not create your account');
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, value: string, onChange: (v: string) => void, type = 'text', autoComplete?: string) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink3)' }}>
        {label}
      </span>
      <input
        aria-label={label}
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        style={{ height: 34, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 13 }}
      />
    </label>
  );

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px' }}>
      <div className="panel" style={{ width: '100%', maxWidth: 380, marginTop: 0 }}>
        <header><span className="label">Create your account</span></header>
        <div className="inner">
          <p className="sub" style={{ marginTop: 0, marginBottom: 16 }}>
            No company name needed — you'll land in your own real, one-person workspace
            immediately, ready to use.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {field('Your name', name, setName, 'text', 'name')}
            {field('Email', email, setEmail, 'email', 'username')}
            {field('Password', password, setPassword, 'password', 'new-password')}
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={busy || !name.trim() || !email.trim() || !password}
              style={{ width: '100%', marginTop: 4 }}
            >
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </div>
          <p className="glossary" style={{ marginTop: 12 }}>
            By creating an account you agree to the{' '}
            <a href="/legal/terms" target="_blank" rel="noopener noreferrer">Terms of service</a> and acknowledge the{' '}
            <a href="/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a>.
          </p>
          {error && (
            <p style={{ fontSize: 12, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '7px 11px', marginTop: 12 }}>
              {error}
            </p>
          )}
          <p className="glossary" style={{ marginTop: 16 }}>
            Already have an account?{' '}
            <button
              onClick={onBack}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}
            >
              Log in instead
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
