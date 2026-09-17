import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';

/** One modal serving both halves of password self-service, since the form is identical and
 *  only the framing differs:
 *
 *  - `forced` — this account is still on a temp password someone else generated for it (an
 *    invite, or an admin-initiated reset; `accounts.must_change_password`). App.tsx's Shell
 *    renders this over everything, with no way to dismiss it, until a real password is
 *    chosen. Before this existed, `POST /api/auth/change-password` had no UI at all
 *    anywhere in the app, so an invited person's temp password silently became their
 *    permanent one — the actual gap this whole pass closes.
 *  - voluntary — opened from the profile menu by someone who just wants to change it.
 *    Dismissible, otherwise the same call.
 *
 *  The server clears `must_change_password` and revokes every *other* session on success
 *  (OWASP's Forgot Password guidance), so nothing here has to be trusted to do either. */
export function ChangePasswordModal({ forced, onClose }: { forced: boolean; onClose?: () => void }) {
  const { account, refresh } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // A forced change is the only thing on screen, so the page behind it shouldn't scroll —
  // a `position: fixed` overlay covers the viewport but does nothing to stop the body
  // scrolling underneath it, which let someone browse the whole app behind the prompt.
  useEffect(() => {
    if (!forced) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [forced]);

  // OWASP: have them type the new password twice. Checked here purely as fast feedback —
  // length is re-enforced server-side regardless.
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const canSubmit = !busy && currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      // Re-fetch so `mustChangePassword` flips false and Shell stops forcing this modal.
      await refresh();
      setDone(true);
      if (!forced) onClose?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not change your password');
    } finally {
      setBusy(false);
    }
  };

  // A forced change that succeeded unmounts itself via Shell's own `mustChangePassword`
  // check on the next render; this only shows if that somehow lags a beat.
  if (done && forced) return null;

  const label = (text: string) => (
    <span className="field-label">
      {text}
    </span>
  );
  const field = (
    text: string,
    value: string,
    setValue: (v: string) => void,
    autoComplete: string,
    autoFocus = false,
  ) => (
    <label className="field">
      {label(text)}
      <input
        aria-label={text}
        type="password"
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape' && !forced) onClose?.(); }}
        className="input"
      />
    </label>
  );

  return (
    <div
      className="stepup-overlay"
      onClick={(e) => { if (!forced && e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="panel" style={{ width: '100%', maxWidth: 380, marginTop: 0 }}>
        <header><span className="label">{forced ? 'Choose your password' : 'Change password'}</span></header>
        <div className="inner">
          <p className="sub" style={{ marginTop: 0, marginBottom: 16 }}>
            {forced ? (
              <>
                You&rsquo;re signed in with a temporary password that was generated for you
                {account?.name ? <> as <strong>{account.name}</strong></> : null}. Choose your own
                before you go any further &mdash; nobody else should know your password, including
                whoever invited you.
              </>
            ) : (
              <>
                Changing your password signs you out everywhere else you&rsquo;re currently signed
                in. This tab stays signed in.
              </>
            )}
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            {field(forced ? 'Temporary password' : 'Current password', currentPassword, setCurrentPassword, 'current-password', true)}
            {field('New password', newPassword, setNewPassword, 'new-password')}
            {field('Confirm new password', confirmPassword, setConfirmPassword, 'new-password')}
            {tooShort && <span className="glossary" style={{ margin: 0 }}>At least 8 characters.</span>}
            {mismatch && <span className="glossary" style={{ margin: 0, color: 'var(--hold)' }}>Those two don&rsquo;t match.</span>}
            <div style={{ display: 'flex', gap: 7 }}>
              <button className="btn btn-primary" onClick={submit} disabled={!canSubmit} style={{ flex: 1 }}>
                {busy ? 'Saving…' : forced ? 'Set my password' : 'Change password'}
              </button>
              {!forced && <button className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>}
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
  );
}
