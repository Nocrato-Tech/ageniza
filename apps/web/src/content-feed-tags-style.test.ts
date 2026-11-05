import { describe, expect, it } from 'vitest';

import { declarationsFor, readStyles } from './styles/theme-colors';

const css = readStyles('globals.css');

// The date and the "Planejado" tag were both pinned to the bottom of the tile, one to each corner, so on a narrow tile the tag
// covered the date. They are now two items of one row that wraps, so they never share the same place.
describe('the date and the planned tag of a feed tile', () => {
  it('sit in one wrapping row pinned to the bottom of the tile', () => {
    const row = declarationsFor(css, '.content-feed__tags');
    expect(row.get('position')).toBe('absolute');
    expect(row.get('display')).toBe('flex');
    expect(row.get('flex-wrap')).toBe('wrap');
    expect(row.get('left')).toBe('var(--space-1)');
    expect(row.get('right')).toBe('var(--space-1)');
    expect(row.get('bottom')).toBe('var(--space-1)');
  });

  it.each(['.content-feed__date', '.content-feed__planned'])('%s is placed by the row, never pinned to a corner of its own', (selector) => {
    const own = declarationsFor(css, selector);
    for (const property of ['position', 'left', 'right', 'bottom', 'top']) expect(own.has(property), property).toBe(false);
    expect(own.get('white-space')).toBe('nowrap');
  });
});
