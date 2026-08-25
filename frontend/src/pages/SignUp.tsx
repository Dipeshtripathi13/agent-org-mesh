import { useState } from 'react';
import { useAuth } from '../lib/AuthContext';

/** Self-serve org creation — no existing admin required. One atomic step server-side
 *  (backend/src/db/repo.ts's signUpWithNewOrganization): creates the account, a brand
 *  new organization, and this account's first person-identity (top of that org's chart)
 *  all at once, then logs in immediately. */
export function SignUp({ onBack }: { onBack: () => void }) {
  const { signUp } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim() || !email.trim() || !password || !organizationName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await signUp(name.trim(), email.trim(), password, organizationName.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not create your organization');
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
        <header><span className="label">Create your organization</span></header>
        <div className="inner">
          <p className="sub" style={{ marginTop: 0, marginBottom: 16 }}>
            No existing admin needed — this creates a brand-new organization with you as
            its owner and its first person, in one step.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {field('Your name', name, setName, 'text', 'name')}
            {field('Email', email, setEmail, 'email', 'username')}
            {field('Password', password, setPassword, 'password', 'new-password')}
            {field('Organization name', organizationName, setOrganizationName)}
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={busy || !name.trim() || !email.trim() || !password || !organizationName.trim()}
              style={{ width: '100%', marginTop: 4 }}
            >
              {busy ? 'Creating…' : 'Create organization'}
            </button>
          </div>
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
