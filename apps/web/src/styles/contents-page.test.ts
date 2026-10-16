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
