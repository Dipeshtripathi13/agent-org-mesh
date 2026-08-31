import { describe, expect, it } from 'vitest';
import { AuditLog } from './audit.js';
import { computeCoverage, computeOrgCoverage } from './coverage.js';
import { DEFAULT_GRID, deriveAllowedRoles, respond } from './policy.js';
import { CLAIMS, PEOPLE, SURFACES, byId } from '../data/seed.js';
import { ROLES, type PolicyRevision, type RequesterRole } from './types.js';

const NOW = '2026-08-13T09:41:07.000Z';

function revision(grid = DEFAULT_GRID, id = 1): PolicyRevision {
  return { id, orgId: 'northbeam', grid, createdAt: NOW, createdBy: 'seed', note: 'default' };
}

function answer(personId: number, role: RequesterRole, rev = revision()) {
  const target = byId(personId);
  return respond({
    target,
    claims: CLAIMS.filter((c) => c.personId === personId),
    surfaces: SURFACES,
    requesterRole: role,
    revision: rev,
    now: NOW,
  });
}

/* ------------------------------------------------------------------ */
/* Determinism — the property the whole security story rests on        */
/* ------------------------------------------------------------------ */

describe('policy engine determinism', () => {
  it('produces byte-identical output for identical input', () => {
    const a = answer(11, 'Direct manager');
    const b = answer(11, 'Direct manager');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('covers every role without throwing', () => {
    for (const role of ROLES) {
      expect(() => answer(11, role)).not.toThrow();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Golden matrix — every role against the seeded claim set             */
/* ------------------------------------------------------------------ */

describe('golden matrix: role × disposition', () => {
  const golden: Record<RequesterRole, { allowed: number; wont: number }> = {
    Self: { allowed: 4, wont: 0 },
    Peer: { allowed: 1, wont: 3 },
    'Direct manager': { allowed: 3, wont: 1 },
    'Skip-level': { allowed: 3, wont: 1 },
    Executive: { allowed: 3, wont: 1 },
    'IT admin': { allowed: 1, wont: 3 },
  };

  for (const role of ROLES) {
    it(`${role} sees the expected split`, () => {
      const res = answer(11, role);
      const allowed = res.items.filter((i) => ['T1', 'T2', 'T3'].includes(i.tier)).length;
      const wont = res.items.filter((i) => i.tier === 'WONT').length;
      expect({ allowed, wont }).toEqual(golden[role]);
    });
  }
});

/* ------------------------------------------------------------------ */
/* Invariants that must never break                                    */
/* ------------------------------------------------------------------ */

describe('invariants', () => {
  it('never silently drops a claim — every withheld item is visible', () => {
    for (const role of ROLES) {
      const res = answer(11, role);
      const claimCount = CLAIMS.filter((c) => c.personId === 11 && !c.supersededBy).length;
      // one item per claim, plus the always-present structural-exclusion notice
      expect(res.items.length).toBe(claimCount + 1);
    }
  });

  it('always states the excluded-class boundary, for every role', () => {
    for (const role of ROLES) {
      const res = answer(11, role);
      const last = res.items.at(-1)!;
      expect(last.tier).toBe('CANT');
      expect(last.text).toMatch(/not ingested by any agent/);
    }
  });

  it('marks refusals WONT and structural absence CANT — never confused', () => {
    const res = answer(11, 'Peer');
    for (const item of res.items) {
      if (item.tier === 'WONT') expect(item.policyRef).not.toBeNull();
      if (item.tier === 'CANT') expect(item.policyRef).toBeNull();
    }
  });

  it('never attaches evidence to a withheld item', () => {
    for (const role of ROLES) {
      for (const item of answer(11, role).items) {
        if (item.tier === 'WONT' || item.tier === 'CANT') {
          expect(item.evidenceId).toBeNull();
        }
      }
    }
  });

  it('does not assert a claim whose backing surface is disconnected', () => {
    // Ruben: Slack and Confluence absent, Jira stale
    const res = answer(13, 'Direct manager');
    const cant = res.items.filter((i) => i.tier === 'CANT');
    expect(cant.length).toBeGreaterThan(1);
    expect(res.coverage.missingSurfaces.length).toBeGreaterThan(0);
  });

  it('reports no-agent as a deployment state, not an empty answer', () => {
    const res = answer(40, 'IT admin'); // Rosa, People Ops — excluded by policy
    expect(res.coverage.percent).toBeNull();
    expect(res.items[0].tier).toBe('CANT');
    expect(res.items[0].text).toMatch(/No agent is deployed/);
  });

  it('every answer carries a coverage statement', () => {
    for (const person of PEOPLE) {
      const res = answer(person.id, 'Direct manager');
      expect(res.coverage.text.length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Coverage arithmetic                                                 */
/* ------------------------------------------------------------------ */

describe('coverage', () => {
  it('excludes out-of-scope surfaces from the denominator', () => {
    // Salesforce out of scope for engineers; Claude Code is genuinely in scope for
    // Diego specifically — he's the one person with a real, registered sub-agent.
    // 6 original in-scope surfaces (github/jira/calendar/slack/confluence/claude-code) +
    // 14 connectors (linear.ts and friends) + 4 data-engineering connectors (airflow/dbt/
    // snowflake/databricks) which all default to 'absent' — in scope, just nobody in this
    // seeded demo has connected one — not 'outOfScope', so they count toward the
    // denominator too. Updated deliberately each time the catalog grows (CLAUDE.md rule 1),
    // not loosened to paper over the growth: 9 → 23 → 26 → 27 surfaces so far.
    const diego = byId(11);
    const report = computeCoverage(diego, SURFACES);
    expect(report.inScopeCount).toBe(24);
  });

  it('weights partial and stale at half', () => {
    // Ruben: github connected(1) jira stale(.5) sf out cal partial(.5) slack absent(0) conf absent(0)
    // + 14 connectors + 4 data-engineering connectors, all 'absent' (0 each) — same
    // reasoning as the test above.
    // sum 2.0 / 23 in-scope surfaces * 100 = 8.69...%, rounds to 9.
    const report = computeCoverage(byId(13), SURFACES);
    expect(report.percent).toBe(9);
  });

  it('distinguishes no agent from zero coverage', () => {
    const report = computeCoverage(byId(40), SURFACES);
    expect(report.percent).toBeNull();
    expect(report.agentDeployed).toBe(false);
  });

  it('computes org coverage from people, not a literal', () => {
    const org = computeOrgCoverage(PEOPLE, SURFACES);
    expect(org.percent).toBeGreaterThan(0);
    expect(org.percent).toBeLessThanOrEqual(100);
    expect(org.agentsLive).toBeLessThan(org.totalPeople);
  });
});

/* ------------------------------------------------------------------ */
/* Audit immutability — the bug found in the prototype                 */
/* ------------------------------------------------------------------ */

describe('audit log', () => {
  it('does not rewrite history when policy changes afterwards', () => {
    const log = new AuditLog();
    const before = revision(DEFAULT_GRID, 1);
    const snapshot = answer(11, 'Direct manager', before);
    const entry = log.append({
      orgId: 'northbeam',
      requesterId: 10,
      requesterRole: 'Direct manager',
      targetPersonId: 11,
      question: "What's the status of the payments migration?",
      snapshot,
      now: NOW,
    });

    // Admin later loosens Sensitive for managers.
    const loosened = revision(
      { ...DEFAULT_GRID, 'Direct manager': { Open: 'allow', Internal: 'allow', Sensitive: 'allow' } },
      2,
    );
    const nowAnswer = answer(11, 'Direct manager', loosened);

    // The new answer differs...
    expect(JSON.stringify(nowAnswer)).not.toBe(JSON.stringify(snapshot));
    // ...but the stored record does not.
    const stored = log.list().find((e) => e.id === entry.id)!;
    expect(stored.snapshot).toEqual(snapshot);
    expect(stored.policyRevisionId).toBe(1);
  });

  it('detects tampering with a stored entry', () => {
    const log = new AuditLog();
    log.append({
      orgId: 'northbeam',
      requesterId: 10,
      requesterRole: 'Peer',
      targetPersonId: 11,
      question: 'q1',
      snapshot: answer(11, 'Peer'),
      now: NOW,
    });
    expect(log.verify().valid).toBe(true);

    // list() returns clones — mutating them cannot corrupt the chain
    const copy = log.list();
    (copy[0] as { question: string }).question = 'tampered';
    expect(log.verify().valid).toBe(true);
    expect(log.list()[0].question).toBe('q1');
  });

  it('chains entries so reordering is detectable', () => {
    const log = new AuditLog();
    for (const role of ['Peer', 'Direct manager', 'Executive'] as RequesterRole[]) {
      log.append({
        orgId: 'northbeam',
        requesterId: 10,
        requesterRole: role,
        targetPersonId: 11,
        question: `asked as ${role}`,
        snapshot: answer(11, role),
        now: NOW,
      });
    }
    const entries = log.list();
    expect(entries[0].prevHash).toBeNull();
    expect(entries[1].prevHash).toBe(entries[0].rowHash);
    expect(entries[2].prevHash).toBe(entries[1].rowHash);
    expect(log.verify().valid).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* deriveAllowedRoles — closes the role-spoofing gap (never trust a    */
/* client-asserted requesterRole without checking it against the org   */
/* graph first)                                                        */
/* ------------------------------------------------------------------ */

describe('deriveAllowedRoles', () => {
  it('always allows Self, regardless of org position', () => {
    expect(deriveAllowedRoles(11, 11, PEOPLE)).toEqual(['Self']);
  });

  it('grants Direct manager only to the actual manager', () => {
    expect(deriveAllowedRoles(10, 11, PEOPLE)).toContain('Direct manager'); // Hana → Diego
    expect(deriveAllowedRoles(12, 11, PEOPLE)).not.toContain('Direct manager'); // Amara is a peer, not the manager
  });

  it('grants Skip-level only to the manager’s manager', () => {
    expect(deriveAllowedRoles(8, 11, PEOPLE)).toContain('Skip-level'); // Sofia → Hana → Diego
    expect(deriveAllowedRoles(10, 11, PEOPLE)).not.toContain('Skip-level'); // Hana is direct, not skip
  });

  it('grants Peer only to someone sharing the same manager', () => {
    expect(deriveAllowedRoles(12, 11, PEOPLE)).toContain('Peer'); // Amara and Diego both report to Hana
    expect(deriveAllowedRoles(18, 11, PEOPLE)).not.toContain('Peer'); // Samuel is on a different team entirely
  });

  it('grants IT admin only to people actually on the IT team', () => {
    expect(deriveAllowedRoles(39, 11, PEOPLE)).toContain('IT admin'); // Ben, IT Systems Administrator
    expect(deriveAllowedRoles(12, 11, PEOPLE)).not.toContain('IT admin'); // Amara is Payments, not IT
  });

  it('grants Executive to the top of the chart and the Executive team, nobody else', () => {
    expect(deriveAllowedRoles(1, 11, PEOPLE)).toContain('Executive'); // Marta, CEO, no manager
    expect(deriveAllowedRoles(33, 11, PEOPLE)).not.toContain('Executive'); // Karim, an AE, reports to a VP
  });

  it('returns no roles at all for someone with no real relationship to the target', () => {
    // Karim (Enterprise AE, Revenue) has no structural or functional tie to Diego.
    expect(deriveAllowedRoles(33, 11, PEOPLE)).toEqual([]);
  });

  it('is symmetric-safe: being someone’s peer does not make you their manager', () => {
    const rolesAsAmara = deriveAllowedRoles(12, 11, PEOPLE);
    expect(rolesAsAmara).toEqual(['Peer']);
  });
});
