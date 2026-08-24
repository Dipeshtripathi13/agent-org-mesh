import type {
  CoverageReport,
  EscalationDraft,
  EscalationPathEntry,
  Person,
  ResponseItem,
} from './types.js';

/**
 * Escalation detection. Same discipline as policy.ts: deterministic code over real
 * structural state, no LLM, no invented signal. A rule either fires from state this
 * system already, honestly, has — or it doesn't exist yet. See docs/escalation-triage.md.
 */

export const STALE_CLAIM_DAYS = 7;
export const REPEAT_WITHHOLD_THRESHOLD = 3;
const MS_PER_DAY = 86_400_000;

/** Target, then up to two levels of manager — the same depth the seeded escalation paths
 *  used (target → manager → skip-level), computed from the real org graph. */
export function computeEscalationPath(personId: number, people: Person[]): EscalationPathEntry[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const path: EscalationPathEntry[] = [];
  let current = byId.get(personId);
  let depth = 0;
  while (current && depth < 3) {
    path.push({ personId: current.id, name: current.name });
    current = current.managerId != null ? byId.get(current.managerId) : undefined;
    depth += 1;
  }
  return path;
}

/** Whole days between an ISO timestamp and `now`. Never negative. */
export function computeEscalationAge(createdAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(createdAt).getTime()) / MS_PER_DAY));
}

/**
 * ESC-COVERAGE — a person is meant to be monitored (agentDeployed) but has zero connected
 * real surfaces. The honest, structural version of the seeded narrative ("a blocker was
 * detected but coverage was too thin to assert it") — this system has no real blocker
 * signal yet, so it escalates exactly what it actually knows: nothing is connected.
 */
export function checkCoverageEscalation(
  person: Person,
  coverage: CoverageReport,
  people: Person[],
): EscalationDraft | null {
  if (!person.agentDeployed) return null;
  if (coverage.inScopeCount === 0) return null; // nothing was ever in scope to connect
  if (coverage.connectedCount > 0) return null;

  return {
    id: `esc-ESC-COVERAGE-${person.id}`,
    kind: 'CANT',
    rule: 'ESC-COVERAGE',
    title: `No connected surfaces for ${person.name}`,
    detail: `${person.name} is deployed but has zero connected surfaces out of ${coverage.inScopeCount} in scope. Nothing real can be asserted about their work until at least one connects.`,
    personId: person.id,
    evidenceId: null,
    path: computeEscalationPath(person.id, people),
  };
}

/**
 * ESC-STALE-CLAIM — the most recent real claim for a monitored person is older than
 * STALE_CLAIM_DAYS. Signals a connected tool went quiet (token revoked, hook removed)
 * rather than the person having no activity — this system can't tell those apart, so the
 * title says "gone quiet", not "no work happened".
 */
export function checkStaleClaimEscalation(
  person: Person,
  mostRecentClaimDerivedAt: string | null,
  now: Date,
  people: Person[],
): EscalationDraft | null {
  if (!person.agentDeployed) return null;
  if (!mostRecentClaimDerivedAt) return null; // never had a claim at all — ESC-COVERAGE's job

  const ageDays = computeEscalationAge(mostRecentClaimDerivedAt, now);
  if (ageDays < STALE_CLAIM_DAYS) return null;

  return {
    id: `esc-ESC-STALE-CLAIM-${person.id}`,
    kind: 'T2',
    rule: 'ESC-STALE-CLAIM',
    title: `${person.name}'s connected activity has gone quiet`,
    detail: `The most recent real claim for ${person.name} is ${ageDays} day${ageDays === 1 ? '' : 's'} old. A connected tool may have stopped reporting.`,
    personId: person.id,
    evidenceId: null,
    path: computeEscalationPath(person.id, people),
  };
}

/**
 * ESC-REPEAT-WITHHOLD — the same requester has been refused something real about the same
 * target on the last REPEAT_WITHHOLD_THRESHOLD *real, audited* asks in a row. Reads
 * `policyRef !== null` specifically (not `tier === 'CANT'`) — respond() always appends a
 * structural CANT boilerplate item to every single response (the comp/perf/legal/health
 * line), so counting any CANT would fire for everyone on their third ask ever. policyRef
 * is only ever set on a WONT item — the one produced by an actual redact/refuse policy
 * decision — which is the real "something was withheld" signal.
 */
export function checkRepeatWithholdEscalation(
  requesterId: number,
  requesterName: string,
  target: Person,
  recentItemSets: ResponseItem[][], // most recent first
  people: Person[],
): EscalationDraft | null {
  if (requesterId === target.id) return null;
  if (recentItemSets.length < REPEAT_WITHHOLD_THRESHOLD) return null;

  const lastN = recentItemSets.slice(0, REPEAT_WITHHOLD_THRESHOLD);
  const allWithheld = lastN.every((items) => items.some((i) => i.policyRef !== null));
  if (!allWithheld) return null;

  return {
    id: `esc-ESC-REPEAT-WITHHOLD-${requesterId}-${target.id}`,
    kind: 'T2',
    rule: 'ESC-REPEAT-WITHHOLD',
    title: `${requesterName} has been withheld information about ${target.name} ${REPEAT_WITHHOLD_THRESHOLD} times running`,
    detail: `The last ${REPEAT_WITHHOLD_THRESHOLD} real questions ${requesterName} asked about ${target.name} each returned at least one policy-withheld item. Worth checking whether that access boundary is intentional.`,
    personId: target.id,
    evidenceId: null,
    path: computeEscalationPath(target.id, people),
  };
}
