import { describe, expect, it } from 'vitest';
import { formatGithubDigest, toCommitItem, toPrItem, type GithubActivityItem } from './github.js';

/**
 * Pure mapping/formatting logic, split out from the real network/MCP calls specifically so
 * it's testable without mocking `fetch` or the MCP SDK's `Client` — real fixture shapes
 * only, confirmed against the actual APIs (GitHub's REST `/search/issues` response for
 * toPrItem; GitHub's own official MCP server's `MinimalCommit` Go struct, read directly
 * from its real source (minimal_types.go) for toCommitItem, not assumed) rather than
 * guessed — this connector shipped three real, live-only-found bugs this session precisely
 * because nothing here was covered by an automated test before now.
 */
describe('toPrItem', () => {
  const issueSearchItem = {
    title: 'Fix flaky retry logic',
    repository_url: 'https://api.github.com/repos/acme/payments-core',
    html_url: 'https://github.com/acme/payments-core/pull/42',
    updated_at: '2026-08-30T10:00:00Z',
  };

  it('maps a real /search/issues item to an authored GithubActivityItem', () => {
    expect(toPrItem('authored')(issueSearchItem)).toEqual({
      kind: 'authored',
      title: 'Fix flaky retry logic',
      repo: 'acme/payments-core',
      url: 'https://github.com/acme/payments-core/pull/42',
      updatedAt: '2026-08-30T10:00:00Z',
    });
  });

  it('maps the same shape to a reviewed item when asked for that kind', () => {
    expect(toPrItem('reviewed')(issueSearchItem).kind).toBe('reviewed');
  });

  it('derives repo as owner/name from the tail of repository_url', () => {
    const item = { ...issueSearchItem, repository_url: 'https://api.github.com/repos/torvalds/linux' };
    expect(toPrItem('authored')(item).repo).toBe('torvalds/linux');
  });
});

describe('toCommitItem', () => {
  // Shaped exactly like GitHub's real MCP server's MinimalCommit (pkg/github/minimal_types.go):
  // sha/html_url at the top level, message and author.date nested under `commit` — the same
  // nesting the raw REST Commits API already used, confirmed rather than assumed.
  const minimalCommit = {
    sha: 'abc123def456',
    html_url: 'https://github.com/acme/payments-core/commit/abc123def456',
    commit: {
      message: 'fix: handle null response from gateway\n\nLonger body explaining the fix in detail.',
      author: { name: 'Dipesh Tripathi', email: 'dipesh@example.com', date: '2026-08-30T14:22:00Z' },
    },
    __repo: 'acme/payments-core',
  };

  it('maps a real MinimalCommit into a committed GithubActivityItem', () => {
    expect(toCommitItem(minimalCommit)).toEqual({
      kind: 'committed',
      title: 'fix: handle null response from gateway',
      repo: 'acme/payments-core',
      url: 'https://github.com/acme/payments-core/commit/abc123def456',
      updatedAt: '2026-08-30T14:22:00Z',
    });
  });

  it('trims the title to the first line only — never the full commit body', () => {
    const item = toCommitItem(minimalCommit);
    expect(item.title).not.toContain('Longer body');
  });

  it('trims a very long single-line message to 120 chars', () => {
    const longMessage = 'x'.repeat(200);
    const item = toCommitItem({ ...minimalCommit, commit: { ...minimalCommit.commit, message: longMessage } });
    expect(item.title.length).toBe(120);
  });

  it('falls back to empty strings rather than throwing when commit/author is missing', () => {
    expect(() => toCommitItem({ sha: 'x', html_url: 'y', __repo: 'a/b' })).not.toThrow();
    const item = toCommitItem({ sha: 'x', html_url: 'y', __repo: 'a/b' });
    expect(item.title).toBe('');
    expect(item.updatedAt).toBe('');
  });
});

describe('formatGithubDigest', () => {
  it('returns null for an empty activity list', () => {
    expect(formatGithubDigest([])).toBeNull();
  });

  it('labels each kind distinctly, including the new "committed" kind', () => {
    const items: GithubActivityItem[] = [
      { kind: 'authored', title: 'PR one', repo: 'acme/a', url: 'u1', updatedAt: 't1' },
      { kind: 'reviewed', title: 'PR two', repo: 'acme/b', url: 'u2', updatedAt: 't2' },
      { kind: 'committed', title: 'a commit', repo: 'acme/c', url: 'u3', updatedAt: 't3' },
    ];
    const digest = formatGithubDigest(items);
    expect(digest).toContain('Opened/updated PR in acme/a: "PR one"');
    expect(digest).toContain('Reviewed PR in acme/b: "PR two"');
    expect(digest).toContain('Committed to acme/c: "a commit"');
  });
});
