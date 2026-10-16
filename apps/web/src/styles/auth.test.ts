import { describe, expect, it } from 'vitest';

import { contrastOf, declarationsFor, readStyles } from './theme-colors';

const css = readStyles('globals.css');
const rule = (selector: string) => declarationsFor(css, selector);

/** Every `.auth*` rule with its selector list, the media blocks included. */
const authRules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
  .map((match) => ({ selector: match[1]!.trim(), body: match[2]! }))
  .filter(({ selector }) => /(^|,\s*)\.auth/.test(selector));

describe('the entrada stylesheet', () => {
  it('finds the rules it checks', () => {
    expect(authRules.length).toBeGreaterThan(35);
  });

  it('takes colours, spacing and radius from tokens only', () => {
    const offenders: string[] = [];
    for (const { selector, body } of authRules) {
      for (const declaration of body.matchAll(/([\w-]+):\s*([^;]+);/g)) {
        const [property, value] = [declaration[1]!, declaration[2]!.trim()];
        const where = `${selector} { ${property}: ${value} }`;
        if (/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(value)) offenders.push(where);
        if (/^(color|background|border-color)$/.test(property) && !/var\(--/.test(value)) offenders.push(where);
        if (property === 'border-radius' && !/^var\(--radius-/.test(value)) offenders.push(where);
        if ((property === 'gap' || property === 'padding') && !/^(0|var\(--space-\d+\))( (0|var\(--space-\d+\)))*$/.test(value)) offenders.push(where);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('uses only three type steps, so no screen passes three text sizes', () => {
    const steps = new Set<string>();
    for (const { body } of authRules) for (const match of body.matchAll(/\bfont:\s*([^;]+);/g)) steps.add(match[1]!.trim());

    expect([...steps].sort()).toEqual(['var(--body-md)', 'var(--caption)', 'var(--heading-xl)']);
  });

  it('shows the brand panel only from 64rem up, flush left, with the mascot centred in it', () => {
    const base = css.match(/\.auth__visual \{\s*display: none;\s*\}/);
    expect(base).not.toBeNull();
    const wide = css.match(/@media \(min-width: 64rem\) \{[^@]*?\.auth__visual \{\s*grid-column: 1;/);
    expect(wide).not.toBeNull();
    expect(css.indexOf(base![0])).toBeLessThan(css.indexOf(wide![0]));
    const visual = rule('.auth__visual');
    expect(visual.get('display')).toBe('flex');
    expect(visual.get('align-items')).toBe('center');
    expect(visual.get('justify-content')).toBe('center');
    expect(visual.get('grid-column')).toBe('1');
    expect(rule('.auth__column').get('grid-column')).toBe('2');
    // Flush with the edge of the screen: no margin or border pushes the panel away from it.
    expect(visual.has('margin')).toBe(false);
    expect(visual.has('border-left')).toBe(false);
  });

  it('centres the form in its column on a wide screen', () => {
    expect(css).toMatch(/@media \(min-width: 64rem\) \{[^@]*?\.auth__main \{\s*align-items: center;/);
  });

  it('paints a problem in the danger text colour and a confirmation icon in the ready state colour', () => {
    expect(rule('.auth-message--danger').get('color')).toBe('var(--text-danger)');
    expect(rule('.auth-message--success .auth-message__icon').get('color')).toBe('var(--status-ready-fg)');
  });

  it('gives the link on the label row a 24px target', () => {
    expect(rule('.auth-field-link__link').get('min-height')).toBe('1.5rem');
  });

  it('keeps the solid indigo for the actions only', () => {
    // A tint (the brand panel) is a `color-mix` of it, not the solid fill.
    const solid = authRules.filter(({ body }) => /(?<!color-mix\(in srgb, )var\(--action-primary-bg\)/.test(body)).map(({ selector }) => selector).sort();

    expect(solid).toEqual(['.auth-check input']);
  });
});

/** The entrada is always light (decision 2026-10-14), so its pairs are conferred in the light theme. */
describe('contrast of the entrada pairs in the light theme', () => {
  it.each([
    ['the danger message on the page', rule('.auth-message--danger').get('color')!, 'var(--bg-canvas)'],
    ['the invitation note on the page', rule('.auth-note').get('color')!, 'var(--bg-canvas)'],
    ['the legal links on the page', rule('.auth__legal a').get('color')!, 'var(--bg-canvas)'],
    ['the lead on the page', rule('.auth-panel__head p').get('color')!, 'var(--bg-canvas)'],
    ['the panel title on the brand tint', rule('.auth-visual__title').get('color')!, rule('.auth__visual').get('background')!],
    ['the panel lead on the brand tint', rule('.auth-visual__lead').get('color')!, rule('.auth__visual').get('background')!],
    ['the invitation labels on their panel', rule('.auth-details dt').get('color')!, rule('.auth-details').get('background')!],
  ])('%s is AA', (_name, fg, bg) => {
    expect(contrastOf('light', fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the confirmation icon 3:1 on the page', () => {
    expect(contrastOf('light', rule('.auth-message--success .auth-message__icon').get('color')!, 'var(--bg-canvas)')).toBeGreaterThanOrEqual(3);
  });
});
