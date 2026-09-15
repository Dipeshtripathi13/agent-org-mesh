import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

/** Email verification and password reset — the pages their emailed links open, the "forgot
 *  password" form, and the screen a new signup sees until it verifies. */

export type EmailLink = { kind: 'verify' | 'reset'; token: string };

export function emailLinkFromPath(pathname: string): EmailLink | null {
  const match = pathname.match(/^\/(verify-email|reset-password)\/(ao[vr]_[A-Za-z0-9_-]{43})\/?$/);
  if (!match) return null;
  const kind = match[1] === 'verify-email' ? 'verify' : 'reset';
  if ((kind === 'verify') !== match[2].startsWith('aov_')) return null;
  return { kind, token: match[2] };
}

const labelText = { fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink3)' } as const;
const inputStyle = { height: 34, border: '1px solid var(--rule2)', borderRadius: 2, padding: '0 9px', fontSize: 13 } as const;
const errorNote = { fontSize: 12, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '7px 11px', marginTop: 12 } as const;
const linkButton = { background: 'none', border: 'none', padding: 0, font: 'inherit', color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' } as const;

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ width: '100%', boxSizing: 'border-box', paddingInline: 20, display: 'flex', justifyContent: 'center' }}>
      <div className="panel" style={{ width: '100%', maxWidth: 380, marginTop: 40 }}>
        <header><span className="label">{label}</span></header>
        <div className="inner">{children}</div>
      </div>
    </div>
  );
}

function StandalonePage({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" style={{ color: 'var(--ink)', textDecoration: 'none' }}>Agent Org Mesh</a>
        <span className="spacer" />
      </header>
      <div className="body" style={{ flexDirection: 'column', alignItems: 'center' }}>{children}</div>
    </div>
  );
}

export function EmailLinkPage({ link }: { link: EmailLink }) {
  return <StandalonePage>{link.kind === 'verify' ? <VerifyEmail token={link.token} /> : <ResetPassword token={link.token} />}</StandalonePage>;
}

function VerifyEmail({ token }: { token: string }) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState('');
  // StrictMode runs effects twice in development; a second call would find the link spent.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.verifyEmail(token)
      .then(() => setState('done'))
      .catch((e: Error) => { setError(e.message); setState('failed'); });
  }, [token]);

  if (state === 'working') return <Card label="Verify email"><p className="sub" style={{ margin: 0 }}>Verifying&hellip;</p></Card>;
  if (state === 'done') {
    return (
      <Card label="Email verified">
        <p className="sub" style={{ marginTop: 0 }}>Your email address is confirmed.</p>
        <a className="btn btn-primary" href="/" style={{ display: 'flex', width: '100%', marginTop: 8, textDecoration: 'none', justifyContent: 'center' }}>Continue to Agent Org Mesh</a>
      </Card>
    );
  }
  return (
    <Card label="Verify email">
      <p className="sub" style={{ marginTop: 0 }}>We couldn&rsquo;t verify your email: {error}.</p>
      <p className="glossary">Sign in and choose &ldquo;Send a new link&rdquo; to get a fresh one.</p>
      <p className="glossary"><a href="/">Go to Agent Org Mesh</a></p>
    </Card>
  );
}

function ResetPassword({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && password !== confirm;
  const submit = async () => {
    if (password.length < 8 || password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      await api.confirmPasswordReset(token, password);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not reset your password');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Card label="Password changed">
        <p className="sub" style={{ marginTop: 0 }}>Your new password is set, and you&rsquo;ve been signed out everywhere.</p>
        <a className="btn btn-primary" href="/" style={{ display: 'flex', width: '100%', marginTop: 8, textDecoration: 'none', justifyContent: 'center' }}>Sign in</a>
      </Card>
    );
  }
  return (
    <Card label="Choose a new password">
      <div style={{ display: 'grid', gap: 10 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={labelText}>New password</span>
          <input id="reset-new-password" type="password" autoComplete="new-password" value={password}
            onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span style={labelText}>Confirm new password</span>
          <input id="reset-confirm-password" type="password" autoComplete="new-password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} style={inputStyle} />
        </label>
        <p className="glossary" style={{ margin: 0, color: mismatch ? 'var(--hold)' : undefined }}>
          {mismatch ? 'The passwords don’t match.' : 'At least 8 characters. This signs you out on every device.'}
        </p>
        <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => void submit()}
          disabled={busy || password.length < 8 || password !== confirm}>
          {busy ? 'Saving…' : 'Set new password'}
        </button>
      </div>
      {error && (
        <>
          <p style={errorNote}>{error}</p>
          <p className="glossary"><a href="/">Request a new link from the sign-in page</a></p>
        </>
      )}
    </Card>
  );
}

/** "Forgot your password?" from the sign-in form. The server's answer never says whether an
 *  account exists, so neither does this page. */
export function ForgotPassword({ onBack, initialEmail = '' }: { onBack: () => void; initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSentMessage((await api.requestPasswordReset(email.trim())).message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not send a reset link');
    } finally {
      setBusy(false);
    }
  };

  // Rendered inside Login's layout (the scene stays on the left; only this form swaps in).
  return (
    <>
      <h1 className="auth-title">Reset your password</h1>
      {sentMessage ? (
        <>
          <p className="auth-sub">Check your inbox.</p>
          <p className="auth-success" role="status">{sentMessage} It expires in 30 minutes.</p>
          <button type="button" className="btn btn-secondary auth-submit" style={{ marginTop: 'var(--sp-5)' }}
            onClick={() => { setSentMessage(null); }}>
            Send another link
          </button>
        </>
      ) : (
        <>
          <p className="auth-sub">Enter your email and we’ll send you a link to choose a new password.</p>
          <form className="auth-form" onSubmit={submit} noValidate>
            <label className="auth-field" htmlFor="forgot-email">
              <span>Email</span>
              <input id="forgot-email" className="auth-input" type="email" autoComplete="username" inputMode="email"
                value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button type="submit" className="btn btn-primary auth-submit" disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        </>
      )}
      <p className="auth-alt">
        <button type="button" className="linkbtn" onClick={onBack}>← Back to sign in</button>
      </p>
    </>
  );
}

/** What a signed-in, not-yet-verified new account sees instead of the app. */
export function VerifyEmailGate() {
  const { account, refresh, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const resend = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.resendVerification();
      setMessage(r.alreadyVerified ? 'Your email is already verified.' : r.sent ? 'A new link is on its way — only the newest link works.' : 'We couldn’t send an email just now. Try again in a few minutes.');
      if (r.alreadyVerified) await refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'could not send a new link');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px' }}>
      <div className="panel" style={{ width: '100%', maxWidth: 400, marginTop: 0 }}>
        <header><span className="label">Verify your email</span></header>
        <div className="inner">
          <p className="sub" style={{ marginTop: 0 }}>
            We sent a link to <strong>{account?.email}</strong>. Open it to finish setting up your account &mdash; it expires in 24 hours.
          </p>
          <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
            <button className="btn btn-primary" style={{ width: '100%' }} onClick={() => void refresh()}>I&rsquo;ve verified my email</button>
            <button className="btn" style={{ width: '100%' }} onClick={() => void resend()} disabled={busy}>
              {busy ? 'Sending…' : 'Send a new link'}
            </button>
          </div>
          {message && <p className="glossary" style={{ marginTop: 12 }}>{message}</p>}
          <p className="glossary" style={{ marginTop: 16 }}>
            Wrong address? <button onClick={() => void logout()} style={linkButton}>Sign out</button> and create the account again with the right one.
          </p>
        </div>
      </div>
    </div>
  );
}
