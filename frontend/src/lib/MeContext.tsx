import { createContext, useContext, useState, type ReactNode } from 'react';
import type { MyIdentity } from './api';
import { useAuth } from './AuthContext';

interface MeContextValue {
  meId: number;
  meOrgId: number;
  /** Every real org-chart identity this account is actually linked to — never anyone
   *  else's, never another organization's. Multi-org membership means more than one
   *  entry; switching between them (via setMeOrg) is the only "switching" this context
   *  does now. */
  identities: MyIdentity[];
  setMeOrg: (orgId: number) => void;
}

const MeContext = createContext<MeContextValue | null>(null);

/** "My agent" used to be a free identity switcher — any logged-in account could browse
 *  into *any* organization (a standing public demo org, always, plus any real one it
 *  happened to administer) and pick *any* person there, viewing that person's own full
 *  self-view (their connected surfaces, their own ask-yourself chat history) as if it
 *  were their own account. That was a reasonable dev/QA convenience while this was a
 *  closed internal build with only seed data behind it; it stopped being reasonable the
 *  moment real people could sign up and land in "My agent" only to discover they could
 *  browse into a stranger's organization and pick any employee's name off a list — found
 *  live, reported as exactly the alarming thing it was ("why am I able to see this
 *  organization... I am able to sign in as other person"). "My agent" now shows *only*
 *  the identities the logged-in account is actually linked to (`people.account_id` in the
 *  database, `AuthContext`'s own `people`) — nothing else is reachable from here. Genuinely
 *  previewing what another role or person would see is still real, still supported, and
 *  still clearly labeled as a simulation rather than a login: `Preview.tsx` (self-service,
 *  "what would X role see about me") and Admin's `PolicyMatrix.tsx` (an admin testing the
 *  policy grid), both via `/api/query`'s persist:false preview mode. */
export function MeProvider({ children }: { children: ReactNode }) {
  const { people: identities } = useAuth();
  // An explicit manual switch (multi-org membership only) — everything else is resolved
  // synchronously below, every render, straight from `identities`. A derived-via-effect
  // version of this used to lag one render behind a fresh `identities` update (the effect
  // hadn't run yet), and in that gap `meId` fell back to a `0` sentinel that leaked into a
  // real request (`GET /person/0`) right after signup, when `identities` goes from empty
  // to populated almost instantly. Resolving inline avoids that gap entirely — there's no
  // render where `identities` has arrived but `active` hasn't caught up yet.
  const [manualOrgId, setManualOrgId] = useState<number | null>(null);
  const active =
    (manualOrgId != null ? identities.find((p) => p.orgId === manualOrgId) : undefined)
    ?? identities[0]
    ?? null;

  return (
    <MeContext.Provider
      value={{
        meId: active?.id ?? 0,
        meOrgId: active?.orgId ?? 0,
        identities,
        setMeOrg: setManualOrgId,
      }}
    >
      {children}
    </MeContext.Provider>
  );
}

export function useMe(): MeContextValue {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error('useMe must be used within a MeProvider');
  return ctx;
}
