/**
 * What each plan allows — the single place to change it.
 *
 * `null` means unlimited (not `Infinity`: this crosses the API as JSON, where `Infinity`
 * silently becomes `null` anyway, so the type says what it means). There is still no billing
 * integration: an organization's `plan` column starts at 'starter' and only changes by a manual
 * database update after payment is arranged (see repo.ts's OrgPlan note). These limits are what
 * the server actually enforces, however the column got set.
 */
export type OrgPlan = 'starter' | 'business' | 'enterprise';

/** People per organization. Raise the free tier here and nothing else needs touching. */
export const PLAN_SEATS: Record<OrgPlan, number | null> = {
  starter: 10,
  business: 200,
  enterprise: null,
};

/** Organizations one account may create. Without this, the seat limit is trivially sidestepped
 *  by splitting a company across several free organizations (2026-09-17). Signing up creates the
 *  first one automatically, so this is the total an account can own. */
export const MAX_ORGS_PER_ACCOUNT = 5;

export function seatLimit(plan: OrgPlan): number | null {
  return PLAN_SEATS[plan] ?? null;
}

export function seatsAreFull(plan: OrgPlan, peopleCount: number): boolean {
  const limit = seatLimit(plan);
  return limit != null && peopleCount >= limit;
}
