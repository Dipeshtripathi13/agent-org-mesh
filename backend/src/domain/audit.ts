import { createHash, randomUUID } from 'node:crypto';
import type { AgentResponse, AuditEntry, RequesterRole } from './types.js';

/**
 * The audit spine.
 *
 * Two properties matter, and both are structural rather than conventions:
 *
 *  1. APPEND-ONLY. `append` is the only mutator exported. There is no update, no
 *     delete, no re-derive. In production the same guarantee is enforced in the
 *     database: the audit schema grants INSERT and revokes UPDATE/DELETE.
 *
 *  2. SNAPSHOTTED. The response is resolved once, at read time, and stored whole.
 *     It is never recomputed from current policy. Recomputing would let a later
 *     policy edit silently rewrite what someone was told last Tuesday — which is
 *     precisely the failure this system exists to prevent.
 */

export interface AppendInput {
  orgId: string;
  requesterId: number;
  requesterRole: RequesterRole;
  targetPersonId: number;
  question: string;
  snapshot: AgentResponse;
  now: string;
}

/**
 * Exported so both the in-memory AuditLog (used directly by the golden tests) and the
 * Postgres-backed repo (used by the running server) hash rows identically — one
 * algorithm, never two copies that could drift apart.
 */
export function hashEntry(entry: Omit<AuditEntry, 'rowHash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: entry.id,
        orgId: entry.orgId,
        requesterId: entry.requesterId,
        targetPersonId: entry.targetPersonId,
        question: entry.question,
        snapshot: entry.snapshot,
        policyRevisionId: entry.policyRevisionId,
        createdAt: entry.createdAt,
        prevHash: entry.prevHash,
      }),
    )
    .digest('hex');
}

/** Detects tampering with a stored row or reordering of the chain, given any row order. */
export function verifyChain(entries: readonly AuditEntry[]): { valid: boolean; brokenAt: number | null } {
  let prevHash: string | null = null;
  for (let i = 0; i < entries.length; i++) {
    const { rowHash, ...rest } = entries[i];
    if (rest.prevHash !== prevHash) return { valid: false, brokenAt: i };
    if (hashEntry(rest) !== rowHash) return { valid: false, brokenAt: i };
    prevHash = rowHash;
  }
  return { valid: true, brokenAt: null };
}

export class AuditLog {
  private entries: AuditEntry[] = [];

  append(input: AppendInput): AuditEntry {
    const prev = this.entries.at(-1) ?? null;
    const base: Omit<AuditEntry, 'rowHash'> = {
      id: randomUUID(),
      orgId: input.orgId,
      requesterId: input.requesterId,
      requesterRole: input.requesterRole,
      targetPersonId: input.targetPersonId,
      question: input.question,
      snapshot: input.snapshot,
      policyRevisionId: input.snapshot.policyRevisionId,
      subjectNotifiedAt: input.now, // subject is notified at the instant of the read
      createdAt: input.now,
      prevHash: prev?.rowHash ?? null,
    };
    const entry: AuditEntry = { ...base, rowHash: hashEntry(base) };
    this.entries.push(entry);
    return entry;
  }

  /** Read-only view. Callers get copies; the chain cannot be edited from outside. */
  list(): readonly AuditEntry[] {
    return this.entries.map((e) => structuredClone(e));
  }

  forSubject(personId: number): readonly AuditEntry[] {
    return this.list().filter((e) => e.targetPersonId === personId);
  }

  /** Detects any tampering with a stored entry or reordering of the chain. */
  verify(): { valid: boolean; brokenAt: number | null } {
    return verifyChain(this.entries);
  }
}
