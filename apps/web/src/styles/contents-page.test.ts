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
  it('gives a day of the month 10rem, and a day of the week 18rem, with its content one step in from the line', () => {
    expect(rem(rule('.content-day').get('min-height'))).toBe(10);
    expect(rem(rule(".content-calendar[data-view='week'] .content-day").get('min-height'))).toBe(18);
    expect(rule('.content-day').get('padding')).toBe('var(--space-3) var(--space-2)');
    expect(rule('.content-day').get('gap')).toBe('var(--space-3)');
  });

  it('separates the cards of a day by a step and gives each one room inside', () => {
    expect(rule('.content-day__items').get('gap')).toBe('var(--space-3)');
    expect(rule('.content-card').get('padding')).toBe('var(--space-3) var(--space-2)');
  });

  it('lines the weekday labels up with the day numbers, and gives the head of the panel its own air', () => {
    expect(rule('.content-calendar__weekdays li').get('padding')).toBe('var(--space-3) var(--space-4)');
    expect(rule('.content-day__number').get('padding')).toBe('0 var(--space-2)');
    expect(rule('.contents__panel-head').get('padding')).toBe('var(--space-6) var(--space-6) var(--space-4)');
    expect(rule('.contents__panel-head').get('gap')).toBe('var(--space-4)');
  });

  it('keeps the track of the grid able to shrink, so the roomier cell never pushes a card out of its day', () => {
    expect(rule('.content-day').get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(rule('.content-card').get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(rule('.content-day__items').get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(rule('.content-day').get('min-width')).toBe('0');
  });
});

describe('the story script of a day is a row with room, not a capsule (#703)', () => {
  it('is as wide as its day and at least 44px tall', () => {
    const chip = rule('.content-day__script');

    expect(chip.get('width')).toBe('100%');
    expect(rem(chip.get('min-height'))).toBeGreaterThanOrEqual(2.75);
    expect(chip.get('padding')).toBe('var(--space-2) var(--space-3)');
    expect(chip.get('border-radius')).toBe('var(--radius-md)');
    expect(chip.get('display')).toBe('flex');
  });

  it('stacks the scripts of a day in a list whose track can shrink, a step apart', () => {
    const list = rule('.content-day__scripts');

    expect(list.get('display')).toBe('grid');
    expect(list.get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(list.get('gap')).toBe('var(--space-2)');
    expect(list.get('flex')).toBe('1 1 100%');
  });

  it('keeps the "+" of the day 32px and out of the way of the first row', () => {
    const trigger = rule('.content-day__tools .ui-menu__trigger');

    expect(rem(trigger.get('min-width'))).toBe(2);
    expect(rem(trigger.get('min-height'))).toBe(2);
    expect(trigger.get('top')).toBe('var(--space-2)');
    expect(trigger.get('right')).toBe('var(--space-2)');
    expect(rem(rule('.content-day__tools .ui-menu__content').get('top'))).toBe(2.5);
  });

  it('takes every length of these rules from the scale, never from a pixel value', () => {
    const selectors = ['.content-day', '.content-day__items', '.content-card', '.content-day__script', '.content-day__scripts', '.content-day__tools', '.contents__panel-head', '.content-calendar__weekdays li', '.content-day__number'];
    const offenders = selectors.flatMap((selector) => [...rule(selector)].filter(([property, value]) => /^(padding|gap)$/.test(property) && !/^(0|var\(--space-\d+\))( (0|var\(--space-\d+\)))*$/.test(value)).map(([property, value]) => `${selector} { ${property}: ${value} }`));

    expect(offenders).toEqual([]);
  });
});

describe('the phone beside the calendar (#703)', () => {
  it('is an ink bezel with a screen on the surface, as wide as 22rem, and tall enough to be a phone even when empty', () => {
    expect(rule('.content-phone').get('background')).toBe('var(--color-ink-900)');
    expect(rule('.content-phone').get('width')).toBe('min(100%, 22rem)');
    expect(rule('.content-phone').get('padding')).toBe('var(--space-2)');
    expect(rule('.content-phone').get('border-radius')).toBe('calc(var(--radius-xl) * 2)');
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

  it('gives the column of the phone 22rem beside the calendar and keeps it in view while the month scrolls', () => {
    expect(css).toMatch(/@media \(min-width: 64rem\) \{\s*\.contents__workspace \{\s*grid-template-columns: minmax\(0, 1fr\) 22rem;\s*gap: var\(--space-8\);/);
    expect(css).toMatch(/@media \(min-width: 64rem\) \{[\s\S]*?\.contents__feed \{\s*position: sticky;\s*top: var\(--space-6\);/);
    expect(rule('.contents__feed').get('justify-items')).toBe('center');
    expect(rule('.contents__feed').get('border')).toBeUndefined();
  });

  it('frames an empty slot with a dashed line and the icon of the day with nothing, in the size of every icon', () => {
    const slot = rule('.content-feed__slot');

    expect(slot.get('aspect-ratio')).toBe('1');
    expect(slot.get('border')).toBe('1px dashed var(--border-default)');
    expect(slot.get('background')).toBe('var(--bg-canvas)');
    expect(rule('.content-feed__slot svg').get('width')).toBe('1.5rem');
    expect(rule('.content-feed__slot svg').get('stroke-width')).toBe('1.75');
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
    expect(rule('.content-feed__profile').get('padding')).toBe('0 var(--space-3)');
    expect(rule('.content-feed__grid').get('gap')).toBe('2px');
    expect(rule('.content-phone .content-feed__grid').get('gap')).toBe('var(--space-1)');
    expect(rule('.content-phone .content-feed__handle').get('padding')).toBe('0');
  });

  it('takes the spacing of the phone from the scale, never from a pixel value', () => {
    const offenders = ['.content-phone', '.content-phone__screen', '.content-phone__island', '.content-phone__home', '.content-feed__pager'].flatMap((selector) => [...rule(selector)].filter(([property, value]) => /^(padding|gap)$/.test(property) && !/^(0|var\(--space-\d+\))( (0|var\(--space-\d+\)))*$/.test(value)).map(([property, value]) => `${selector} { ${property}: ${value} }`));

    expect(offenders).toEqual([]);
  });
});
