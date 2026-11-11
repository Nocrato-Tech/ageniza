import { describe, expect, it } from 'vitest';

import { declarationsFor, readStyles } from './theme-colors';

const css = readStyles('globals.css');
const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]!).join('\n');
const motionOn = css.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g, '');

describe('the lifted cards of the client area, for who asked for less motion', () => {
  it.each([
    ['.clients__card', '.clients__card:hover'],
    ['a.client-general__block', 'a.client-general__block:hover']
  ])('lifts %s on hover with a transition, and neither inside the reduced-motion block', (card, hover) => {
    const base = card === 'a.client-general__block' ? '.client-general__block' : card;

    expect(declarationsFor(motionOn, hover).get('transform')).toBe('translateY(-2px)');
    expect(declarationsFor(motionOn, base).get('transition')).toBeDefined();

    expect(declarationsFor(reduced, hover).get('transform')).toBe('none');
    expect(declarationsFor(reduced, base).get('transition')).toBe('none');
  });
});
