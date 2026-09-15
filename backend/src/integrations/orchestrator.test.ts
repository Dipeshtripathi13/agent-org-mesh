import { describe, expect, it } from 'vitest';
import { DEFAULT_SINCE_DAYS, allowedTextOnly, parseRelevantSurfaces } from './orchestrator.js';
import type { ResponseItem } from '../domain/types.js';

/**
 * Named in docs/agent-to-agent-communication.md §5 as "the single most security-critical
 * function in the 'ask anything' feature" — the filter that keeps redacted/refused text
 * out of the LLM synthesis prompt. Had zero tests before this pass despite that framing.
 */

const allow = (text: string): ResponseItem => ({ tier: 'T1', text, evidenceId: 'ev-1', policyRef: null });
const redact = (text: string): ResponseItem => ({ tier: 'WONT', text, evidenceId: null, policyRef: 'SEN-REV-4' });
const refuse = (text: string): ResponseItem => ({ tier: 'WONT', text, evidenceId: null, policyRef: 'SEN-REV-4' });
const structuralCant = (text: string): ResponseItem => ({ tier: 'CANT', text, evidenceId: null, policyRef: null });

describe('allowedTextOnly', () => {
  it('passes through allow-disposition items (policyRef null, real tier)', () => {
    const items = [allow('a real fact')];
    const { allowed, withheldCount } = allowedTextOnly(items);
    expect(allowed).toEqual(items);
    expect(withheldCount).toBe(0);
  });

  it('excludes WONT items from a redact disposition — this is the one real sentence a human list shows but an LLM must never see', () => {
    const items = [redact('First sentence, real. Remaining detail withheld — SEN-REV-4.')];
    const { allowed, withheldCount } = allowedTextOnly(items);
    expect(allowed).toEqual([]);
    expect(withheldCount).toBe(1);
  });

  it('excludes WONT items from a refuse disposition', () => {
    const items = [refuse('Information withheld at your access level.')];
    expect(allowedTextOnly(items).allowed).toEqual([]);
  });

  // Deliberately changed 2026-09-15: a CANT item used to count as withheld, so every answer
  // said "1 item withheld" because of the standard never-collected notice. Rule 4: withheld and
  // never collected are different things and are counted separately.
  it('excludes CANT items from the synthesis input, and counts them as never collected, not withheld', () => {
    const items = [structuralCant('Compensation, performance... are not ingested by any agent.')];
    const { allowed, withheldCount, neverCollectedCount } = allowedTextOnly(items);
    expect(allowed).toEqual([]);
    expect(withheldCount).toBe(0);
    expect(neverCollectedCount).toBe(1);
  });

  it('a realistic mixed response: only the genuinely allowed items reach the synthesis input', () => {
    const items = [
      allow('Diego shipped the retry handler.'),
      redact('Diego is reviewing PR#2184. Remaining detail withheld — SEN-REV-4.'),
      structuralCant('Compensation, performance, ... are not ingested by any agent.'),
      allow('Diego attended the payments sync.'),
    ];
    const { allowed, withheldCount, neverCollectedCount } = allowedTextOnly(items);
    expect(allowed).toEqual([items[0], items[3]]);
    expect(withheldCount).toBe(1);
    expect(neverCollectedCount).toBe(1);
  });

  it('empty input produces empty output with zero withheld', () => {
    expect(allowedTextOnly([])).toEqual({ allowed: [], withheldCount: 0, neverCollectedCount: 0 });
  });

  it('nothing allowed: withheld and never-collected together account for every item', () => {
    const items = [redact('a'), structuralCant('b'), refuse('c')];
    const { allowed, withheldCount, neverCollectedCount } = allowedTextOnly(items);
    expect(allowed).toEqual([]);
    expect(withheldCount).toBe(2);
    expect(neverCollectedCount).toBe(1);
  });

  it('never mutates the input array', () => {
    const items = [allow('a'), redact('b')];
    const snapshot = JSON.stringify(items);
    allowedTextOnly(items);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});

/**
 * The tool-selection router's failure mode has to be "gather everything" — the same
 * behavior as before the router existed — never "silently gather nothing." Every case
 * here that isn't a clean, valid array must fail open to the full candidate set — except
 * a clean, valid *empty* array, which is the router's own deliberate "nothing is
 * relevant" and is respected as an empty selection, not a failure.
 */
describe('parseRelevantSurfaces', () => {
  const keys = ['github', 'jira', 'claude-code'];
  const fullSet = (days = DEFAULT_SINCE_DAYS) => new Map(keys.map((k) => [k, days]));

  it('parses a clean JSON array of {surfaceKey, sinceDays} objects', () => {
    const raw = '[{"surfaceKey": "github", "sinceDays": 7}, {"surfaceKey": "jira", "sinceDays": 1}]';
    expect(parseRelevantSurfaces(raw, keys)).toEqual(new Map([['github', 7], ['jira', 1]]));
  });

  it('falls back to the default window for a bare surfaceKey string entry (a weaker model ignoring the richer shape)', () => {
    expect(parseRelevantSurfaces('["github", "jira"]', keys)).toEqual(new Map([['github', DEFAULT_SINCE_DAYS], ['jira', DEFAULT_SINCE_DAYS]]));
  });

  it('tolerates markdown fences and prose around the array', () => {
    const raw = 'Here you go:\n```json\n[{"surfaceKey": "github", "sinceDays": 1}]\n```\nHope that helps.';
    expect(parseRelevantSurfaces(raw, keys)).toEqual(new Map([['github', 1]]));
  });

  it('clamps an out-of-range sinceDays into [1, 365]', () => {
    const raw = '[{"surfaceKey": "github", "sinceDays": 9000}, {"surfaceKey": "jira", "sinceDays": -5}]';
    expect(parseRelevantSurfaces(raw, keys)).toEqual(new Map([['github', 365], ['jira', 1]]));
  });

  it('falls back to the default window when sinceDays is missing or not a number', () => {
    const raw = '[{"surfaceKey": "github"}, {"surfaceKey": "jira", "sinceDays": "soon"}]';
    expect(parseRelevantSurfaces(raw, keys)).toEqual(new Map([['github', DEFAULT_SINCE_DAYS], ['jira', DEFAULT_SINCE_DAYS]]));
  });

  it('drops unrecognized keys but keeps the recognized ones alongside them', () => {
    const raw = '[{"surfaceKey": "github", "sinceDays": 7}, {"surfaceKey": "salesforce", "sinceDays": 7}, {"surfaceKey": "jira", "sinceDays": 1}]';
    expect(parseRelevantSurfaces(raw, keys)).toEqual(new Map([['github', 7], ['jira', 1]]));
  });

  it('fails open to the full candidate set, generous default, when every key is unrecognized', () => {
    const raw = '[{"surfaceKey": "salesforce", "sinceDays": 1}, {"surfaceKey": "workday", "sinceDays": 1}]';
    expect(parseRelevantSurfaces(raw, keys)).toEqual(fullSet());
  });

  it('respects a genuine empty array as "nothing is relevant" — not a fail-open case', () => {
    expect(parseRelevantSurfaces('[]', keys)).toEqual(new Map());
  });

  it('fails open to the full candidate set when the JSON is a non-array (an object)', () => {
    expect(parseRelevantSurfaces('{"github": true}', keys)).toEqual(fullSet());
  });

  it('fails open to the full candidate set on malformed JSON', () => {
    expect(parseRelevantSurfaces('[github, jira]', keys)).toEqual(fullSet());
  });

  it('fails open to the full candidate set when there is no array-like substring at all', () => {
    expect(parseRelevantSurfaces('sure, github and jira seem relevant', keys)).toEqual(fullSet());
  });

  it('fails open to the full candidate set on an empty response', () => {
    expect(parseRelevantSurfaces('', keys)).toEqual(fullSet());
  });

  it('an empty candidate list produces an empty selection, not a fail-open set', () => {
    expect(parseRelevantSurfaces('[{"surfaceKey": "github", "sinceDays": 1}]', [])).toEqual(new Map());
  });
});
