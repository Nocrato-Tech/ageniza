import { describe, expect, it } from 'vitest';

import { declarationsFor, readStyles } from './theme-colors';

const css = readStyles('globals.css');
const rule = (selector: string) => declarationsFor(css, selector);

const rem = (value: string | undefined): number => {
  const match = /^(\d+(?:\.\d+)?)rem$/.exec(value ?? '');
  if (match === null) throw new Error(`not a rem value: ${String(value)}`);
  return Number(match[1]);
};

describe('the month of the Conteúdos calendar has room (#703)', () => {
  it('gives a day of the month 9.25rem, and a day of the week 16rem, with its content one step in from the line', () => {
    expect(rem(rule('.content-day').get('min-height'))).toBe(9.25);
    expect(rem(rule(".content-calendar[data-view='week'] .content-day").get('min-height'))).toBe(16);
    expect(rule('.content-day').get('padding')).toBe('var(--space-2)');
    expect(rule('.content-day').get('gap')).toBe('var(--space-2)');
  });

  it('separates the cards of a day by a step and gives the link of each one room inside', () => {
    expect(rule('.content-day__items').get('gap')).toBe('var(--space-2)');
    expect(rule('.content-card__link').get('padding')).toBe('var(--space-2)');
  });

  it('gives the weekday labels their own step of air, and the number of a day the round mark of today', () => {
    expect(rule('.content-calendar__weekdays li').get('padding')).toBe('var(--space-3)');
    expect(rule(".content-day__number span[aria-hidden='true']").get('border-radius')).toBe('var(--radius-full)');
  });

  it('keeps the track of the grid able to shrink, so the cell never pushes a card out of its day: the cover has its width and the text the rest', () => {
    expect(rule('.content-day').get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(rule('.content-card__link').get('grid-template-columns')).toBe('2.25rem minmax(0, 1fr)');
    expect(rule('.content-day__items').get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(rule('.content-day').get('min-width')).toBe('0');
  });
});

describe('the story of a day is a circle with room around it, in the corner of its day (#703)', () => {
  it('is a round target at least 32px wide, whose ring takes the number of scenes', () => {
    const story = rule('.content-day__story');

    expect(rem(story.get('min-width'))).toBeGreaterThanOrEqual(2);
    expect(rem(story.get('min-height'))).toBeGreaterThanOrEqual(2);
    expect(story.get('border-radius')).toBe('var(--radius-full)');
    expect(story.get('display')).toBe('inline-flex');
  });

  it('puts the circle and the "+" of the day side by side in the top-right corner, a step apart', () => {
    const tools = rule('.content-day__tools');

    expect(tools.get('position')).toBe('absolute');
    expect(tools.get('top')).toBe('var(--space-1)');
    expect(tools.get('right')).toBe('var(--space-1)');
    expect(tools.get('gap')).toBe('var(--space-1)');
  });

  it('keeps the "+" of the day 32px', () => {
    const trigger = rule('.content-day__tools .ui-menu__trigger');

    expect(rem(trigger.get('min-width'))).toBe(2);
    expect(rem(trigger.get('min-height'))).toBe(2);
    expect(rem(rule('.content-day__tools .ui-menu__content').get('top'))).toBe(2.5);
  });

  it('takes every length of these rules from the scale, never from a pixel value', () => {
    const selectors = ['.content-day', '.content-day__items', '.content-card', '.content-day__tools', '.content-calendar__weekdays li', '.content-day__number'];
    const offenders = selectors.flatMap((selector) => [...rule(selector)].filter(([property, value]) => /^(padding|gap)$/.test(property) && !/^(0|var\(--space-\d+\))( (0|var\(--space-\d+\)))*$/.test(value)).map(([property, value]) => `${selector} { ${property}: ${value} }`));

    expect(offenders).toEqual([]);
  });
});

describe('the phone of the feed view (#703)', () => {
  it('is an ink bezel (light on the agency screen, as on the board) with a screen on the surface, as wide as 22rem (23.5rem beside the guide), and tall enough to be a phone even when empty', () => {
    expect(rule('.content-phone').get('background')).toBe('var(--color-ink-900)');
    expect(rule('.contents .content-phone').get('background')).toBe('var(--bg-surface)');
    expect(rule('.content-phone').get('width')).toBe('min(100%, 22rem)');
    expect(rule('.content-phone').get('padding')).toBe('var(--space-2)');
    expect(rule('.content-phone').get('border-radius')).toBe('calc(var(--radius-xl) * 2)');
    expect(rule('.content-feed-layout .content-phone').get('width')).toBe('min(100%, 23.5rem)');
    expect(rule('.contents .content-phone').get('box-shadow')).toBeUndefined();
    expect(rule('.content-phone__screen').get('background')).toBe('var(--bg-surface)');
    expect(rem(rule('.content-phone__screen').get('min-height'))).toBe(42);
    expect(rule('.content-phone__screen').get('padding')).toBe('var(--space-12) var(--space-4) var(--space-8)');
  });

  it('draws the camera island and the home bar in the middle of the screen, out of the flow', () => {
    for (const selector of ['.content-phone__island', '.content-phone__home']) {
      expect(rule(selector).get('position'), selector).toBe('absolute');
      expect(rule(selector).get('left'), selector).toBe('50%');
      expect(rule(selector).get('transform'), selector).toBe('translateX(-50%)');
      expect(rule(selector).get('border-radius'), selector).toBe('var(--radius-full)');
    }
  });

  it('puts the guide of 22rem beside the phone from 64rem, kept in view while the grid scrolls, and under the phone below it', () => {
    expect(css).toMatch(/@media \(min-width: 64rem\) \{\s*\.content-feed-layout \{\s*grid-template-columns: minmax\(0, 1fr\) 22rem;/);
    expect(css).toMatch(/\.content-feed-guide \{\s*position: sticky;\s*top: var\(--space-6\);/);
  });

  it('puts the pager at the foot of the phone, shows the range in small tabular numbers and dims an end button', () => {
    expect(rule('.content-feed__pager').get('justify-content')).toBe('space-between');
    expect(rule('.content-feed__range').get('font')).toBe('var(--caption)');
    expect(rule('.content-feed__range').get('font-variant-numeric')).toBe('tabular-nums');
    expect(rule(".content-feed__pager .ui-button[aria-disabled='true']").get('opacity')).toBe('0.55');
    expect(rule(".content-feed__pager .ui-button[aria-disabled='true']").get('cursor')).toBe('not-allowed');
  });

  it('draws the phone only under .content-phone: the tile classes the portal shares keep the rules they had', () => {
    expect(rule('.content-feed__handle').get('padding')).toBe('var(--space-3) var(--space-3) 0');
    expect(rule('.content-feed-layout .content-feed__handle').get('padding')).toBe('0');
    expect(rule('.content-feed__tile').get('aspect-ratio')).toBe('1');
    expect(rule('.content-feed__grid').get('gap')).toBe('2px');
    expect(rule('.content-feed-layout .content-feed__grid').get('gap')).toBe('var(--space-1)');
  });

  it('takes the spacing of the phone from the scale, never from a pixel value', () => {
    const offenders = ['.content-phone', '.content-phone__screen', '.content-phone__island', '.content-phone__home', '.content-feed__pager'].flatMap((selector) => [...rule(selector)].filter(([property, value]) => /^(padding|gap)$/.test(property) && !/^(0|var\(--space-\d+\))( (0|var\(--space-\d+\)))*$/.test(value)).map(([property, value]) => `${selector} { ${property}: ${value} }`));

    expect(offenders).toEqual([]);
  });
});
