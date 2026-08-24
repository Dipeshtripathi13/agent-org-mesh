import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Organization, type Person } from './api';
import { useAuth } from './AuthContext';

interface MeContextValue {
  meId: number;
  meOrgId: number;
  /** Full roster of meOrgId — the picker's source, and how pages look up "me" by id. */
  people: Person[];
  organizations: Organization[];
  setMeOrg: (orgId: number) => void;
  setMeId: (personId: number) => void;
}

const MeContext = createContext<MeContextValue | null>(null);

// Diego Okonjo, Northbeam — the original demo subject, and the fallback for anyone not
// logged in with a real identity of their own. Anyone can still switch away from this —
// see the login-aware default below, which changes only where the switcher *starts*.
const DEFAULT_ORG = 1;
const DEFAULT_ME = 11;

export function MeProvider({ children }: { children: ReactNode }) {
  const { account, people: myIdentities } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [meOrgId, setMeOrgId] = useState(DEFAULT_ORG);
  const [meId, setMeId] = useState(DEFAULT_ME);
  const [people, setPeople] = useState<Person[]>([]);

  // Unfiltered directory, not the admin-scoped api.organizations() — this switcher is
  // intentionally open regardless of whether an account happens to be logged in
  // elsewhere in the app (CLAUDE.md rule 7). Using the admin-scoped list here was a real
  // bug: it silently emptied this switcher whenever no session existed.
  useEffect(() => { api.orgDirectory().then((d) => setOrganizations(d.organizations)); }, []);

  // Logging in as yourself (a real account linked to at least one org-chart identity)
  // moves "My agent" to *you* by default, instead of the anonymous demo default above —
  // still just a default, not a lockdown: the free switcher a few lines down keeps
  // working exactly as before, this only changes where it starts. Keyed on account?.id
  // via a ref (not a dependency) so it fires once per login/logout transition and never
  // fights a manual switch made afterward on the same login.
  const appliedForAccount = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (account?.id === appliedForAccount.current) return;
    appliedForAccount.current = account?.id ?? null;
    if (account && myIdentities.length > 0) {
      setMeOrgId(myIdentities[0].orgId);
      setMeId(myIdentities[0].id);
    }
  }, [account, myIdentities]);

  // Single fetch on every org change (including the initial mount) — this used to be a
  // second, redundant api.org() call inside setMeOrg alongside this same effect, firing
  // two identical requests on every switch. Also defaults meId to the new roster's first
  // person only when the current one genuinely isn't in it, rather than unconditionally.
  useEffect(() => {
    void api.org(meOrgId).then((d) => {
      setPeople(d.people);
      setMeId((current) => (d.people.some((p) => p.id === current) ? current : (d.people[0]?.id ?? current)));
    });
  }, [meOrgId]);

  const setMeOrg = (orgId: number) => setMeOrgId(orgId);

  return (
    <MeContext.Provider value={{ meId, meOrgId, people, organizations, setMeOrg, setMeId }}>
      {children}
    </MeContext.Provider>
  );
}

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error('useMe must be used within a MeProvider');
  return ctx;
}
