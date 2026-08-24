import { describe, expect, it } from 'vitest';
import { allowedTextOnly, parseRelevantSurfaces } from './orchestrator.js';
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

  it('excludes CANT items even though they are already fully generic', () => {
    const items = [structuralCant('Compensation, performance... are not ingested by any agent.')];
    const { allowed, withheldCount } = allowedTextOnly(items);
    expect(allowed).toEqual([]);
    expect(withheldCount).toBe(1);
  });

  it('a realistic mixed response: only the genuinely allowed items reach the synthesis input', () => {
    const items = [
      allow('Diego shipped the retry handler.'),
      redact('Diego is reviewing PR#2184. Remaining detail withheld — SEN-REV-4.'),
      structuralCant('Compensation, performance, ... are not ingested by any agent.'),
      allow('Diego attended the payments sync.'),
    ];
    const { allowed, withheldCount } = allowedTextOnly(items);
    expect(allowed).toEqual([items[0], items[3]]);
    expect(withheldCount).toBe(2);
  });

  it('empty input produces empty output with zero withheld', () => {
    expect(allowedTextOnly([])).toEqual({ allowed: [], withheldCount: 0 });
  });

  it('all-withheld input produces empty allowed with withheldCount equal to the full length', () => {
    const items = [redact('a'), structuralCant('b'), refuse('c')];
    const { allowed, withheldCount } = allowedTextOnly(items);
    expect(allowed).toEqual([]);
    expect(withheldCount).toBe(3);
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

  it('parses a clean JSON array of recognized keys', () => {
    expect(parseRelevantSurfaces('["github", "jira"]', keys)).toEqual(new Set(['github', 'jira']));
  });

  it('tolerates markdown fences and prose around the array', () => {
    const raw = 'Here you go:\n```json\n["github"]\n```\nHope that helps.';
    expect(parseRelevantSurfaces(raw, keys)).toEqual(new Set(['github']));
  });

  it('drops unrecognized keys but keeps the recognized ones alongside them', () => {
    expect(parseRelevantSurfaces('["github", "salesforce", "jira"]', keys)).toEqual(new Set(['github', 'jira']));
  });

  it('fails open to the full candidate set when every key is unrecognized', () => {
    expect(parseRelevantSurfaces('["salesforce", "workday"]', keys)).toEqual(new Set(keys));
  });

  it('respects a genuine empty array as "nothing is relevant" — not a fail-open case', () => {
    expect(parseRelevantSurfaces('[]', keys)).toEqual(new Set());
  });

  it('fails open to the full candidate set when the JSON is a non-array (an object)', () => {
    expect(parseRelevantSurfaces('{"github": true}', keys)).toEqual(new Set(keys));
  });

  it('fails open to the full candidate set on malformed JSON', () => {
    expect(parseRelevantSurfaces('[github, jira]', keys)).toEqual(new Set(keys));
  });

  it('fails open to the full candidate set when there is no array-like substring at all', () => {
    expect(parseRelevantSurfaces('sure, github and jira seem relevant', keys)).toEqual(new Set(keys));
  });

  it('fails open to the full candidate set on an empty response', () => {
    expect(parseRelevantSurfaces('', keys)).toEqual(new Set(keys));
  });

  it('an empty candidate list produces an empty selection, not a fail-open set', () => {
    expect(parseRelevantSurfaces('["github"]', [])).toEqual(new Set());
  });
});
