import { describe, expect, it } from 'vitest';
import { badgeLabel, describeAsk, spansSeveralOrgs, timeAgo, unreadLabel, type AskedAboutYou } from './notifications';

const item = (over: Partial<AskedAboutYou> = {}): AskedAboutYou => ({
  id: 'a', askedAt: '2026-09-13T12:00:00.000Z', askerName: 'Marta Vieira', askerRole: 'Executive',
  question: 'What is Diego working on?', personId: 11, orgId: 1, orgName: 'Northbeam', unread: true, ...over,
});

describe('badgeLabel', () => {
  it('is empty at zero and caps at 9+', () => {
    expect(badgeLabel(0)).toBe('');
    expect(badgeLabel(3)).toBe('3');
    expect(badgeLabel(9)).toBe('9');
    expect(badgeLabel(10)).toBe('9+');
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-09-13T12:00:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it('reads like a person would say it', () => {
    expect(timeAgo(ago(20_000), now)).toBe('just now');
    expect(timeAgo(ago(5 * 60_000), now)).toBe('5 min ago');
    expect(timeAgo(ago(60 * 60_000), now)).toBe('1 hour ago');
    expect(timeAgo(ago(3 * 3_600_000), now)).toBe('3 hours ago');
    expect(timeAgo(ago(26 * 3_600_000), now)).toBe('yesterday');
    expect(timeAgo(ago(4 * 86_400_000), now)).toBe('4 days ago');
  });
  it('never says "in the future" for a slightly-ahead server clock', () => {
    expect(timeAgo(new Date(now.getTime() + 5_000).toISOString(), now)).toBe('just now');
  });
});

describe('describeAsk', () => {
  it('names who asked and in what capacity, with the right article', () => {
    expect(describeAsk(item(), false)).toBe('Marta Vieira asked about you, as an executive');
    expect(describeAsk(item({ askerRole: 'Direct manager' }), false)).toBe('Marta Vieira asked about you, as a direct manager');
  });
  it('adds the organization only when asked to', () => {
    expect(describeAsk(item(), true)).toBe('Marta Vieira asked about you in Northbeam, as an executive');
  });
});

describe('spansSeveralOrgs / unreadLabel', () => {
  it('detects more than one org', () => {
    expect(spansSeveralOrgs([item(), item({ id: 'b' })])).toBe(false);
    expect(spansSeveralOrgs([item(), item({ id: 'b', orgId: 2 })])).toBe(true);
  });
  it('announces the unread count to screen readers', () => {
    expect(unreadLabel(0)).toBe('Notifications');
    expect(unreadLabel(2)).toBe('Notifications, 2 unread');
  });
});
