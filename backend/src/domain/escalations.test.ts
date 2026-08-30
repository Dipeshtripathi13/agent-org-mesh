import { describe, expect, it } from 'vitest';
import {
  checkCoverageEscalation,
  checkRepeatWithholdEscalation,
  checkStaleClaimEscalation,
  computeEscalationAge,
  computeEscalationPath,
  REPEAT_WITHHOLD_THRESHOLD,
  STALE_CLAIM_DAYS,
} from './escalations.js';
import { PEOPLE } from '../data/seed.js';
import type { CoverageReport, Person, ResponseItem } from './types.js';

const NOW = new Date('2026-08-13T09:41:07.000Z');

function person(overrides: Partial<Person> = {}): Person {
  return {
    id: 900, name: 'Test Person', title: 'Engineer', team: 'Payments',
    managerId: null, agentDeployed: true,
    surfaces: {
      github: 'connected', jira: 'connected', salesforce: 'outOfScope', calendar: 'connected', slack: 'connected', confluence: 'connected',
      linear: 'outOfScope', notion: 'outOfScope', asana: 'outOfScope', gitlab: 'outOfScope', hubspot: 'outOfScope', zendesk: 'outOfScope',
      trello: 'outOfScope', airtable: 'outOfScope', monday: 'outOfScope', figma: 'outOfScope', discord: 'outOfScope',
      microsoft365: 'outOfScope', zoom: 'outOfScope', dropbox: 'outOfScope',
      'claude-code': 'outOfScope', codex: 'outOfScope', 'gemini-cli': 'outOfScope',
    },
    ...overrides,
  };
}

function coverage(overrides: Partial<CoverageReport> = {}): CoverageReport {
  return { personId: 900, percent: 100, inScopeCount: 4, connectedCount: 4, gaps: [], agentDeployed: true, ...overrides };
}

function items(withheld: boolean): ResponseItem[] {
  const structuralCant: ResponseItem = {
    tier: 'CANT', policyRef: null, evidenceId: null,
    text: 'Compensation, performance, terminations, legal matters and health data are not ingested by any agent.',
  };
  if (!withheld) return [structuralCant, { tier: 'T1', policyRef: null, evidenceId: 'ev-1', text: 'a real allowed claim' }];
  return [structuralCant, { tier: 'WONT', policyRef: 'SEN-REV-4', evidenceId: null, text: 'withheld at your access level' }];
}

describe('computeEscalationPath', () => {
  it('walks the real org chart: target, manager, skip-level', () => {
    // Diego (11) -> Hana (10) -> Sofia (8), the exact chain seed.ts's original esc-1 used.
    expect(computeEscalationPath(11, PEOPLE)).toEqual([
      { personId: 11, name: 'Diego Okonjo' },
      { personId: 10, name: 'Hana Oyelaran' },
      { personId: 8, name: 'Sofia Almeida' },
    ]);
  });

  it('stops at the top of the chain without padding', () => {
    // Marta (1) is CEO, managerId null — path is just her.
    expect(computeEscalationPath(1, PEOPLE)).toEqual([{ personId: 1, name: 'Marta Vieira' }]);
  });

  it('returns empty for an unknown id', () => {
    expect(computeEscalationPath(999999, PEOPLE)).toEqual([]);
  });
});

describe('computeEscalationAge', () => {
  it('computes whole days elapsed', () => {
    const createdAt = new Date(NOW.getTime() - 11 * 86_400_000).toISOString();
    expect(computeEscalationAge(createdAt, NOW)).toBe(11);
  });

  it('never goes negative for a timestamp in the future', () => {
    const createdAt = new Date(NOW.getTime() + 86_400_000).toISOString();
    expect(computeEscalationAge(createdAt, NOW)).toBe(0);
  });
});

describe('checkCoverageEscalation — ESC-COVERAGE', () => {
  it('fires when deployed with zero connected in-scope surfaces', () => {
    const p = person({ agentDeployed: true });
    const draft = checkCoverageEscalation(p, coverage({ connectedCount: 0, inScopeCount: 4 }), PEOPLE);
    expect(draft).not.toBeNull();
    expect(draft?.rule).toBe('ESC-COVERAGE');
    expect(draft?.kind).toBe('CANT');
    expect(draft?.id).toBe('esc-ESC-COVERAGE-900');
  });

  it('does not fire when at least one surface is connected', () => {
    const p = person();
    expect(checkCoverageEscalation(p, coverage({ connectedCount: 1 }), PEOPLE)).toBeNull();
  });

  it('does not fire when no agent is deployed — that is a deployment state, not a gap', () => {
    const p = person({ agentDeployed: false });
    expect(checkCoverageEscalation(p, coverage({ agentDeployed: false, percent: null, connectedCount: 0, inScopeCount: 0 }), PEOPLE)).toBeNull();
  });

  it('does not fire when nothing was ever in scope', () => {
    const p = person();
    expect(checkCoverageEscalation(p, coverage({ connectedCount: 0, inScopeCount: 0 }), PEOPLE)).toBeNull();
  });
});

describe('checkStaleClaimEscalation — ESC-STALE-CLAIM', () => {
  it(`fires when the most recent claim is >= ${STALE_CLAIM_DAYS} days old`, () => {
    const p = person();
    const derivedAt = new Date(NOW.getTime() - 8 * 86_400_000).toISOString();
    const draft = checkStaleClaimEscalation(p, derivedAt, NOW, PEOPLE);
    expect(draft?.rule).toBe('ESC-STALE-CLAIM');
    expect(draft?.kind).toBe('T2');
    expect(draft?.detail).toContain('8 days old');
  });

  it('does not fire just under the threshold', () => {
    const p = person();
    const derivedAt = new Date(NOW.getTime() - (STALE_CLAIM_DAYS - 1) * 86_400_000).toISOString();
    expect(checkStaleClaimEscalation(p, derivedAt, NOW, PEOPLE)).toBeNull();
  });

  it('does not fire when there has never been a claim — that is ESC-COVERAGE\'s job', () => {
    const p = person();
    expect(checkStaleClaimEscalation(p, null, NOW, PEOPLE)).toBeNull();
  });

  it('does not fire when no agent is deployed', () => {
    const p = person({ agentDeployed: false });
    const derivedAt = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    expect(checkStaleClaimEscalation(p, derivedAt, NOW, PEOPLE)).toBeNull();
  });
});

describe('checkRepeatWithholdEscalation — ESC-REPEAT-WITHHOLD', () => {
  it(`fires when the last ${REPEAT_WITHHOLD_THRESHOLD} real asks each withheld something`, () => {
    const target = person({ id: 901 });
    const recent = [items(true), items(true), items(true)];
    const draft = checkRepeatWithholdEscalation(11, 'Diego Okonjo', target, recent, PEOPLE);
    expect(draft?.rule).toBe('ESC-REPEAT-WITHHOLD');
    expect(draft?.personId).toBe(901);
    expect(draft?.id).toBe('esc-ESC-REPEAT-WITHHOLD-11-901');
  });

  it('does not fire if any of the last N asks was fully allowed', () => {
    const target = person({ id: 901 });
    const recent = [items(true), items(false), items(true)];
    expect(checkRepeatWithholdEscalation(11, 'Diego Okonjo', target, recent, PEOPLE)).toBeNull();
  });

  it('does not fire with fewer than the threshold of real asks on record', () => {
    const target = person({ id: 901 });
    expect(checkRepeatWithholdEscalation(11, 'Diego Okonjo', target, [items(true), items(true)], PEOPLE)).toBeNull();
  });

  it('never fires for a self-ask', () => {
    const target = person({ id: 901 });
    const recent = [items(true), items(true), items(true)];
    expect(checkRepeatWithholdEscalation(901, 'Test Person', target, recent, PEOPLE)).toBeNull();
  });

  it('ignores the always-present structural CANT boilerplate — allowed-only history never fires', () => {
    // Every real response carries one structural CANT item regardless of policy. If the
    // rule counted any CANT, this would fire for every requester on their third ask ever.
    const target = person({ id: 901 });
    const recent = [items(false), items(false), items(false)];
    expect(checkRepeatWithholdEscalation(11, 'Diego Okonjo', target, recent, PEOPLE)).toBeNull();
  });
});
