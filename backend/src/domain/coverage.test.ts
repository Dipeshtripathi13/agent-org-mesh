import { describe, expect, it } from 'vitest';
import {
  computeConnectorStats,
  computeCoverage,
  computeOrgCoverage,
  nextSurfaceState,
  stateLabel,
  usableSurfaces,
} from './coverage.js';
import type { Person, Surface, SurfaceKey, SurfaceState } from './types.js';

/**
 * coverage.ts is named directly in CLAUDE.md's "correctness core" and drives the Overview
 * headline (rule 6: no literal number that isn't derived from state) plus feeds directly
 * into policy.ts's usableSurfaces() gate — yet had zero golden tests before this pass.
 */

const S = (keys: SurfaceKey[]): Surface[] =>
  keys.map((key) => ({ key, name: key, feedsTier: 'T1', reads: '', doesNotRead: '' }));

function person(surfaces: Partial<Record<SurfaceKey, SurfaceState>>, overrides: Partial<Person> = {}): Person {
  const full = {
    github: 'outOfScope', jira: 'outOfScope', salesforce: 'outOfScope', calendar: 'outOfScope',
    slack: 'outOfScope', confluence: 'outOfScope', 'claude-code': 'outOfScope',
    codex: 'outOfScope', 'gemini-cli': 'outOfScope', ...surfaces,
  } as Record<SurfaceKey, SurfaceState>;
  return { id: 1, name: 'Test', title: 'Engineer', team: 'Eng', managerId: null, agentDeployed: true, surfaces: full, ...overrides };
}

describe('computeCoverage', () => {
  it('returns null percent and zero counts when no agent is deployed — never zero-percent', () => {
    const p = person({ github: 'absent' }, { agentDeployed: false });
    const report = computeCoverage(p, S(['github']));
    expect(report).toEqual({ personId: 1, percent: null, inScopeCount: 0, connectedCount: 0, gaps: [], agentDeployed: false });
  });

  it('100% when every in-scope surface is connected', () => {
    const p = person({ github: 'connected', jira: 'connected' });
    const report = computeCoverage(p, S(['github', 'jira']));
    expect(report.percent).toBe(100);
    expect(report.connectedCount).toBe(2);
    expect(report.gaps).toEqual([]);
  });

  it('0% when every in-scope surface is absent', () => {
    const p = person({ github: 'absent', jira: 'absent' });
    const report = computeCoverage(p, S(['github', 'jira']));
    expect(report.percent).toBe(0);
    expect(report.connectedCount).toBe(0);
  });

  it('partial and stale both weigh 0.5, distinct from connected(1) and absent(0)', () => {
    const p = person({ github: 'partial', jira: 'stale' });
    const report = computeCoverage(p, S(['github', 'jira']));
    // (0.5 + 0.5) / 2 = 50%
    expect(report.percent).toBe(50);
  });

  it('outOfScope surfaces are excluded from the denominator entirely, not counted as gaps', () => {
    const p = person({ github: 'connected', jira: 'outOfScope' });
    const report = computeCoverage(p, S(['github', 'jira']));
    expect(report.inScopeCount).toBe(1); // jira excluded
    expect(report.percent).toBe(100); // not dragged down by the out-of-scope surface
    expect(report.gaps).toEqual([]);
  });

  it('null percent (not 0%) when every surface is out of scope — nothing to be a gap in', () => {
    const p = person({ github: 'outOfScope', jira: 'outOfScope' });
    const report = computeCoverage(p, S(['github', 'jira']));
    expect(report.percent).toBeNull();
    expect(report.inScopeCount).toBe(0);
  });

  it('gaps list every non-connected in-scope surface with its human label, never "connected" itself', () => {
    const p = person({ github: 'connected', jira: 'stale', salesforce: 'absent' });
    const report = computeCoverage(p, S(['github', 'jira', 'salesforce']));
    expect(report.gaps).toEqual(['jira — stale', 'salesforce — not connected']);
  });

  it('rounds the percent rather than truncating', () => {
    // 1 connected + 1 absent + 1 partial(0.5) = 1.5 / 3 = 50% exactly; use a case that
    // actually needs rounding: 2 connected out of 3 = 66.67% -> 67
    const p = person({ github: 'connected', jira: 'connected', salesforce: 'absent' });
    const report = computeCoverage(p, S(['github', 'jira', 'salesforce']));
    expect(report.percent).toBe(67);
  });
});

describe('computeOrgCoverage', () => {
  it('excludes non-deployed people from the percent/bands, but still counts them in totalPeople', () => {
    const deployed = person({ github: 'connected' }, { id: 1 });
    const notDeployed = person({ github: 'absent' }, { id: 2, agentDeployed: false });
    const org = computeOrgCoverage([deployed, notDeployed], S(['github']));
    expect(org.totalPeople).toBe(2);
    expect(org.agentsLive).toBe(1);
    expect(org.percent).toBe(100); // only the deployed person's connected surface counts
  });

  it('0% (not null) org-wide when nobody has any in-scope connected surfaces', () => {
    const p1 = person({ github: 'absent' }, { id: 1 });
    const org = computeOrgCoverage([p1], S(['github']));
    expect(org.percent).toBe(0);
  });

  it('0% (not NaN) when there are no deployed people at all', () => {
    const p1 = person({ github: 'connected' }, { id: 1, agentDeployed: false });
    const org = computeOrgCoverage([p1], S(['github']));
    expect(org.percent).toBe(0);
    expect(org.agentsLive).toBe(0);
  });

  it('bands tally real per-state counts across the whole org, deployed people only', () => {
    const a = person({ github: 'connected' }, { id: 1 });
    const b = person({ github: 'partial' }, { id: 2 });
    const c = person({ github: 'absent' }, { id: 3, agentDeployed: false }); // excluded
    const org = computeOrgCoverage([a, b, c], S(['github']));
    expect(org.bands).toEqual({ connected: 1, partial: 1, stale: 0, absent: 0 });
  });
});

describe('usableSurfaces', () => {
  it('includes connected, partial, and stale — a claim can rely on any of these', () => {
    const p = person({ github: 'connected', jira: 'partial', salesforce: 'stale', calendar: 'absent', slack: 'outOfScope' });
    expect(usableSurfaces(p, S(['github', 'jira', 'salesforce', 'calendar', 'slack']))).toEqual(['github', 'jira', 'salesforce']);
  });

  it('excludes absent and outOfScope — a claim cannot rely on either', () => {
    const p = person({ github: 'absent', jira: 'outOfScope' });
    expect(usableSurfaces(p, S(['github', 'jira']))).toEqual([]);
  });
});

describe('nextSurfaceState — the self-service cycle', () => {
  it('cycles connected -> partial -> absent -> connected', () => {
    expect(nextSurfaceState('connected')).toBe('partial');
    expect(nextSurfaceState('partial')).toBe('absent');
    expect(nextSurfaceState('absent')).toBe('connected');
  });

  it('stale jumps directly to absent, not back into the connected/partial cycle', () => {
    expect(nextSurfaceState('stale')).toBe('absent');
  });

  it('outOfScope is a fixed point — a role can\'t opt itself into scope by cycling', () => {
    expect(nextSurfaceState('outOfScope')).toBe('outOfScope');
  });

  it('is a true cycle: four applications from any connectable state return to it', () => {
    let s: SurfaceState = 'connected';
    for (let i = 0; i < 3; i++) s = nextSurfaceState(s);
    expect(s).toBe('connected');
  });
});

describe('stateLabel', () => {
  it('has a human label for every SurfaceState with no fallthrough', () => {
    const states: SurfaceState[] = ['connected', 'partial', 'stale', 'absent', 'outOfScope'];
    for (const s of states) expect(typeof stateLabel(s)).toBe('string');
    expect(stateLabel('partial')).toBe('partial scope');
  });
});

describe('computeConnectorStats', () => {
  it('a connector with everyone connected is "live"', () => {
    const people = [person({ github: 'connected' }, { id: 1 }), person({ github: 'connected' }, { id: 2 })];
    const [stats] = computeConnectorStats(S(['github']), people);
    expect(stats.status).toBe('live');
    expect(stats.connectedCount).toBe(2);
    expect(stats.inScopeCount).toBe(2);
  });

  it('any absent or partial person drags the whole connector to "degraded"', () => {
    const people = [person({ github: 'connected' }, { id: 1 }), person({ github: 'absent' }, { id: 2 })];
    const [stats] = computeConnectorStats(S(['github']), people);
    expect(stats.status).toBe('degraded');
  });

  it('worst=stale (with no absent/partial present) reports "stale" specifically, not "degraded"', () => {
    const people = [person({ github: 'connected' }, { id: 1 }), person({ github: 'stale' }, { id: 2 })];
    const [stats] = computeConnectorStats(S(['github']), people);
    expect(stats.status).toBe('stale');
  });

  it('outOfScope people never count toward inScopeCount and never drag status down', () => {
    const people = [person({ github: 'connected' }, { id: 1 }), person({ github: 'outOfScope' }, { id: 2 })];
    const [stats] = computeConnectorStats(S(['github']), people);
    expect(stats.status).toBe('live');
    expect(stats.inScopeCount).toBe(1);
    expect(stats.counts.outOfScope).toBe(1);
  });

  it('non-deployed people are excluded entirely, not even counted as outOfScope', () => {
    const people = [person({ github: 'connected' }, { id: 1, agentDeployed: false })];
    const [stats] = computeConnectorStats(S(['github']), people);
    expect(stats.inScopeCount).toBe(0);
    expect(stats.counts.connected).toBe(0);
  });

  it('worst-state tracking is order-independent (absent-then-stale and stale-then-absent agree)', () => {
    const order1 = [person({ github: 'absent' }, { id: 1 }), person({ github: 'stale' }, { id: 2 })];
    const order2 = [person({ github: 'stale' }, { id: 1 }), person({ github: 'absent' }, { id: 2 })];
    expect(computeConnectorStats(S(['github']), order1)[0].status)
      .toBe(computeConnectorStats(S(['github']), order2)[0].status);
  });

  it('returns one row per surface, in the surfaces array\'s order', () => {
    const people = [person({ github: 'connected', jira: 'connected' }, { id: 1 })];
    const stats = computeConnectorStats(S(['github', 'jira']), people);
    expect(stats.map((s) => s.key)).toEqual(['github', 'jira']);
  });
});
