import { describe, expect, it } from 'vitest';

import { declarationsFor, readStyles } from './styles/theme-colors';

const css = readStyles('globals.css');

// The board's tile has the date at the top-left, the format at the top-right and the state at the bottom-left: three corners, so no two
// of them share a place. What is still planned is a dashed outline inside the tile, not a word on it.
describe('the date, the format and the state of a feed tile', () => {
  it('pins each to its own corner of the tile', () => {
    expect([declarationsFor(css, '.content-feed__date').get('top'), declarationsFor(css, '.content-feed__date').get('left')]).toEqual(['var(--space-1)', 'var(--space-1)']);
    expect([declarationsFor(css, '.content-feed__format').get('top'), declarationsFor(css, '.content-feed__format').get('right')]).toEqual(['var(--space-1)', 'var(--space-1)']);
    expect([declarationsFor(css, '.content-feed__state').get('bottom'), declarationsFor(css, '.content-feed__state').get('left')]).toEqual(['var(--space-1)', 'var(--space-1)']);
  });

  it('keeps the date on one line and the state inside the tile', () => {
    expect(declarationsFor(css, '.content-feed__date').get('white-space')).toBe('nowrap');
    expect(declarationsFor(css, '.content-feed__state').get('max-width')).toBe('calc(100% - 2 * var(--space-1))');
  });

  it('outlines what is still planned with a dashed line inside the tile', () => {
    const outline = declarationsFor(css, ".content-feed__tile[data-planned] .content-feed__link::after");
    expect(outline.get('border')).toContain('dashed');
    expect(outline.get('pointer-events')).toBe('none');
  });

  it('draws the tile of the agency in three by four, and leaves the portal tile square', () => {
    expect(declarationsFor(css, '.content-feed__tile').get('aspect-ratio')).toBe('1');
    expect(declarationsFor(css, '.content-feed-layout .content-feed__tile').get('aspect-ratio')).toBe('3 / 4');
  });
});
