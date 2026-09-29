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

/** What kind of trouble a chain is in. Only `altered` means someone changed a stored row;
 *  the rest is structural damage from the ordering defect fixed by migration 0009, which is
 *  permanent because audit rows can never be rewritten. Telling those apart is the whole
 *  point — an operator seeing a failed check needs to know which one they are looking at. */
export interface ChainDiagnosis {
  /** Does the chain verify in the order given? */
  ok: boolean;
  entries: number;
  /** Ids of rows whose stored hash doesn't match their own contents. Real tampering. */
  altered: string[];
  /** prevHash values claimed by more than one row — the chain forks and stops being a chain. */
  forkedAt: string[];
  /** Ids of rows pointing at a hash no row in this set has. */
  orphans: string[];
  /** Rows claiming to start the chain. Healthy is exactly 1 (or 0 for an empty log). */
  roots: number;
  /** Every link is sound and they form one sequence — only the order handed in was wrong.
   *  Benign, and what the pre-0009 read order produced. */
  reorderable: boolean;
}

/** Read-only. Explains *why* verifyChain failed, without ever touching a row. */
export function diagnoseChain(entries: readonly AuditEntry[]): ChainDiagnosis {
  const ok = verifyChain(entries).valid;
  const altered: string[] = [];
  for (const entry of entries) {
    const { rowHash, ...rest } = entry;
    if (hashEntry(rest) !== rowHash) altered.push(entry.id);
  }

  const byPrev = new Map<string | null, AuditEntry[]>();
  for (const entry of entries) {
    const list = byPrev.get(entry.prevHash) ?? [];
    list.push(entry);
    byPrev.set(entry.prevHash, list);
  }
  const forkedAt = [...byPrev.entries()]
    .filter(([prev, rows]) => prev !== null && rows.length > 1)
    .map(([prev]) => prev as string);
  const roots = (byPrev.get(null) ?? []).length;

  const hashes = new Set(entries.map((e) => e.rowHash));
  const orphans = entries.filter((e) => e.prevHash !== null && !hashes.has(e.prevHash)).map((e) => e.id);

  // Sound links plus one root and no forks means the rows themselves are fine and only the
  // order they were handed in was wrong — walk it to be sure it reaches every row.
  let reorderable = false;
  if (!ok && altered.length === 0 && orphans.length === 0 && forkedAt.length === 0 && roots === 1) {
    const next = new Map(entries.map((e) => [e.prevHash, e] as const));
    let cursor = next.get(null);
    let reached = 0;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      reached += 1;
      cursor = next.get(cursor.rowHash);
    }
    reorderable = reached === entries.length;
  }

  return { ok, entries: entries.length, altered, forkedAt, orphans, roots, reorderable };
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
