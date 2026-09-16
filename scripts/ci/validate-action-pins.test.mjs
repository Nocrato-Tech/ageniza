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

  it('does not treat a short or non-hex reference as a pin', () => {
    expect(collectActionPins('      - uses: actions/checkout@abc123')).toEqual([]);
    expect(collectActionPins(`      - uses: actions/checkout@${'z'.repeat(40)}`)).toEqual([]);
  });
});
