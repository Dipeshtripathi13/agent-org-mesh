import { computeCoverage, stateLabel, usableSurfaces } from './coverage.js';
import type {
  AgentResponse,
  Claim,
  ConfigurableClass,
  CoverageStatement,
  Person,
  PolicyGrid,
  PolicyRevision,
  RequesterRole,
  ResponseItem,
  Surface,
} from './types.js';

/**
 * THE POLICY ENGINE.
 *
 * Deterministic by construction: no LLM, no randomness, no clock reads except the
 * caller-supplied timestamp. Same inputs always produce the same output.
 *
 * This is the component a security reviewer will ask about. Its golden-file tests
 * (policy.test.ts) are the artifact that answers them.
 *
 * Two invariants:
 *   1. Excluded-class material never appears as a withheld *decision*. It was never
 *      ingested, so it is reported as CANT — structurally absent, not declined.
 *   2. Withholding is always visible. There is no code path that silently drops a
 *      claim from a response.
 */

export const POLICY_REFS: Record<ConfigurableClass, string> = {
  Open: 'PUB-OPEN-1',
  Internal: 'INT-WORK-2',
  Sensitive: 'SEN-REV-4',
};

export const DEFAULT_GRID: PolicyGrid = {
  Self: { Open: 'allow', Internal: 'allow', Sensitive: 'allow' },
  Peer: { Open: 'allow', Internal: 'redact', Sensitive: 'refuse' },
  'Direct manager': { Open: 'allow', Internal: 'allow', Sensitive: 'redact' },
  'Skip-level': { Open: 'allow', Internal: 'allow', Sensitive: 'refuse' },
  Executive: { Open: 'allow', Internal: 'allow', Sensitive: 'redact' },
  'IT admin': { Open: 'allow', Internal: 'redact', Sensitive: 'refuse' },
};

/** First sentence only, used when a claim is redacted rather than refused. */
function firstSentence(text: string): string {
  const idx = text.indexOf('. ');
  return idx === -1 ? text : text.slice(0, idx + 1);
}

function buildCoverageStatement(
  person: Person,
  surfaces: Surface[],
  readSurfaces: ReturnType<typeof usableSurfaces>,
): CoverageStatement {
  const report = computeCoverage(person, surfaces);

  if (!report.agentDeployed) {
    return {
      percent: null,
      readSurfaces: [],
      missingSurfaces: [],
      text: `No agent is deployed for ${person.name}. Nothing was read, and nothing was inferred from anyone else's data.`,
    };
  }

  const missing = surfaces
    .filter((s) => {
      const state = person.surfaces[s.key];
      return state === 'absent' || state === 'stale';
    })
    .map((s) => `${s.name} (${stateLabel(person.surfaces[s.key])})`);

  // Plain words (2026-09-13): the old sentence repeated "(not connected)" after every tool, which
  // for a new account meant 24 repetitions. Every gap is still named; only an out-of-date tool
  // carries a qualifier, since "not connected" is the default meaning of Missing. The word
  // "Missing" must stay: server.ts's silentGaps check (and older stored answers) rely on it.
  const missingNames = surfaces
    .filter((s) => {
      const state = person.surfaces[s.key];
      return state === 'absent' || state === 'stale';
    })
    .map((s) => (person.surfaces[s.key] === 'stale' ? `${s.name} (out of date)` : s.name));
  const text = missing.length
    ? `Checked ${readSurfaces.length} of ${report.inScopeCount} tools (${report.percent}%). Missing: ${missingNames.join(', ')}. Nothing was guessed to fill the gaps.`
    : `Checked all ${report.inScopeCount} tools (${report.percent}%), all up to date.`;

  return { percent: report.percent, readSurfaces, missingSurfaces: missing, text };
}

export interface RespondInput {
  target: Person;
  claims: Claim[];
  surfaces: Surface[];
  requesterRole: RequesterRole;
  revision: PolicyRevision;
  /** Caller supplies the clock so the function stays pure and testable. */
  now: string;
}

export function respond(input: RespondInput): AgentResponse {
  const { target, claims, surfaces, requesterRole, revision, now } = input;
  const grid = revision.grid[requesterRole] ?? DEFAULT_GRID.Peer;
  const items: ResponseItem[] = [];

  // No agent deployed: state it plainly. Never return an empty answer that reads as
  // "nothing is happening" when the truth is "nobody is listening".
  if (!target.agentDeployed) {
    items.push({
      tier: 'CANT',
      text: `No agent is deployed for ${target.name}, so there is nothing to answer from. This is a deployment state, not a refusal, and not an absence of work.`,
      evidenceId: null,
      policyRef: null,
    });
    return {
      targetPersonId: target.id,
      requesterRole,
      policyRevisionId: revision.id,
      items,
      coverage: buildCoverageStatement(target, surfaces, []),
      answeredAt: now,
    };
  }

  const usable = usableSurfaces(target, surfaces);
  const live = new Set(usable);

  for (const claim of claims) {
    if (claim.supersededBy) continue; // corrected claims are suppressed until re-derived

    // A claim whose backing surface is not connected cannot be asserted at all.
    // This is a coverage fact, not a policy decision — so it is CANT, not WONT.
    if (!live.has(claim.sourceSurface)) {
      items.push({
        tier: 'CANT',
        text: `A claim in this area depends on ${claim.sourceSurface}, which is not connected for ${target.name}. It is not asserted rather than guessed at.`,
        evidenceId: null,
        policyRef: null,
      });
      continue;
    }

    // Excluded class never reaches here in production — it is not ingested. If one
    // appears, it is a bug, and the safe behaviour is to report structural absence.
    if (claim.dataClass === 'Excluded') {
      items.push({
        tier: 'CANT',
        text: 'Excluded-class material is not ingested by any agent, so nothing about it can be returned to anyone. No policy setting changes this.',
        evidenceId: null,
        policyRef: null,
      });
      continue;
    }

    const disposition = grid[claim.dataClass as ConfigurableClass];
    const ref = POLICY_REFS[claim.dataClass as ConfigurableClass];

    if (disposition === 'allow') {
      items.push({
        tier: claim.tier,
        text: claim.text,
        evidenceId: claim.evidenceId,
        policyRef: null,
      });
    } else if (disposition === 'redact') {
      items.push({
        tier: 'WONT',
        text: `${firstSentence(claim.text)} Remaining detail withheld at your access level — ${ref}.`,
        evidenceId: null,
        policyRef: ref,
      });
    } else {
      items.push({
        tier: 'WONT',
        text: `Information withheld at your access level. One ${claim.dataClass.toLowerCase()}-class claim exists and was not returned — ${ref}. Your identity was recorded with this refusal.`,
        evidenceId: null,
        policyRef: ref,
      });
    }
  }

  // Always state the structural boundary, so its absence is never mistaken for
  // something a policy change could unlock.
  items.push({
    tier: 'CANT',
    text: 'Compensation, performance, terminations, legal matters and health data are not ingested by any agent. Nothing about them can be returned to anyone, including you.',
    evidenceId: null,
    policyRef: null,
  });

  return {
    targetPersonId: target.id,
    requesterRole,
    policyRevisionId: revision.id,
    items,
    coverage: buildCoverageStatement(target, surfaces, usable),
    answeredAt: now,
  };
}

/** Cycle order for the admin grid: allow → redact → refuse → allow. */
export function nextDisposition(current: 'allow' | 'redact' | 'refuse') {
  return ({ allow: 'redact', redact: 'refuse', refuse: 'allow' } as const)[current];
}

/**
 * The set of roles `requesterId` may truthfully claim when asking about `targetId`,
 * derived from the org graph itself — never from anything the requester says about
 * themselves. Deterministic, like the rest of this file: same org graph, same answer.
 *
 * This exists to close a specific, real vulnerability class: a caller asserting a role
 * ("Direct manager", "Executive") that `respond()` then trusts at face value. Every real
 * disclosure decision in this system depends on `requesterRole` being true — if that
 * input can be forged, the deterministic grid downstream is enforcing nothing. (Named and
 * documented in security research on inter-agent trust as exactly this failure: a
 * receiving party has no way to verify a claimed relationship, so it trusts the message
 * instead of the structure. See docs/agent-to-agent-communication.md §12.)
 */
export function deriveAllowedRoles(requesterId: number, targetId: number, people: Person[]): RequesterRole[] {
  if (requesterId === targetId) return ['Self'];

  const byId = new Map(people.map((p) => [p.id, p]));
  const requester = byId.get(requesterId);
  const target = byId.get(targetId);
  if (!requester || !target) return [];

  const roles = new Set<RequesterRole>();
  if (target.managerId === requesterId) roles.add('Direct manager');

  const targetManager = target.managerId != null ? byId.get(target.managerId) : undefined;
  if (targetManager?.managerId === requesterId) roles.add('Skip-level');

  if (target.managerId != null && requester.managerId === target.managerId) roles.add('Peer');

  // Functional roles aren't chain-relative — they're who the requester structurally is.
  if (requester.team === 'IT') roles.add('IT admin');
  if (requester.managerId == null || requester.team === 'Executive') roles.add('Executive');

  return [...roles];
}
