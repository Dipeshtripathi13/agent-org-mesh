import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import { AuthProvider, useAuth } from './lib/AuthContext';
import { MeProvider, useMe } from './lib/MeContext';
import { OrgProvider, useOrg } from './lib/OrgContext';
import { StepUpProvider } from './lib/StepUpContext';
import { Ask } from './pages/Ask';
import { AuditLog } from './pages/AuditLog';
import { Connections } from './pages/Connections';
import { Controls } from './pages/Controls';
import { CoverageMatrix } from './pages/CoverageMatrix';
import { Escalations } from './pages/Escalations';
import { Legal, legalPageFromPath } from './pages/Legal';
import { Login } from './pages/Login';
import { MyAgent } from './pages/MyAgent';
import { OrgGraph } from './pages/OrgGraph';
import { OrgSetup } from './pages/OrgSetup';
import { OrgStructure } from './pages/OrgStructure';
import { Overview } from './pages/Overview';
import { PolicyMatrix } from './pages/PolicyMatrix';
import { Preview } from './pages/Preview';
import { SetUpMyAgent } from './pages/SetUpMyAgent';
import { WhatItKnows } from './pages/WhatItKnows';
import { WhoAsked } from './pages/WhoAsked';
import { ChangePasswordModal } from './components/ChangePasswordModal';

const ADMIN = [
  { key: 'overview', label: 'Overview', el: <Overview /> },
  { key: 'organizations', label: 'Organizations', el: <OrgSetup /> },
  { key: 'org', label: 'Org graph', el: <OrgGraph /> },
  { key: 'matrix', label: 'Coverage matrix', el: <CoverageMatrix /> },
  { key: 'connections', label: 'Connections', el: <Connections /> },
  { key: 'policy', label: 'Policy matrix', el: <PolicyMatrix /> },
  { key: 'audit', label: 'Audit log', el: <AuditLog /> },
  { key: 'escalations', label: 'Escalations', el: <Escalations /> },
];
const MINE = [
  { key: 'mine', label: 'My agent', el: <MyAgent /> },
  { key: 'setup', label: 'Set up my agent', el: <SetUpMyAgent /> },
  { key: 'knows', label: 'What it knows', el: <WhatItKnows /> },
  { key: 'preview', label: 'Preview', el: <Preview /> },
  { key: 'ask', label: 'Ask', el: <Ask /> },
  { key: 'whoasked', label: 'Who asked about me', el: <WhoAsked /> },
  { key: 'orgme', label: 'Org structure', el: <OrgStructure /> },
  { key: 'controls', label: 'Controls', el: <Controls /> },
];

function OrgSwitcher() {
  const { orgId, organizations, setOrgId } = useOrg();
  if (organizations.length === 0) return null;
  return (
    <select
      aria-label="Current organization"
      value={orgId}
      onChange={(e) => setOrgId(Number(e.target.value))}
      className="org-switcher"
    >
      {organizations.map((o) => (
        <option key={o.id} value={o.id}>{o.name}</option>
      ))}
    </select>
  );
}

/** Which of *your own* org-chart identities "My agent" is showing — only relevant, and
 *  only rendered, when the account is a real person in more than one organization. No
 *  person-picker anymore: within a given org you only ever have exactly one identity
 *  (yourself), so there's nothing left to switch there. See MeContext's own module
 *  comment for why this used to (and no longer does) let you browse into anyone else's. */
function MeSwitcher() {
  const { meOrgId, identities, setMeOrg } = useMe();
  if (identities.length < 2) return null;
  return (
    <select
      aria-label="Switch organization (My agent)"
      value={meOrgId}
      onChange={(e) => setMeOrg(Number(e.target.value))}
      className="org-switcher"
    >
      {identities.map((p) => (
        <option key={p.orgId} value={p.orgId}>{p.orgName}</option>
      ))}
    </select>
  );
}

/** The account's own profile trigger, folded into one menu instead of scattering "Admin"
 *  and "Log out" as separate topbar buttons — click your name to either switch to Admin
 *  (or head back to "My agent") and to log out, same shape as most real products' own
 *  account menus (a profile picture/name in the corner that opens both "switch context"
 *  and "sign out"). Switching to Admin no longer prompts for re-authentication — see
 *  Shell's own comment on why; a specific sensitive action inside Admin might still ask
 *  for one, inline, via StepUpContext.tsx. Closes on an outside click or Escape; a fresh
 *  click anywhere else in the menu also closes it after acting. */
function ProfileMenu({
  panel, switchPanel, name, subtitle, logout, onChangePassword,
}: {
  panel: 'admin' | 'me'; switchPanel: (p: 'admin' | 'me') => void; name: string; subtitle: string;
  logout: () => void; onChangePassword: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="profile-menu" ref={ref}>
      <button
        type="button"
        className="whoami"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <i className="avatar-dot" aria-hidden="true">{name.charAt(0)}</i>
        <span className="whoami-text">
          <strong>{name}</strong>
          <span className="whoami-title">{subtitle}</span>
        </span>
      </button>
      {open && (
        <div className="profile-dropdown" role="menu">
          {panel === 'admin' ? (
            <button type="button" role="menuitem" onClick={() => { switchPanel('me'); setOpen(false); }}>
              &larr; My agent
            </button>
          ) : (
            <button type="button" role="menuitem" onClick={() => { switchPanel('admin'); setOpen(false); }}>
              Admin
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onChangePassword(); }}>
            Change password
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => { setOpen(false); logout(); }}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

function Topbar({
  panel, switchPanel, hasOwnIdentity, onChangePassword,
}: {
  panel: 'admin' | 'me'; switchPanel: (p: 'admin' | 'me') => void; hasOwnIdentity: boolean;
  onChangePassword: () => void;
}) {
  const { meId, identities } = useMe();
  const { account, logout } = useAuth();
  // MeSwitcher (when it renders at all) only ever lists the account's own real
  // identities now — see MeContext's module comment — so there's no separate "wrong to
  // show on the empty state" concern left here; it's just meaningless with no identity.
  const showMeSwitcher = panel === 'me' && account && hasOwnIdentity;

  // Who you are is the *account*, always — not the org-chart row. This used to render
  // `person.name`/`person.title` from whichever org was active, which got two things
  // wrong: the name became whatever an admin happened to type when adding you (log in as
  // yourself, get greeted as "trip"), and the title read as an identity rather than a role
  // — "manager" full stop, when the same human is a manager in one org and an engineer in
  // the next. Titles are org-scoped by design (a `people` row per org, see MeContext), so
  // the title is only ever shown *with the org it belongs to*. Derived synchronously from
  // identities the AuthProvider already loaded, so there's no extra request and no window
  // where the header shows a stale org's title after switching.
  const activeIdentity = identities.find((p) => p.id === meId) ?? null;
  const subtitle =
    panel === 'admin' ? 'Platform admin'
    : activeIdentity ? `${activeIdentity.title} · ${activeIdentity.orgName}`
    : 'Personal account';

  return (
    <header className="topbar">
      <span className="brand">Agent Org Mesh</span>
      {panel === 'admin' && account && <OrgSwitcher />}
      {showMeSwitcher && <MeSwitcher />}
      <span className="spacer" />
      <span className="readonly"><i className="dot-live" />Read-only &middot; no write scope</span>
      {account && (
        <ProfileMenu
          panel={panel}
          switchPanel={switchPanel}
          name={account.name}
          subtitle={subtitle}
          logout={() => void logout()}
          onChangePassword={onChangePassword}
        />
      )}
    </header>
  );
}

type Panel = 'admin' | 'me';
interface Route { panel: Panel; screen: string; }

/** The real navigation state, always derivable from — and always written back to —
 *  window.location. Previously this was pure React state with no URL involvement at
 *  all: switching tabs never changed the address bar, so refreshing always reset you to
 *  Admin/Overview and the browser's Back/Forward buttons did nothing. Unknown or garbage
 *  paths (a stale bookmark, a typo) fall back to that screen's default rather than a
 *  blank page — never a hard failure over a bad URL. */
function parsePath(pathname: string): Route {
  const [panelSeg, screenSeg] = pathname.split('/').filter(Boolean);
  // "My agent" is the only thing shown by default — an unrecognized or root path (or a
  // stale bookmark from before this changed) lands there, never on Admin. Admin is only
  // ever reached by an explicit /admin/... path, via the topbar's own entry point.
  const panel: Panel = panelSeg === 'admin' ? 'admin' : 'me';
  const nav = panel === 'admin' ? ADMIN : MINE;
  const screen = nav.some((n) => n.key === screenSeg) ? screenSeg! : nav[0].key;
  return { panel, screen };
}

function pathFor(route: Route): string {
  return `/${route.panel}/${route.screen}`;
}

function Shell() {
  const [{ panel, screen }, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  const { account, orgRoles, people: myIdentities, loading: authLoading } = useAuth();
  // Voluntary "Change password" from the profile menu. The *forced* case below doesn't
  // use this flag at all — it's driven purely by the account's own server-side
  // must_change_password, so it can't be dismissed by any client state.
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  // Two genuinely different facts, kept separate rather than conflated into one "zero
  // orgs" flag: whether this account administers any org at all (drives what Admin's
  // sidebar can show), and whether it's a real person in any org's chart at all (drives
  // whether "My agent" has an identity of its own to show — see MeContext's own comment
  // for why it's no longer allowed to fall back to browsing someone else's).
  const hasAdminRole = Object.keys(orgRoles).length > 0;
  const hasOwnIdentity = myIdentities.length > 0;
  // Only "Organizations" is reachable in Admin until an org actually exists — the other
  // screens all assume one (an org switcher, an orgId to query), and would otherwise be a
  // wall of broken-looking screens on someone's very first visit. Same reasoning on the
  // "My agent" side: without an org-chart identity, only "My agent" (now a personal Ask
  // yourself) and "Set up my agent" (a personal main agent) apply — What it knows,
  // Preview, Ask, Who asked about me, and Org structure are all org-structure/disclosure
  // concepts a personal-only account has nothing to show for.
  const nav =
    panel === 'admin' ? (hasAdminRole ? ADMIN : ADMIN.filter((n) => n.key === 'organizations'))
    : hasOwnIdentity ? MINE
    : MINE.filter((n) => n.key === 'mine' || n.key === 'setup');
  const active = nav.find((n) => n.key === screen) ?? nav[0];

  /** The one place that ever touches history — every navigation in the app (tab switch,
   *  sidebar click) funnels through this so the URL and the rendered screen can never
   *  drift apart. `replace: true` for the initial-load normalization (e.g. "/" →
   *  "/admin/overview") so that doesn't itself become a Back-button stop. */
  const go = (route: Route, replace = false) => {
    // The screen switch itself must never depend on the URL sync succeeding — updating
    // React state comes first and unconditionally. history.pushState/replaceState can
    // fail for reasons outside this app's control (a browser's own rate limit on rapid
    // calls, a hardened extension blocking History API writes, ...); if that ever
    // happens the address bar simply falls behind for a moment instead of the whole app
    // getting stuck on the last screen.
    setRoute(route);
    const path = pathFor(route);
    if (window.location.pathname !== path) {
      try {
        (replace ? window.history.replaceState : window.history.pushState).call(window.history, null, '', path);
      } catch (err) {
        console.error('history update failed — navigation still succeeded', err);
      }
    }
  };

  useEffect(() => {
    go(parsePath(window.location.pathname), true); // normalize on first load
    const onPopState = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchPanel = (p: Panel) =>
    go({ panel: p, screen: p === 'admin' ? (hasAdminRole ? 'overview' : 'organizations') : 'mine' });
  const setScreen = (key: string) => go({ panel, screen: key });

  // Both panels require a real login first — "My agent" no longer works fully logged-out.
  // That reverses what used to be a deliberate, documented demo affordance (a free
  // identity switcher defaulting to a seeded Northbeam employee, reachable by anyone with
  // zero auth): fine for internal testing, but once real strangers can land here via the
  // marketing site's "Try it for free" link, showing a named person's data to
  // nobody-in-particular reads exactly like a broken login, not a demo.
  //
  // Admin no longer gates entry behind a second factor — research into how GitHub/Stripe/
  // Google Workspace/NIST 800-63B/OWASP actually handle "logged in vs. elevated" found
  // that blanket step-up on *entering* an admin area is a real outlier; none of them
  // re-authenticate before you can even look at settings, only before a specific
  // sensitive action. A logged-in admin sees every Admin screen immediately now — the
  // step-up prompt (StepUpContext.tsx) surfaces inline, only when a specific action
  // (inviting/removing an admin, changing a role, removing a person, setting the org's
  // main-agent credentials, editing policy) actually returns 428, exactly the same way
  // GitHub's own sudo mode works. Every one of those endpoints still re-checks elevation
  // server-side regardless (requireOrgRole in server.ts) — this UI change doesn't relax
  // that boundary, it just moves where the prompt appears.
  const gate = authLoading ? 'checking' : !account ? 'locked' : 'open';
  // A temp password someone else generated (an invite, or an admin-initiated reset) is not
  // a password this account ever chose, so it gets exactly one screen: choose a real one.
  // Driven by the server's own accounts.must_change_password via /api/auth/me — there is
  // no client-side dismiss, and every other endpoint stays reachable regardless, so this
  // is a UX forcing function rather than a security boundary pretending to be one.
  const mustChangePassword = gate === 'open' && account?.mustChangePassword === true;

  return (
    <div className="app">
      <Topbar
        panel={panel}
        switchPanel={switchPanel}
        hasOwnIdentity={hasOwnIdentity}
        onChangePassword={() => setChangePasswordOpen(true)}
      />

      {gate === 'checking' ? (
        <div className="body" />
      ) : gate === 'locked' ? (
        <div className="body">
          <Login />
        </div>
      ) : (
        <div className="body">
          <nav className="sidebar">
            <h2>{panel === 'admin' ? 'Admin · IT & exec' : hasOwnIdentity ? 'My agent · employee' : 'My agent · personal'}</h2>
            <div className="navlist">
              {nav.map((n) => (
                <button
                  key={n.key}
                  className="navitem"
                  aria-current={active.key === n.key ? 'page' : undefined}
                  onClick={() => setScreen(n.key)}
                >
                  {n.label}
                </button>
              ))}
            </div>
            <p className="navfoot">
              {panel === 'admin'
                ? 'Every query you run appears in the subject’s own log, attributed to you.'
                : 'This panel is yours. Nothing on it is hidden from you.'}
            </p>
          </nav>
          <main className="main">{active.el}</main>
        </div>
      )}

      {mustChangePassword && <ChangePasswordModal forced />}
      {!mustChangePassword && changePasswordOpen && (
        <ChangePasswordModal forced={false} onClose={() => setChangePasswordOpen(false)} />
      )}
    </div>
  );
}

export default function App() {
  // Legal pages are public and need no session, so they render before any auth provider
  // mounts (no /api/auth/me request, no login gate).
  const legalPage = legalPageFromPath(window.location.pathname);
  if (legalPage) return <Legal page={legalPage} />;

  return (
    <AuthProvider>
      <StepUpProvider>
        <OrgProvider>
          <MeProvider>
            <Shell />
          </MeProvider>
        </OrgProvider>
      </StepUpProvider>
    </AuthProvider>
  );
}
