import { describe, expect, it } from 'vitest';
import { AuditLog, hashEntry, verifyChain } from './audit.js';
import type { AgentResponse, AuditEntry } from './types.js';

/**
 * The audit spine's golden tests — CLAUDE.md rule 2 in test form: append-only,
 * hash-chained, tamper-evident. Nothing here existed before this pass despite audit.ts
 * being named directly in CLAUDE.md's "correctness core... this is what the golden tests
 * exercise." That gap is what this file closes.
 */

function snapshot(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    targetPersonId: 11,
    requesterRole: 'Direct manager',
    policyRevisionId: 1,
    items: [{ tier: 'T1', text: 'a real claim', evidenceId: 'ev-1', policyRef: null }],
    coverage: { percent: 100, readSurfaces: ['github'], missingSurfaces: [], text: 'all good' },
    answeredAt: '2026-08-13T09:00:00.000Z',
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<AuditLog['append']>[0]> = {}) {
  return {
    orgId: 'northbeam',
    requesterId: 10,
    requesterRole: 'Direct manager' as const,
    targetPersonId: 11,
    question: 'what happened this week?',
    snapshot: snapshot(),
    now: '2026-08-13T09:00:00.000Z',
    ...overrides,
  };
}

describe('hashEntry — determinism', () => {
  it('produces the same hash for the same input, called twice', () => {
    const log = new AuditLog();
    const entry = log.append(baseInput());
    const { rowHash, ...rest } = entry;
    expect(hashEntry(rest)).toBe(hashEntry(rest));
    expect(hashEntry(rest)).toBe(rowHash);
  });

  it('changes when the snapshot changes', () => {
    const log = new AuditLog();
    const entry = log.append(baseInput());
    const { rowHash: _drop, ...rest } = entry;
    const tampered = { ...rest, snapshot: snapshot({ requesterRole: 'Executive' }) };
    expect(hashEntry(tampered)).not.toBe(rowHash(entry));
  });

  it('changes when the question changes', () => {
    const log = new AuditLog();
    const entry = log.append(baseInput());
    const { rowHash: _drop, ...rest } = entry;
    expect(hashEntry({ ...rest, question: 'a different question' })).not.toBe(entry.rowHash);
  });

  it('changes when prevHash changes', () => {
    const log = new AuditLog();
    const entry = log.append(baseInput());
    const { rowHash: _drop, ...rest } = entry;
    expect(hashEntry({ ...rest, prevHash: 'some-other-hash' })).not.toBe(entry.rowHash);
  });
});

function rowHash(e: AuditEntry) {
  return e.rowHash;
}

describe('AuditLog.append — chain construction', () => {
  it('the first entry has prevHash null', () => {
    const log = new AuditLog();
    const entry = log.append(baseInput());
    expect(entry.prevHash).toBeNull();
  });

  it('each subsequent entry chains to the previous row hash', () => {
    const log = new AuditLog();
    const a = log.append(baseInput());
    const b = log.append(baseInput({ question: 'second question' }));
    const c = log.append(baseInput({ question: 'third question' }));
    expect(b.prevHash).toBe(a.rowHash);
    expect(c.prevHash).toBe(b.rowHash);
  });

  it('subjectNotifiedAt is set to the same instant as the read (now)', () => {
    const log = new AuditLog();
    const entry = log.append(baseInput({ now: '2026-08-13T10:15:00.000Z' }));
    expect(entry.subjectNotifiedAt).toBe('2026-08-13T10:15:00.000Z');
  });

  it('policyRevisionId is taken from the snapshot, not the input directly', () => {
    const log = new AuditLog();
    const entry = log.append(baseInput({ snapshot: snapshot({ policyRevisionId: 42 }) }));
    expect(entry.policyRevisionId).toBe(42);
  });

  it('each appended entry gets a unique id', () => {
    const log = new AuditLog();
    const a = log.append(baseInput());
    const b = log.append(baseInput());
    expect(a.id).not.toBe(b.id);
  });
});

describe('AuditLog.list / forSubject — read-only views', () => {
  it('list() returns copies — mutating a returned entry does not affect the log', () => {
    const log = new AuditLog();
    log.append(baseInput());
    const first = log.list()[0] as any;
    first.question = 'mutated from outside';
    expect(log.list()[0].question).toBe('what happened this week?');
  });

  it('forSubject filters to only entries about that target', () => {
    const log = new AuditLog();
    log.append(baseInput({ targetPersonId: 11 }));
    log.append(baseInput({ targetPersonId: 25 }));
    log.append(baseInput({ targetPersonId: 11 }));
    expect(log.forSubject(11)).toHaveLength(2);
    expect(log.forSubject(25)).toHaveLength(1);
    expect(log.forSubject(11).every((e) => e.targetPersonId === 11)).toBe(true);
  });
});

describe('verifyChain — tamper detection', () => {
  it('an untampered chain of any length verifies valid', () => {
    const log = new AuditLog();
    log.append(baseInput());
    log.append(baseInput({ question: 'q2' }));
    log.append(baseInput({ question: 'q3' }));
    expect(verifyChain(log.list())).toEqual({ valid: true, brokenAt: null });
  });

  it('an empty chain verifies valid', () => {
    expect(verifyChain([])).toEqual({ valid: true, brokenAt: null });
  });

  it('detects a tampered snapshot on a stored row, reporting the correct index', () => {
    const log = new AuditLog();
    log.append(baseInput());
    log.append(baseInput({ question: 'q2' }));
    const entries = log.list().map((e) => ({ ...e })) as AuditEntry[];
    entries[1] = { ...entries[1], snapshot: snapshot({ requesterRole: 'Executive' }) };
    expect(verifyChain(entries)).toEqual({ valid: false, brokenAt: 1 });
  });

  it('detects a tampered question, without touching the snapshot', () => {
    const log = new AuditLog();
    log.append(baseInput());
    const entries = log.list().map((e) => ({ ...e })) as AuditEntry[];
    entries[0] = { ...entries[0], question: 'a forged question' };
    expect(verifyChain(entries).valid).toBe(false);
  });

  it('detects reordering the chain (swapping two entries)', () => {
    const log = new AuditLog();
    log.append(baseInput({ question: 'q1' }));
    log.append(baseInput({ question: 'q2' }));
    const entries = log.list().map((e) => ({ ...e })) as AuditEntry[];
    [entries[0], entries[1]] = [entries[1], entries[0]];
    expect(verifyChain(entries).valid).toBe(false);
  });

  it('detects a row deleted from the middle of the chain', () => {
    const log = new AuditLog();
    log.append(baseInput({ question: 'q1' }));
    log.append(baseInput({ question: 'q2' }));
    log.append(baseInput({ question: 'q3' }));
    const entries = log.list() as AuditEntry[];
    const withGap = [entries[0], entries[2]]; // drop the middle row
    expect(verifyChain(withGap).valid).toBe(false);
  });

  /**
   * Documents the real, current boundary of what the hash actually covers — found while
   * writing these tests, not assumed. `hashEntry` hashes `entry.snapshot` (which happens
   * to carry `requesterRole` internally, since it's also a field of AgentResponse) but
   * never reads the top-level `entry.requesterRole`/`entry.subjectNotifiedAt` at all.
   * Real application code always sets both consistently from the same value, so this
   * never fires in practice — but it means a hand-edited top-level `requesterRole` column
   * (leaving the `snapshot` JSON untouched) would NOT be caught by verifyChain. This is a
   * deliberate boundary to leave alone here: broadening the hashed field set would change
   * hashEntry's output for every already-persisted row, which would make every real
   * historical audit_log row in the live database fail verification — a false "tampered"
   * signal, which is a worse outcome than the narrow gap this test documents. Widening the
   * hash needs its own deliberate, versioned migration, not a silent algorithm change.
   */
  it('does NOT detect tampering with the top-level requesterRole field alone (documented gap, not a regression)', () => {
    const log = new AuditLog();
    const entry = log.append(baseInput({ requesterRole: 'Direct manager' }));
    const tampered: AuditEntry = { ...entry, requesterRole: 'Executive' };
    expect(verifyChain([tampered]).valid).toBe(true);
  });
});
