// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contrastOf, declarationsFor, readStyles } from './styles/theme-colors';

/**
 * The layout of the brand study lives in CSS, which jsdom does not lay out: these tests read the block
 * (telas-melhorias S13) and pin what keeps every control reachable at 390 px and what keeps the portal's rows as they were.
 */
const raw = readFileSync(join(__dirname, 'styles/globals.css'), 'utf8').replace(/\r\n/g, '\n');
const START = '/* Brand study, agency side (telas-melhorias, S13)';
const END = '/* The conversation about one subject (issue #142)';
const block = raw.slice(raw.indexOf(START), raw.indexOf(END)).replace(/\/\*[\s\S]*?\*\//g, '');
const css = readStyles('globals.css');

/** The rules of the block outside any media query: what a 390 px screen gets. */
const baseOf = (text: string): string => {
  let out = '';
  let depth = 0;
  let inMedia = false;
  for (const char of text) {
    if (char === '{') {
      depth += 1;
      if (depth === 1 && /@media[^{]*$/.test(out)) { inMedia = true; out = out.replace(/@media[^{]*$/, ''); continue; }
    }
    if (char === '}') {
      depth -= 1;
      if (inMedia && depth === 0) { inMedia = false; continue; }
    }
    if (!inMedia) out += char;
  }
  return out;
};

/** The text of every `@media (min-width: <width>) { ... }` in the block. */
const mediaOf = (text: string, width: string): string => {
  const found: string[] = [];
  const open = `@media (min-width: ${width}) {`;
  let from = text.indexOf(open);
  while (from >= 0) {
    let depth = 0;
    let end = from + open.length - 1;
    for (let at = end; at < text.length; at += 1) {
      if (text[at] === '{') depth += 1;
      if (text[at] === '}') { depth -= 1; if (depth === 0) { end = at; break; } }
    }
    found.push(text.slice(from + open.length, end));
    from = text.indexOf(open, end);
  }
  return found.join('\n');
};

const base = baseOf(block);

describe('brand study layout (telas-melhorias S13)', () => {
  it('has its own block, made only of tokens and scoped, so the portal keeps the shared classes it has', () => {
    expect(raw.indexOf(START)).toBeGreaterThan(0);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
    expect(block).not.toMatch(/font(-size)?:\s*[\d.]+(px|rem)/);
    const selectors = Array.from(block.matchAll(/^\s*([^\s/*}@][^{}]*)\{/gm)).map((match) => match[1]!.trim());
    expect(selectors.length).toBeGreaterThan(20);
    // Everything in the block is new to the agency screen or sits under its modifier: no bare shared selector is restyled.
    expect(selectors.filter((selector) => !/^\.(brand-study--agency|brand-index|brand-panel|brand-persona|brand-personas__awaiting|brand-personas__archived-item|brand-archetype|brand-card-skeleton|brand-section__header-action)/.test(selector))).toEqual([]);
    // The shared section row of the portal still has its line on top and its own header.
    const section = declarationsFor(css, '.brand-section');
    expect(section.get('border-top')).toBe('1px solid var(--border-default)');
    expect(section.get('padding-top')).toBe('var(--space-6)');
  });

  it('never hides a control: nothing in the block is display: none or invisible, so a 390 px screen loses none of the previous version', () => {
    expect(block).not.toMatch(/display:\s*none|visibility:\s*hidden/);
  });

  it('draws the index as a row that scrolls sideways at 390 px, with every link kept at its size and a 44 px target', () => {
    const list = declarationsFor(base, '.brand-index__list');
    expect([list.get('display'), list.get('overflow-x'), list.get('flex-direction')]).toEqual(['flex', 'auto', undefined]);
    expect(declarationsFor(base, '.brand-index__list > li').get('flex')).toBe('none');
    const link = declarationsFor(base, '.brand-index__link');
    expect(link.get('white-space')).toBe('nowrap');
    expect(link.get('min-height')).toBe('2.75rem');
    // The page never scrolls sideways: the layout has one column that can shrink, and the index is allowed to.
    expect(declarationsFor(base, '.brand-study--agency .brand-study__layout').get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declarationsFor(base, '.brand-index').get('min-width')).toBe('0');
    expect(declarationsFor(base, '.brand-study--agency .brand-study__main').get('min-width')).toBe('0');
  });

  it('turns the index into a column from 64 rem and puts the conversations beside the card only from 80 rem', () => {
    const wide = mediaOf(block, '64rem');
    expect(declarationsFor(wide, '.brand-study--agency .brand-study__layout').get('grid-template-columns')).toBe('17rem minmax(0, 1fr)');
    expect(declarationsFor(wide, '.brand-index__list').get('flex-direction')).toBe('column');
    expect(declarationsFor(wide, '.brand-index__list').get('overflow')).toBe('visible');
    expect(declarationsFor(base, '.brand-panel__layout').get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declarationsFor(mediaOf(block, '80rem'), '.brand-panel__layout').get('grid-template-columns')).toBe('minmax(0, 1fr) 20rem');
  });

  it('lets the card, the profile and the colours shrink at 390 px instead of pushing the page', () => {
    expect(declarationsFor(base, '.brand-panel__layout').get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declarationsFor(base, '.brand-panel__main').get('min-width')).toBe('0');
    expect(declarationsFor(base, '.brand-persona__profile').get('grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declarationsFor(mediaOf(block, '48rem'), '.brand-persona__profile').get('grid-template-columns')).toBe('16rem minmax(0, 1fr)');
    expect(declarationsFor(base, '.brand-persona__identity').get('min-width')).toBe('0');
    expect(declarationsFor(base, '.brand-persona__name').get('overflow-wrap')).toBe('anywhere');
    expect(declarationsFor(base, '.brand-persona__description').get('overflow-wrap')).toBe('anywhere');
    expect(declarationsFor(base, '.brand-archetype').get('overflow-wrap')).toBe('anywhere');
    expect(declarationsFor(base, '.brand-study--agency .brand-section__header h3').get('min-width')).toBe('0');
    expect(declarationsFor(css, '.brand-personas__list').get('grid-template-columns')).toBe('repeat(auto-fill, minmax(min(100%, 22rem), 1fr))');
    expect(declarationsFor(css, '.brand-colors').get('grid-template-columns')).toBe('repeat(auto-fill, minmax(8rem, 1fr))');
  });

  it('puts the edit action in the header of the card, beside the title and above who edited it', () => {
    expect(declarationsFor(base, '.brand-section__header-action').get('order')).toBe('2');
    expect(declarationsFor(base, '.brand-study--agency .brand-section__updated').get('order')).toBe('3');
    expect(declarationsFor(base, '.brand-study--agency .brand-section__updated').get('flex-basis')).toBe('100%');
    const card = declarationsFor(base, '.brand-study--agency .brand-section');
    expect([card.get('background'), card.get('border-radius')]).toEqual(['var(--bg-surface)', 'var(--radius-xl)']);
  });

  it('sets the archetype on the headline size and the persona name on the title size, and keeps the screen to the type scale of the board', () => {
    expect(declarationsFor(base, '.brand-archetype').get('font')).toBe('var(--heading-xl)');
    expect(declarationsFor(base, '.brand-persona__name').get('font')).toBe('var(--heading-lg)');
    const fonts = new Set(Array.from(block.matchAll(/font:\s*(var\(--[\w-]+\))/g)).map((match) => match[1]));
    expect([...fonts].sort()).toEqual(['var(--body-md)', 'var(--heading-lg)', 'var(--heading-xl)', 'var(--label-md)', 'var(--title-md)']);
  });

  it('reacts on the edge, never on the fill: no link or card of the index turns bg/hover under its text', () => {
    expect(block).not.toMatch(/var\(--bg-hover\)/);
    expect(declarationsFor(base, '.brand-index__link:hover').get('border-color')).toBe('var(--border-control)');
    expect(declarationsFor(css, '.brand-personas__card:hover').get('border-color')).toBe('var(--border-control)');
    expect(declarationsFor(css, '.brand-personas__card:hover').get('background')).toBeUndefined();
  });

  it('draws the index as a card with the count and a bar, and tells filled from open by shape, not only by colour', () => {
    const side = declarationsFor(base, '.brand-study--agency .brand-study__side');
    expect([side.get('background'), side.get('border-radius')]).toEqual(['var(--bg-surface)', 'var(--radius-xl)']);
    expect(declarationsFor(base, '.brand-study--agency .brand-study__progress').get('width')).toBe('100%');
    expect(declarationsFor(base, '.brand-index__dot--done').get('background')).toBe('var(--status-ready-bg)');
    // An open section is an empty ring and a filled one holds a check: the two differ without the colour.
    expect(declarationsFor(base, '.brand-index__dot--open').get('border')).toBe('1.5px solid var(--border-control)');
    expect(declarationsFor(base, ".brand-index__link[aria-current='page']").get('background')).toBe('var(--bg-tint)');
  });

  it('draws each conversation of the agency as a card with its status on the right, and the status under the text in the narrow column', () => {
    const thread = declarationsFor(css, '.conversation--agency .conversation__thread');
    expect([thread.get('grid-template-columns'), thread.get('border-radius')]).toEqual(['minmax(0, 1fr) auto', 'var(--radius-lg)']);
    const status = declarationsFor(css, '.conversation--agency .conversation__thread > .conversation__status');
    expect([status.get('grid-column'), status.get('justify-self')]).toEqual(['2', 'end']);
    const narrow = declarationsFor(mediaOf(block, '80rem'), '.brand-study--agency .brand-panel__conversations .conversation__thread > .conversation__status');
    expect([narrow.get('grid-column'), narrow.get('order')]).toEqual(['1', '6']);
    expect(declarationsFor(css, '.conversation--agency .conversation__status--resolved').get('background')).toBe('var(--status-ready-bg)');
  });

  it.each(['light'] as const)('keeps the index and the cards readable in the %s theme', (theme) => {
    // The index sits on the canvas; the open link and every card sit on the surface.
    expect(contrastOf(theme, 'var(--text-secondary)', 'var(--bg-canvas)')).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf(theme, 'var(--text-primary)', 'var(--bg-surface)')).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf(theme, 'var(--text-secondary)', 'var(--bg-surface)')).toBeGreaterThanOrEqual(4.5);
    // The edge of the open link is a boundary of an interface part: 3:1 on the surface.
    expect(contrastOf(theme, 'var(--border-control)', 'var(--bg-surface)')).toBeGreaterThanOrEqual(3);
  });
});
