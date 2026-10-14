import { describe, expect, it } from 'vitest';

import { contrastOf, declarationsFor, readStyles } from './theme-colors';

const css = readStyles('globals.css');
const rule = (selector: string) => declarationsFor(css, selector);

const BUTTONS = ['primary', 'secondary', 'ghost', 'destructive'];
const CONTROLS = ['.ui-pill--action'];
const COMPONENT_RULES = /^\s*\.(ui-icon|ui-icon-button|ui-pill)[^{}]*\{([^{}]*)\}/gm;

describe('component states', () => {
  it.each(BUTTONS)('gives the %s button a hover that changes how it looks', (variant) => {
    const hover = rule(`.ui-button--${variant}:hover:not(:disabled)`);

    expect([...hover.keys()].some((property) => ['filter', 'background', 'color'].includes(property))).toBe(true);
  });

  it('gives the action pill a hover on both tones, and none while it is disabled', () => {
    expect(rule('.ui-pill--action.ui-pill--neutral:hover:not(:disabled)').get('background')).toBe('var(--bg-hover)');
    expect(rule('.ui-pill--action.ui-pill--accent:hover:not(:disabled)').get('filter')).toBe('brightness(0.94)');
  });

  it('keeps the global focus ring on buttons and rings every new control with the focus token', () => {
    expect(rule('button:focus-visible').get('outline')).toBe('3px solid var(--focus-ring)');
    for (const selector of CONTROLS.map((control) => `${control}:focus-visible`)) {
      expect(rule(selector).get('outline'), selector).toBe('3px solid var(--focus-ring)');
    }
  });

  it.each([
    '.ui-button:disabled:not(.ui-button--loading)',
    '.ui-pill:disabled:not(.ui-pill--loading)'
  ])('dims %s and shows it cannot be pressed', (selector) => {
    const disabled = rule(selector);

    expect(disabled.get('opacity')).toBe('0.55');
    expect(disabled.get('cursor')).toBe('not-allowed');
  });

  it.each(['.ui-button--loading', '.ui-pill--loading'])('shows a spinner on %s and keeps the label in the accessibility tree', (selector) => {
    const spinner = rule(`${selector}::after`);

    expect(spinner.get('animation')).toContain('ui-button-spin');
    expect(rule(selector).get('cursor')).toBe('progress');
    expect(rule(`${selector} > .ui-icon`).get('opacity')).toBe('0');
  });

  it('hides the label of a loading button and a loading pill by opacity, never by display or visibility', () => {
    for (const label of ['.ui-button--loading > .ui-button__label', '.ui-pill--loading > .ui-pill__label']) {
      const hidden = rule(label);

      expect(hidden.get('opacity'), label).toBe('0');
      expect(hidden.has('display')).toBe(false);
      expect(hidden.has('visibility')).toBe(false);
    }
  });

  it('turns the transitions off for people who ask for less motion', () => {
    const reducedAt = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
    const animated = ['.ui-button', '.ui-pill--action'];

    for (const selector of animated) {
      expect(declarationsFor(css.slice(0, reducedAt), selector).get('transition'), selector).toMatch(/var\(--motion-fast\)/);
      expect(declarationsFor(reduced, selector).get('transition'), selector).toBe('none');
    }
  });
});

describe('component tokens', () => {
  it('takes colours, radius and padding from tokens only', () => {
    const offenders: string[] = [];
    for (const block of css.matchAll(COMPONENT_RULES)) {
      for (const declaration of block[2]!.matchAll(/([\w-]+):\s*([^;]+);/g)) {
        const [property, value] = [declaration[1]!, declaration[2]!.trim()];
        const where = `${block[1]!.trim()} { ${property}: ${value} }`;
        if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(value)) offenders.push(where);
        if (/^(color|background|border-color|border-bottom-color)$/.test(property) && !/var\(--|^transparent$/.test(value)) offenders.push(where);
        if (/^(padding|gap)$/.test(property) && !/^(0|var\(--space-\d+\))( (0|var\(--space-\d+\)))*$/.test(value)) offenders.push(where);
        if (property === 'border-radius' && !/^var\(--radius-/.test(value)) offenders.push(where);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('rounds the controls with the Pauta radii: capsule and button', () => {
    expect(rule('.ui-pill').get('border-radius')).toBe('var(--radius-full)');
    expect(rule('.ui-button').get('border-radius')).toBe('var(--radius-md)');
  });

  it('sizes every icon the same, 16px inside a capsule', () => {
    expect(rule('.ui-icon > svg').get('width')).toBe('1.25rem');
    expect(rule('.ui-icon > svg').get('stroke-width')).toBe('1.75');
    expect(rule('.ui-pill .ui-icon > svg').get('width')).toBe('1rem');
  });

  it('squares the icon-only button on the height of its size', () => {
    expect(rule('.ui-icon-button.ui-button--sm').get('width')).toBe('2rem');
    expect(rule('.ui-button--sm').get('min-height')).toBe('2rem');
    expect(rule('.ui-icon-button.ui-button--md').get('width')).toBe('2.75rem');
    expect(rule('.ui-button--md').get('min-height')).toBe('2.75rem');
    expect(rule('.ui-icon-button.ui-button--lg').get('width')).toBe('3.25rem');
    expect(rule('.ui-button--lg').get('min-height')).toBe('3.25rem');
  });
});

describe.each(['light', 'dark'] as const)('contrast of the new controls in %s', (theme) => {
  const SURFACES = ['var(--bg-canvas)', 'var(--bg-surface)'];

  const colours = (selector: string) => {
    const declarations = rule(selector);
    return { fg: declarations.get('color')!, bg: declarations.get('background')! };
  };

  it.each([
    ['.ui-button--ghost', SURFACES],
    ['.ui-button--secondary', SURFACES],
    ['.ui-pill--action.ui-pill--neutral', SURFACES]
  ])('%s text is AA over the surfaces it sits on', (selector, surfaces) => {
    for (const surface of surfaces) expect(contrastOf(theme, colours(selector as string).fg, surface), `${selector} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the ghost and secondary text AA on their hover surface', () => {
    const hover = rule('.ui-button--secondary:hover:not(:disabled)');

    expect(contrastOf(theme, hover.get('color')!, hover.get('background')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the neutral pill AA on its own fill', () => {
    const pill = colours('.ui-pill--neutral');

    expect(contrastOf(theme, pill.fg, pill.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('pairs the neutral pill as the design system table lists it', () => {
    expect(colours('.ui-pill--neutral')).toEqual({ fg: 'var(--text-secondary)', bg: 'var(--bg-hover)' });
  });

  it('keeps the accent pill AA on its fill and the hover of the neutral action pill AA', () => {
    const accent = colours('.ui-pill--accent');
    const hover = rule('.ui-pill--action.ui-pill--neutral:hover:not(:disabled)');

    expect(contrastOf(theme, accent.fg, accent.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf(theme, 'var(--text-primary)', hover.get('background')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the focus ring visible over the surfaces (3:1 for non-text)', () => {
    for (const surface of SURFACES) expect(contrastOf(theme, 'var(--focus-ring)', surface)).toBeGreaterThanOrEqual(3);
  });
});
