import { useEffect, useState } from 'react';
import { api, type InvitationInfo } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { Login } from './Login';

export function inviteTokenFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/invite\/(aoi_[A-Za-z0-9_-]{43})\/?$/);
  return match ? match[1] : null;
}

const note = { fontSize: 12, color: 'var(--hold)', background: 'var(--hold-bg)', border: '1px solid var(--rule2)', borderRadius: 2, padding: '7px 11px', marginTop: 12 } as const;

function describe(info: InvitationInfo): string {
  const who = info.invitedByName ?? 'Someone';
  return info.kind === 'admin'
    ? `${who} invited you to administer ${info.orgName} as ${info.adminRole === 'viewer' ? 'a viewer' : `an ${info.adminRole}`}.`
    : `${who} invited you to join ${info.orgName} as ${info.personName}${info.personTitle ? `, ${info.personTitle}` : ''}.`;
}

/** The page an invitation link opens (release audit SEC-08). Accepting needs a session whose
 *  email matches the invitation — the server enforces that; this page just guides the person
 *  to sign in or create an account with the right address first. */
export function AcceptInvite({ token }: { token: string }) {
  const { account, loading, refresh, logout } = useAuth();
  const [info, setInfo] = useState<InvitationInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.invitation(token).then((d) => setInfo(d.invitation)).catch((e: Error) => setLoadError(e.message));
  }, [token]);

  const accept = async () => {
    if (!info) return;
    setBusy(true);
    setError(null);
    try {
      await api.acceptInvitation(token);
      await refresh();
      window.location.assign(info.kind === 'admin' ? '/admin/overview' : '/me/mine');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not accept this invitation');
      setBusy(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="app">
      <header className="topbar">
        <a href="/" className="brand" style={{ color: 'var(--ink)', textDecoration: 'none' }}>Agent Org Mesh</a>
        <span className="spacer" />
      </header>
      <div className="body" style={{ flexDirection: 'column', alignItems: 'center' }}>{children}</div>
    </div>
  );

  // The padded wrapper keeps a side gutter at phone width; width + margin on the card itself
  // overflowed the screen.
  const card = (children: React.ReactNode) => (
    <div style={{ width: '100%', boxSizing: 'border-box', paddingInline: 20, display: 'flex', justifyContent: 'center' }}>
      <div className="panel" style={{ width: '100%', maxWidth: 420, marginTop: 40 }}>
        <header><span className="label">Invitation</span></header>
        <div className="inner">{children}</div>
      </div>
    </div>
  );

  if (loadError) {
    return shell(card(<>
      <p className="sub" style={{ marginTop: 0 }}>This invitation link isn&rsquo;t valid. Check you copied the whole link, or ask for a new one.</p>
      <p className="glossary"><a href="/">Go to Agent Org Mesh</a></p>
    </>));
  }
  if (!info || loading) return shell(card(<p className="sub" style={{ margin: 0 }}>Loading&hellip;</p>));

  if (info.status !== 'pending') {
    const why = { accepted: 'has already been used', expired: 'has expired', revoked: 'was withdrawn' }[info.status];
    return shell(card(<>
      <p className="sub" style={{ marginTop: 0 }}>This invitation to {info.orgName} {why}. Ask whoever invited you for a new link.</p>
      <p className="glossary"><a href="/">Go to Agent Org Mesh</a></p>
    </>));
  }

  const summary = (
    <>
      <p className="sub" style={{ marginTop: 0 }}>{describe(info)}</p>
      <p className="glossary" style={{ marginTop: 6 }}>
        For <strong>{info.email}</strong> &middot; expires {new Date(info.expiresAt).toLocaleDateString()}
      </p>
    </>
  );

  if (!account) {
    return shell(<>
      {card(<>
        {summary}
        <p className="glossary" style={{ marginTop: 10 }}>Sign in, or create an account, with {info.email} to accept.</p>
      </>)}
      {/* Just the form: the invitation card above is this page's frame, not the split sign-in scene. */}
      <div style={{ width: '100%' }}>
        <Login initialEmail={info.email} embedded />
      </div>
    </>);
  }

  if (account.email.toLowerCase() !== info.email.toLowerCase()) {
    return shell(card(<>
      {summary}
      <p style={note}>
        You&rsquo;re signed in as {account.email}. This invitation can only be accepted by {info.email}.
      </p>
      <button className="btn" style={{ width: '100%', marginTop: 12 }} onClick={() => void logout()}>
        Sign out and use {info.email}
      </button>
    </>));
  }

  return shell(card(<>
    {summary}
    <button className="btn btn-primary" style={{ width: '100%', marginTop: 14 }} disabled={busy} onClick={accept}>
      {busy ? 'Accepting…' : `Accept as ${account.email}`}
    </button>
    {error && <p style={note}>{error}</p>}
  </>));
}
