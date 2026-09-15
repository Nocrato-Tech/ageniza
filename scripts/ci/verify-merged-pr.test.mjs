import { describe, expect, it } from 'vitest';

import { isMergedPullRequestCommit } from './verify-merged-pr.mjs';

describe('merged pull request commit check', () => {
  const sha = 'a'.repeat(40);
  const pull = (overrides = {}) => ({
    merged_at: '2026-09-15T12:00:00Z',
    merge_commit_sha: sha,
    base: { ref: 'main' },
    head: { ref: 'develop' },
    ...overrides
  });
  const release = { sha, base: 'main', heads: ['develop', 'hotfix/*'] };

  it('accepts the merge commit of a develop or hotfix pull request into main', () => {
    expect(isMergedPullRequestCommit([pull()], release)).toBe(true);
    expect(isMergedPullRequestCommit([pull({ head: { ref: 'hotfix/login' } })], release)).toBe(true);
  });

  it('accepts any head branch when no head pattern is given', () => {
    expect(isMergedPullRequestCommit([pull({ base: { ref: 'develop' }, head: { ref: 'feature/x' } })], { sha, base: 'develop' })).toBe(true);
  });

  it('requires the head branch to belong to the repository when one is given', () => {
    const own = pull({ head: { ref: 'develop', repo: { full_name: 'Nocrato-Tech/ageniza' } } });
    const fork = pull({ head: { ref: 'develop', repo: { full_name: 'someone/ageniza' } } });
    expect(isMergedPullRequestCommit([own], { ...release, repository: 'nocrato-tech/ageniza' })).toBe(true);
    expect(isMergedPullRequestCommit([fork], { ...release, repository: 'nocrato-tech/ageniza' })).toBe(false);
  });

  it.each([
    ['a direct push with no pull request', []],
    ['an unmerged pull request', [pull({ merged_at: null })]],
    ['a commit that is not the merge result', [pull({ merge_commit_sha: 'b'.repeat(40) })]],
    ['a pull request into another base', [pull({ base: { ref: 'develop' } })]],
    ['a feature branch merged straight into main', [pull({ head: { ref: 'feature/x' } })]]
  ])('rejects %s', (_label, pulls) => {
    expect(isMergedPullRequestCommit(pulls, release)).toBe(false);
  });
});
