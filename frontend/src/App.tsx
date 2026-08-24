import { useEffect, useRef, useState } from 'react';
import { api } from './lib/api';
import { AuthProvider, useAuth } from './lib/AuthContext';
import { MeProvider, useMe } from './lib/MeContext';
import { OrgProvider, useOrg } from './lib/OrgContext';
import { Ask } from './pages/Ask';
import { AuditLog } from './pages/AuditLog';
import { Connections } from './pages/Connections';
import { Controls } from './pages/Controls';
import { CoverageMatrix } from './pages/CoverageMatrix';
import { Escalations } from './pages/Escalations';
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

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

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

/** Who "My agent" acts as — switchable to any person in any organization, for testing. */
function MeSwitcher() {
  const { meId, meOrgId, people, organizations, setMeOrg, setMeId } = useMe();
  if (organizations.length === 0) return null;
  return (
    <>
      <select
        aria-label="Switch organization (My agent)"
        value={meOrgId}
        onChange={(e) => setMeOrg(Number(e.target.value))}
        className="org-switcher"
      >
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
      <select
        aria-label="Switch person (My agent)"
        value={meId}
        onChange={(e) => setMeId(Number(e.target.value))}
        className="org-switcher"
      >
        {people.map((p) => (
          <option key={p.id} value={p.id}>{p.name} &middot; {p.title}</option>
        ))}
      </select>
    </>
  );
}

function Topbar({ panel, switchPanel }: { panel: 'admin' | 'me'; switchPanel: (p: 'admin' | 'me') => void }) {
  const { meId } = useMe();
  const { account, logout } = useAuth();
  const [who, setWho] = useState<{ name: string; subtitle: string } | null>(null);

  useEffect(() => {
    if (panel === 'admin') {
      setWho(account ? { name: account.name, subtitle: 'Platform admin' } : null);
    } else {
      api.person(meId).then((d) => setWho({ name: d.person.name, subtitle: d.person.title }));
    }
  }, [panel, meId, account]);

  const now = useClock();
  const clock = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });

  return (
    <header className="topbar">
      <span className="brand">Agent Org Mesh</span>
      <div className="tabs">
        <button aria-pressed={panel === 'admin'} onClick={() => switchPanel('admin')}>Admin</button>
        <button aria-pressed={panel === 'me'} onClick={() => switchPanel('me')}>My agent</button>
      </div>
      {panel === 'admin' && account && <OrgSwitcher />}
      {panel === 'me' && <MeSwitcher />}
      <span className="spacer" />
      <span className="clock">{date} &middot; {clock}</span>
      {who && (
        <span className="whoami">
          <i className="avatar-dot" aria-hidden="true">{who.name.charAt(0)}</i>
          <span className="whoami-text">
            <strong>{who.name}</strong>
            <span className="whoami-title">{who.subtitle}</span>
          </span>
        </span>
      )}
      {panel === 'admin' && account && (
        <button
          onClick={() => void logout()}
          style={{ fontSize: 11, background: 'none', border: '1px solid var(--rule2)', borderRadius: 2, padding: '5px 9px', cursor: 'pointer', color: 'var(--ink2)' }}
        >
          Log out
        </button>
      )}
      <span className="readonly"><i className="dot-live" />Read-only &middot; no write scope</span>
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
  const panel: Panel = panelSeg === 'me' ? 'me' : 'admin';
  const nav = panel === 'admin' ? ADMIN : MINE;
  const screen = nav.some((n) => n.key === screenSeg) ? screenSeg! : nav[0].key;
  return { panel, screen };
}

function pathFor(route: Route): string {
  return `/${route.panel}/${route.screen}`;
}

function Shell() {
  const [{ panel, screen }, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  const { account, orgRoles, people, loading: authLoading } = useAuth();
  const nav = panel === 'admin' ? ADMIN : MINE;
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

  const switchPanel = (p: Panel) => go({ panel: p, screen: p === 'admin' ? 'overview' : 'mine' });
  const setScreen = (key: string) => go({ panel, screen: key });

  /** Where a fresh login lands, when it isn't obvious. Someone with an admin role
   *  somewhere stays on the Admin panel they just signed into — that's what they came
   *  for. Someone who's only ever a person in an org chart (no admin role anywhere) gets
   *  sent to "My agent" instead of an empty, slightly baffling Admin panel — a better
   *  default, not a lockdown; nothing stops them clicking back to Admin themselves.
   *  Guarded so this only fires on a genuine logged-out → logged-in transition, never on
   *  a page refresh that happens to already have a session (which must respect whatever
   *  the URL already says, deep-link/refresh-preserves-place). */
  const authKnown = useRef(false);
  const wasLoggedIn = useRef(false);
  useEffect(() => {
    if (authLoading) return;
    if (!authKnown.current) {
      authKnown.current = true;
      wasLoggedIn.current = !!account;
      return;
    }
    const justLoggedIn = !!account && !wasLoggedIn.current;
    wasLoggedIn.current = !!account;
    if (justLoggedIn && panel === 'admin' && Object.keys(orgRoles).length === 0 && people.length > 0) {
      switchPanel('me');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, authLoading]);

  // The Admin panel is real, session-gated content — "My agent" stays fully open (see
  // MeContext's own comment: a real per-person login now exists too, but the free
  // identity switcher is a deliberate, documented demo affordance that isn't removed by
  // it — see CLAUDE.md rule 7). While the session check is still in flight, show neither
  // the login form nor admin content, so a real session never flashes a login prompt
  // first and an absent one never flashes real org data before redirecting.
  const adminGate = panel !== 'admin' ? 'open' : authLoading ? 'checking' : account ? 'open' : 'locked';

  return (
    <div className="app">
      <Topbar panel={panel} switchPanel={switchPanel} />

      {adminGate === 'checking' ? (
        <div className="body" />
      ) : adminGate === 'locked' ? (
        <div className="body">
          <Login />
        </div>
      ) : (
        <div className="body">
          <nav className="sidebar">
            <h2>{panel === 'admin' ? 'Admin · IT & exec' : 'My agent · employee'}</h2>
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
            <p className="navfoot">
              {panel === 'admin'
                ? 'Every query you run appears in the subject’s own log, attributed to you.'
                : 'This panel is yours. Nothing on it is hidden from you.'}
            </p>
          </nav>
          <main className="main">{active.el}</main>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <OrgProvider>
        <MeProvider>
          <Shell />
        </MeProvider>
      </OrgProvider>
    </AuthProvider>
  );
}
