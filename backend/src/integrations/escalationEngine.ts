import { computeCoverage } from '../domain/coverage.js';
import {
  checkCoverageEscalation,
  checkRepeatWithholdEscalation,
  checkStaleClaimEscalation,
  REPEAT_WITHHOLD_THRESHOLD,
} from '../domain/escalations.js';
import type { Claim, Person, Surface } from '../domain/types.js';
import * as repo from '../db/repo.js';

/**
 * Runs the three deterministic escalation checks (domain/escalations.ts) for one real ask
 * and upserts whatever fires. Deliberately reuses data the caller already fetched
 * (target/people/surfaces/claims) rather than re-querying — this always runs right next to
 * respond() in server.ts, which already has all of it in hand. See docs/escalation-triage.md.
 */
export async function runEscalationChecks(input: {
  orgId: number;
  requesterId: number;
  target: Person;
  people: Person[];
  surfaces: Surface[];
  claims: Claim[];
  now?: Date;
}): Promise<void> {
  const { orgId, requesterId, target, people, surfaces, claims, now = new Date() } = input;

  const coverage = computeCoverage(target, surfaces);
  const coverageDraft = checkCoverageEscalation(target, coverage, people);
  if (coverageDraft) await repo.upsertEscalationDraft(orgId, coverageDraft);

  const mostRecentClaimAt = claims
    .filter((c) => !c.supersededBy)
    .reduce<string | null>((latest, c) => (!latest || c.derivedAt > latest ? c.derivedAt : latest), null);
  const staleDraft = checkStaleClaimEscalation(target, mostRecentClaimAt, now, people);
  if (staleDraft) await repo.upsertEscalationDraft(orgId, staleDraft);

  if (requesterId && requesterId !== target.id) {
    const recent = await repo.getRecentAuditForPair(requesterId, target.id, REPEAT_WITHHOLD_THRESHOLD);
    const requesterName = people.find((p) => p.id === requesterId)?.name ?? `person ${requesterId}`;
    const repeatDraft = checkRepeatWithholdEscalation(
      requesterId,
      requesterName,
      target,
      recent.map((e) => e.snapshot.items),
      people,
    );
    if (repeatDraft) await repo.upsertEscalationDraft(orgId, repeatDraft);
  }
}
