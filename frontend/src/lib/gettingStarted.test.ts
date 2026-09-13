import { describe, expect, it } from 'vitest';
import { gettingStartedSteps, progressLabel, type GettingStartedInput } from './gettingStarted';

const base: GettingStartedInput = { hasAnsweringAgent: false, isOrgAdmin: true, connectedTools: 0, askedQuestions: 0, peopleInOrg: 1 };

describe('gettingStartedSteps', () => {
  it('a brand-new workspace owner has four steps, none done, each with a way forward', () => {
    const steps = gettingStartedSteps(base);
    expect(steps.map((s) => s.key)).toEqual(['agent', 'tool', 'ask', 'team']);
    expect(steps.every((s) => !s.done)).toBe(true);
    expect(steps.find((s) => s.key === 'agent')!.action).toEqual({ label: 'Choose one', path: '/admin/organizations' });
    expect(steps.find((s) => s.key === 'tool')!.action?.path).toBe('/me/setup');
    expect(progressLabel(steps)).toBe('0 of 4 done');
  });

  it("a member who isn't an admin is told who chooses the agent, and isn't asked to add a team", () => {
    const steps = gettingStartedSteps({ ...base, isOrgAdmin: false });
    expect(steps.map((s) => s.key)).toEqual(['agent', 'tool', 'ask']);
    const agent = steps[0];
    expect(agent.action).toBeNull();
    expect(agent.detail).toContain('An admin');
  });

  it('marks steps done from real data and drops their actions', () => {
    const steps = gettingStartedSteps({ hasAnsweringAgent: true, isOrgAdmin: true, connectedTools: 2, askedQuestions: 3, peopleInOrg: 5 });
    expect(steps.every((s) => s.done && s.action === null)).toBe(true);
    expect(steps[1].detail).toBe('2 tools connected.');
    expect(progressLabel(steps)).toBe('4 of 4 done');
  });

  it('uses the singular for one tool', () => {
    expect(gettingStartedSteps({ ...base, connectedTools: 1 })[1].detail).toBe('1 tool connected.');
  });
});
