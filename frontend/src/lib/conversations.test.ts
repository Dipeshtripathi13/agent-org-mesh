import { describe, expect, it } from 'vitest';
import { relativeTime, turnFromAuditEntry, turnFromPersonalEntry, type RawEntry, type RawPersonalEntry } from './conversations';
import type { ResponseItem } from './api';

/**
 * Pure logic behind "My agent" → "Ask yourself" — reconstructing a chat's turns from the
 * real audit log, and formatting when a chat was last touched. No tests existed for
 * either before this pass, despite every other piece of pure logic touched this session
 * (the backend's parseRelevantSurfaces, providerForApiFamily, buildChatCompletionsRequest)
 * getting them.
 */

const allow = (text: string): ResponseItem => ({ tier: 'T1', text, evidenceId: 'ev-1', policyRef: null });
const wont = (text: string): ResponseItem => ({ tier: 'WONT', text, evidenceId: null, policyRef: 'SEN-REV-4' });
const structuralCant = (text: string): ResponseItem => ({ tier: 'CANT', text, evidenceId: null, policyRef: null });

function entry(overrides: Partial<RawEntry>): RawEntry {
  return {
    id: 'entry-1',
    question: 'What have I been working on?',
    requesterRole: 'Self',
    requesterId: 11,
    targetPersonId: 11,
    createdAt: '2026-08-19T12:00:00.000Z',
    policyRevisionId: 1,
    conversationId: 'chat-1',
    snapshot: {
      targetPersonId: 11,
      requesterRole: 'Self',
      policyRevisionId: 1,
      items: [allow('Shipped the retry handler.')],
      coverage: { percent: 100, missingSurfaces: [], text: 'Answered from all in-scope surfaces.' },
      synthesizedAnswer: 'You shipped the retry handler.',
    },
    ...overrides,
  } as RawEntry;
}

describe('turnFromAuditEntry', () => {
  it('carries the question and the real synthesized answer straight through', () => {
    const turn = turnFromAuditEntry(entry({}));
    expect(turn.id).toBe('entry-1');
    expect(turn.question).toBe('What have I been working on?');
    expect(turn.result?.answer).toBe('You shipped the retry handler.');
    expect(turn.busy).toBe(false);
    expect(turn.error).toBeNull();
  });

  it('recomputes withheldCount from items the same way allowedTextOnly() does on the backend', () => {
    const turn = turnFromAuditEntry(entry({
      snapshot: {
        targetPersonId: 11, requesterRole: 'Self', policyRevisionId: 1,
        items: [allow('a'), wont('b'), structuralCant('c')],
        coverage: { percent: 100, missingSurfaces: [], text: 'x' },
        synthesizedAnswer: 'answer',
      },
    }));
    // 1 allowed (policyRef null, tier !== CANT), 2 withheld (the WONT and the CANT).
    expect(turn.result?.withheldCount).toBe(2);
  });

  it('falls back to joining allowed item text when synthesizedAnswer is missing (a pre-feature row)', () => {
    const turn = turnFromAuditEntry(entry({
      snapshot: {
        targetPersonId: 11, requesterRole: 'Self', policyRevisionId: 1,
        items: [allow('First fact.'), allow('Second fact.'), wont('Hidden.')],
        coverage: { percent: 100, missingSurfaces: [], text: 'x' },
        // synthesizedAnswer intentionally omitted
      },
    }));
    expect(turn.result?.answer).toBe('First fact.\nSecond fact.');
  });

  it('every reconstructed turn starts collapsed and not busy, regardless of stored state', () => {
    const turn = turnFromAuditEntry(entry({}));
    expect(turn.busy).toBe(false);
    expect(turn.error).toBeNull();
  });

  it('carries consultedSources straight through when the snapshot has it', () => {
    const turn = turnFromAuditEntry(entry({
      snapshot: {
        targetPersonId: 11, requesterRole: 'Self', policyRevisionId: 1,
        items: [allow('Shipped the retry handler.')],
        coverage: { percent: 100, missingSurfaces: [], text: 'x' },
        synthesizedAnswer: 'You shipped the retry handler.',
        consultedSources: ['Claude Code', 'Gmail'],
      },
    }));
    expect(turn.result?.consultedSources).toEqual(['Claude Code', 'Gmail']);
  });

  it('defaults consultedSources to an empty array for a pre-feature row that never had it', () => {
    const turn = turnFromAuditEntry(entry({}));
    expect(turn.result?.consultedSources).toEqual([]);
  });
});

describe('turnFromPersonalEntry', () => {
  const personalEntry: RawPersonalEntry = {
    id: 'ask-1',
    conversationId: 'chat-1',
    question: 'What have I been working on?',
    answer: 'You shipped the retry handler.',
    createdAt: '2026-08-19T12:00:00.000Z',
    consultedSources: [],
  };

  it('carries the question and plain-text answer straight through', () => {
    const turn = turnFromPersonalEntry(personalEntry);
    expect(turn.id).toBe('ask-1');
    expect(turn.question).toBe('What have I been working on?');
    expect(turn.result?.answer).toBe('You shipped the retry handler.');
    expect(turn.busy).toBe(false);
    expect(turn.error).toBeNull();
  });

  it('leaves items/withheldCount/coverage at their "nothing to show" defaults', () => {
    const turn = turnFromPersonalEntry(personalEntry);
    expect(turn.result?.items).toEqual([]);
    expect(turn.result?.withheldCount).toBe(0);
    expect(turn.result?.coverage).toEqual({ text: '' });
    expect(turn.result?.consultedSources).toEqual([]);
  });

  it('carries real consultedSources through — the personal ask-bridge\'s own connected-tool picks', () => {
    const turn = turnFromPersonalEntry({ ...personalEntry, consultedSources: ['Linear', 'Notion'] });
    expect(turn.result?.consultedSources).toEqual(['Linear', 'Notion']);
  });

  it('defaults consultedSources to an empty array for a pre-feature row that never had it', () => {
    const { consultedSources: _omit, ...withoutField } = personalEntry;
    const turn = turnFromPersonalEntry(withoutField as RawPersonalEntry);
    expect(turn.result?.consultedSources).toEqual([]);
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-08-19T12:00:00.000Z').getTime();

  it('a timestamp from this instant reads as "just now"', () => {
    expect(relativeTime('2026-08-19T12:00:00.000Z', now)).toBe('just now');
  });

  it('under an hour reads in minutes', () => {
    expect(relativeTime('2026-08-19T11:45:00.000Z', now)).toBe('15m ago');
  });

  it('under a day reads in hours', () => {
    expect(relativeTime('2026-08-19T09:00:00.000Z', now)).toBe('3h ago');
  });

  it('under a week reads in days', () => {
    expect(relativeTime('2026-08-17T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('a week or more falls back to a real calendar date, not an ever-growing day count', () => {
    const result = relativeTime('2026-08-01T12:00:00.000Z', now);
    expect(result).not.toMatch(/ago$/);
    expect(result).toContain('Aug');
  });
});
