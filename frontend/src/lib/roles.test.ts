import { describe, expect, it } from 'vitest';
import { deriveAllowedRoles } from './roles';
import type { Person } from './api';

/**
 * This is the client-side mirror of backend/src/domain/policy.ts's deriveAllowedRoles —
 * UI convenience only (graying out untruthful role buttons before a request is even
 * sent), not the real security boundary, but it needs to actually match the function it
 * mirrors or the UI misleads people about what a real ask would do. Zero tests existed
 * for either copy in the frontend before this pass, despite the backend copy having 8.
 */

function person(overrides: Partial<Person>): Person {
  return {
    id: 1, name: 'Test', title: 'Engineer', team: 'Eng', managerId: null, agentDeployed: true,
    surfaces: {}, coverage: { percent: null, inScopeCount: 0, connectedCount: 0, gaps: [], agentDeployed: true },
    ...overrides,
  } as Person;
}

describe('deriveAllowedRoles', () => {
  it('a person always has Self about themselves, regardless of anything else', () => {
    const people = [person({ id: 1 })];
    expect(deriveAllowedRoles(1, 1, people)).toEqual(['Self']);
  });

  it('a manager is Direct manager of their direct report', () => {
    const manager = person({ id: 10, team: 'Eng' });
    const report = person({ id: 11, managerId: 10 });
    expect(deriveAllowedRoles(10, 11, [manager, report])).toContain('Direct manager');
  });

  it('a skip-level manager is Skip-level, not Direct manager', () => {
    const skip = person({ id: 8 });
    const manager = person({ id: 10, managerId: 8 });
    const report = person({ id: 11, managerId: 10 });
    const roles = deriveAllowedRoles(8, 11, [skip, manager, report]);
    expect(roles).toContain('Skip-level');
    expect(roles).not.toContain('Direct manager');
  });

  it('someone three or more levels up has no role at all (unless separately Exec/IT)', () => {
    // top must itself have a manager, or the Executive rule (managerId == null) would
    // trivially grant them Executive and defeat the point of this test.
    const root = person({ id: 1, managerId: null });
    const top = person({ id: 3, team: 'Engineering', managerId: 1 });
    const skip = person({ id: 8, managerId: 3 });
    const manager = person({ id: 10, managerId: 8 });
    const report = person({ id: 11, managerId: 10 });
    expect(deriveAllowedRoles(3, 11, [root, top, skip, manager, report])).toEqual([]);
  });

  it('two reports of the same manager are Peers of each other', () => {
    const manager = person({ id: 10 });
    const a = person({ id: 11, managerId: 10 });
    const b = person({ id: 12, managerId: 10 });
    expect(deriveAllowedRoles(11, 12, [manager, a, b])).toContain('Peer');
  });

  it('someone with no manager relationship at all is not a Peer', () => {
    const a = person({ id: 11, managerId: 10 });
    const b = person({ id: 12, managerId: 20 });
    expect(deriveAllowedRoles(11, 12, [a, b])).not.toContain('Peer');
  });

  it('IT team membership grants IT admin about anyone', () => {
    const it = person({ id: 6, team: 'IT' });
    const anyone = person({ id: 99, team: 'Growth', managerId: 55 });
    expect(deriveAllowedRoles(6, 99, [it, anyone])).toContain('IT admin');
  });

  it('having no manager (top of the org chart) grants Executive', () => {
    const ceo = person({ id: 1, managerId: null });
    const anyone = person({ id: 99, managerId: 55 });
    expect(deriveAllowedRoles(1, 99, [ceo, anyone])).toContain('Executive');
  });

  it('Executive team membership grants Executive even with a manager', () => {
    const exec = person({ id: 2, team: 'Executive', managerId: 1 });
    const anyone = person({ id: 99, managerId: 55 });
    expect(deriveAllowedRoles(2, 99, [exec, anyone])).toContain('Executive');
  });

  it('someone can hold multiple real roles simultaneously (Peer + IT)', () => {
    const manager = person({ id: 10 });
    const itPeer = person({ id: 11, managerId: 10, team: 'IT' });
    const target = person({ id: 12, managerId: 10 });
    const roles = deriveAllowedRoles(11, 12, [manager, itPeer, target]);
    expect(roles).toContain('Peer');
    expect(roles).toContain('IT admin');
  });

  it('unknown requester or target ids return no roles rather than throwing', () => {
    const known = person({ id: 1 });
    expect(deriveAllowedRoles(999, 1, [known])).toEqual([]);
    expect(deriveAllowedRoles(1, 999, [known])).toEqual([]);
  });
});
