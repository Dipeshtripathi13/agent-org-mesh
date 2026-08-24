import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Account, type MyIdentity, type OrgRole } from './api';

interface AuthContextValue {
  account: Account | null;
  /** This account's role per org, keyed by org id — what the frontend uses to decide
   *  which actions to even show as available. The server enforces the real boundary on
   *  every mutating request regardless; this is convenience, same "gray out, server
   *  enforces for real" split roles.ts already documents for Ask's role chips. */
  orgRoles: Record<number, OrgRole>;
  /** Every org-chart identity linked to this account — "log in as yourself" resolves to
   *  one of these. Empty for an account that's never been added to (or signed up into)
   *  any org's chart, e.g. an admin-only account. */
  people: MyIdentity[];
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string, organizationName: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [orgRoles, setOrgRoles] = useState<Record<number, OrgRole>>({});
  const [people, setPeople] = useState<MyIdentity[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const d = await api.authMe();
    setAccount(d.account);
    setOrgRoles(d.orgRoles);
    setPeople(d.people);
  };

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    await api.login(email, password);
    await refresh();
  };

  const signUp = async (name: string, email: string, password: string, organizationName: string) => {
    await api.signUp(name, email, password, organizationName);
    await refresh();
  };

  const logout = async () => {
    await api.logout();
    setAccount(null);
    setOrgRoles({});
    setPeople([]);
  };

  return (
    <AuthContext.Provider value={{ account, orgRoles, people, loading, login, signUp, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
