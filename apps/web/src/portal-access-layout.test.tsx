// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { declarationsFor, readStyles } from './styles/theme-colors';

/** jsdom does not lay out: these tests read the stylesheet of the access tab and pin what keeps every control reachable at 390 px. */
const block = readStyles('screens/portal-access.css');
const css = readStyles('globals.css');

const wide = (() => {
  const open = '@media (min-width: 64rem) {';
  const from = block.indexOf(open);
  return from < 0 ? '' : block.slice(from + open.length).replace(/^ {2}/gm, '');
})();
const base = block.slice(0, block.indexOf('@media'));

describe('portal access layout (w5, tela 5.C)', () => {
  it('is made of tokens only, never hides a control and never puts text over bg-hover', () => {
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    expect(block).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(block).not.toMatch(/var\(--bg-hover\)/);
  });

  it('is one column that can shrink at 390 px, with the rows and their actions wrapping inside the card', () => {
    expect(declarationsFor(base, '.portal-access__split').get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declarationsFor(base, '.portal-access__main').get('min-width')).toBe('0');
    const row = declarationsFor(base, '.portal-access__ask');
    expect([row.get('display'), row.get('flex-wrap'), row.get('min-width')]).toEqual(['flex', 'wrap', '0']);
    const actions = declarationsFor(base, '.portal-access__actions');
    expect([actions.get('flex-wrap'), actions.get('flex')]).toEqual(['wrap', '1 1 100%']);
    expect(declarationsFor(base, '.portal-access__who').get('min-width')).toBe('0');
    expect(declarationsFor(base, '.portal-access__email-strong').get('overflow-wrap')).toBe('anywhere');
    expect(declarationsFor(base, '.portal-access__share q').get('overflow-wrap')).toBe('anywhere');
  });

  it('puts the ready message beside the list from 64 rem, sticky, and under it before that', () => {
    expect(declarationsFor(wide, '.portal-access__split').get('grid-template-columns')).toBe('minmax(0, 1fr) 22rem');
    expect(declarationsFor(wide, '.portal-access__side').get('position')).toBe('sticky');
    expect(declarationsFor(base, '.portal-access__side').get('position')).toBeUndefined();
  });

  it('keeps the shared rules the brand study uses for its own button', () => {
    expect(declarationsFor(css, '.brand-personas > .ui-button').get('justify-self')).toBe('start');
  });
});
