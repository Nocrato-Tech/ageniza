import { describe, expect, it } from 'vitest';

import { declarationsFor, readStyles } from './theme-colors';

const css = readStyles('globals.css');
const reducedMotion = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]!).join('\n');
/** The stylesheet as it is for people who have not asked for less motion. */
const motionOn = css.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g, '');

describe('the media library in the redesign', () => {
  it('lifts a folder card on hover, and keeps it still for whoever asked for less motion', () => {
    expect(declarationsFor(motionOn, '.folder:hover').get('transform')).toBe('translateY(-2px)');
    expect(declarationsFor(reducedMotion, '.folder:hover').get('transform')).toBe('none');
  });

  it('draws the shadow of the preview from a token, never from a fixed colour', () => {
    expect(declarationsFor(css, '.media-detail__preview .media-thumbnail').get('box-shadow')).toBe('var(--shadow-floating)');
  });
});
