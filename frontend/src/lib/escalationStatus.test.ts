import { describe, expect, it } from 'vitest';
import { describeEscalationStatus } from './escalationStatus';
import type { Escalation, Person } from './api';

/**
 * Replaced the old hand-authored free-text status column ("Acknowledged by X · 2h") with
 * this — composed from real status/actor/timestamp columns instead of stored prose. Zero
 * tests existed for the composition logic itself before this pass.
 */

function person(id: number, name: string): Person {
  return {
    id, name, title: 'Engineer', team: 'Eng', managerId: null, agentDeployed: true,
    surfaces: {}, coverage: { percent: null, inScopeCount: 0, connectedCount: 0, gaps: [], agentDeployed: true },
  };
}

function escalation(overrides: Partial<Escalation>): Escalation {
  return {
    id: 'esc-1', kind: 'T1', title: 't', detail: 'd', personId: 1, evidenceId: null,
    rule: 'ESC-TEST', ageDays: 5, status: 'open',
    acknowledgedBy: null, acknowledgedAt: null, resolvedBy: null, resolvedAt: null,
    path: [], ...overrides,
  };
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3_600_000).toISOString();

describe('describeEscalationStatus', () => {
  const peopleById = new Map([[10, person(10, 'Hana Oyelaran')], [4, person(4, 'Tom Beckett')]]);

  it('an open escalation with no action shows age, not an actor', () => {
    expect(describeEscalationStatus(escalation({ status: 'open', ageDays: 11 }), peopleById))
      .toBe('No action recorded · 11d open');
  });

  it('acknowledged shows the real actor name and elapsed hours when recent', () => {
    const e = escalation({ status: 'acknowledged', acknowledgedBy: 10, acknowledgedAt: hoursAgo(2) });
    expect(describeEscalationStatus(e, peopleById)).toBe('Acknowledged by Hana Oyelaran · 2h');
  });

  it('acknowledged shows elapsed days once past 24 hours', () => {
    const e = escalation({ status: 'acknowledged', acknowledgedBy: 4, acknowledgedAt: daysAgo(3) });
    expect(describeEscalationStatus(e, peopleById)).toBe('Acknowledged by Tom Beckett · 3d');
  });

  it('resolved takes precedence and shows the resolver, not the acknowledger', () => {
    const e = escalation({
      status: 'resolved',
      acknowledgedBy: 10, acknowledgedAt: daysAgo(2),
      resolvedBy: 4, resolvedAt: hoursAgo(1),
    });
    expect(describeEscalationStatus(e, peopleById)).toBe('Resolved by Tom Beckett · 1h');
  });

  it('falls back to a generic label when the actor id is not in the roster', () => {
    const e = escalation({ status: 'acknowledged', acknowledgedBy: 999, acknowledgedAt: hoursAgo(1) });
    expect(describeEscalationStatus(e, peopleById)).toBe('Acknowledged by person 999 · 1h');
  });

  it('acknowledged with a missing timestamp falls back to the open-style message rather than crashing', () => {
    const e = escalation({ status: 'acknowledged', acknowledgedBy: 10, acknowledgedAt: null, ageDays: 4 });
    expect(describeEscalationStatus(e, peopleById)).toBe('No action recorded · 4d open');
  });
});
