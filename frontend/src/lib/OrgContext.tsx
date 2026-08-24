import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Organization } from './api';
import { useAuth } from './AuthContext';

interface OrgContextValue {
  orgId: number;
  organizations: Organization[];
  setOrgId: (id: number) => void;
  refresh: () => Promise<void>;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const { account } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [orgId, setOrgId] = useState(1);

  const refresh = async () => {
    const d = await api.organizations();
    setOrganizations(d.organizations);
    setOrgId((current) => (d.organizations.some((o) => o.id === current) ? current : d.organizations[0]?.id ?? 1));
  };

  // Re-fetch whenever the logged-in account changes — login populates real orgs where
  // there were none, logout clears back to none (the server itself returns [] for a
  // logged-out request, this just makes sure the frontend actually asks again instead of
  // holding onto whatever was fetched before login/logout happened).
  useEffect(() => { void refresh(); }, [account?.id]);

  return <OrgContext.Provider value={{ orgId, organizations, setOrgId, refresh }}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used within an OrgProvider');
  return ctx;
}
