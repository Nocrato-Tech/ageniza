import { describe, expect, it } from 'vitest';

import { collectActionPins, collectUnpinnedUses } from './validate-action-pins.mjs';

const sha = 'a'.repeat(40);

describe('action pin collection', () => {
  const workflow = [
    'jobs:',
    '  build:',
    '    steps:',
    `      - uses: actions/checkout@${sha}`,
    `      - uses: actions/setup-node@${'b'.repeat(40)} # v4.4.0`,
    '      - uses: actions/cache@v4',
    '      - uses: ./.github/actions/production-ssh',
    '      - run: echo not-a-use'
  ].join('\n');

  it('collects every commit-pinned third-party action', () => {
    expect(collectActionPins(workflow)).toEqual([
      { repository: 'actions/checkout', sha },
      { repository: 'actions/setup-node', sha: 'b'.repeat(40) }
    ]);
  });

  it('reports tag references separately and ignores local composite actions', () => {
    const unpinned = collectUnpinnedUses(workflow);
    expect(unpinned).toEqual([{ repository: 'actions/cache', ref: 'v4' }]);
    expect(JSON.stringify(unpinned)).not.toContain('production-ssh');
  });

  describe('sub-actions (owner/repo/path@ref)', () => {
    const subActions = [
      `      - uses: actions/cache/restore@${sha} # v4.2.0`,
      `      - uses: actions/cache/save@${'c'.repeat(40)}`,
      `      - uses: owner/mono/deep/nested/action@${'d'.repeat(40)}`,
      '      - uses: actions/cache/restore@v4',
      '      - uses: actions/cache/save@main',
      '      - uses: ./.github/actions/production-ssh'
    ].join('\n');

    it('resolves a commit-pinned sub-action against owner/repo', () => {
      expect(collectActionPins(subActions)).toEqual([
        { repository: 'actions/cache', sha },
        { repository: 'actions/cache', sha: 'c'.repeat(40) },
        { repository: 'owner/mono', sha: 'd'.repeat(40) }
      ]);
    });

    it('does not pin a sub-action on a tag or a branch, and reports it', () => {
      expect(collectUnpinnedUses(subActions)).toEqual([
        { repository: 'actions/cache', ref: 'v4' },
        { repository: 'actions/cache', ref: 'main' }
      ]);
      expect(collectActionPins('      - uses: actions/cache/restore@v4\n      - uses: actions/cache/save@main')).toEqual([]);
    });

    it('still skips local actions, even one with a path and a sha-looking suffix', () => {
      expect(collectActionPins(`      - uses: ./.github/actions/production-ssh@${sha}`)).toEqual([]);
      expect(collectUnpinnedUses(`      - uses: ./.github/actions/production-ssh@v1`)).toEqual([]);
    });
  });

  it('does not treat a short or non-hex reference as a pin', () => {
    expect(collectActionPins('      - uses: actions/checkout@abc123')).toEqual([]);
    expect(collectActionPins(`      - uses: actions/checkout@${'z'.repeat(40)}`)).toEqual([]);
  });
});
