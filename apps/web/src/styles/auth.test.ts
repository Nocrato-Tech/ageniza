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
    expect(authRules.length).toBeGreaterThan(40);
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

  it('shows the example week only from 64rem up', () => {
    expect(rule('.auth__showcase').get('display')).toBe('flex');
    const base = css.match(/\.auth__showcase \{\s*display: none;\s*\}/);
    expect(base).not.toBeNull();
    const wide = css.match(/@media \(min-width: 64rem\) \{[^@]*?\.auth__showcase \{\s*display: flex;/);
    expect(wide).not.toBeNull();
    expect(css.indexOf(base![0])).toBeLessThan(css.indexOf(wide![0]));
  });

  it('paints a problem in the danger text colour and a confirmation icon in the ready state colour', () => {
    expect(rule('.auth-message--danger').get('color')).toBe('var(--text-danger)');
    expect(rule('.auth-message--success .auth-message__icon').get('color')).toBe('var(--status-ready-fg)');
  });

  it('gives the link on the label row a 24px target', () => {
    expect(rule('.auth-field-link__link').get('min-height')).toBe('1.5rem');
  });

  it('keeps the solid indigo for today and the actions only', () => {
    const solid = authRules.filter(({ body }) => /var\(--action-primary-bg\)/.test(body)).map(({ selector }) => selector).sort();

    expect(solid).toEqual(['.auth-check input', '.auth-day__today']);
  });
});

/** The entrada is always light (decision 2026-10-14), so its pairs are conferred in the light theme. */
describe('contrast of the entrada pairs in the light theme', () => {
  it.each([
    ['the danger message on the page', rule('.auth-message--danger').get('color')!, 'var(--bg-canvas)'],
    ['the invitation note on the page', rule('.auth-note').get('color')!, 'var(--bg-canvas)'],
    ['the legal links on the page', rule('.auth__legal a').get('color')!, 'var(--bg-canvas)'],
    ['the lead on the page', rule('.auth-panel__head p').get('color')!, 'var(--bg-canvas)'],
    ['the invitation labels on their panel', rule('.auth-details dt').get('color')!, rule('.auth-details').get('background')!],
    ['the example lead on its panel', rule('.auth-showcase__lead').get('color')!, rule('.auth__showcase').get('background')!],
    ['the example header on its card', rule('.auth-week__head').get('color')!, rule('.auth-week').get('background')!],
    ['the example day label on its card', rule('.auth-day__label').get('color')!, rule('.auth-week').get('background')!],
    ['the example note on today', rule('.auth-day__note').get('color')!, rule('.auth-day--today').get('background')!],
    ['today mark on its fill', rule('.auth-day__today').get('color')!, rule('.auth-day__today').get('background')!],
    ['the reels title on its card', rule('.auth-post--reels').get('color')!, rule('.auth-post--reels').get('background')!],
    ['the carousel title on its card', rule('.auth-post--carousel').get('color')!, rule('.auth-post--carousel').get('background')!],
    ['the reels tag on its fill', rule('.auth-tag--reels').get('color')!, rule('.auth-tag--reels').get('background')!],
    ['the carousel tag on its fill', rule('.auth-tag--carousel').get('color')!, rule('.auth-tag--carousel').get('background')!],
    ['the state label on a reels card', rule('.auth-state').get('color')!, rule('.auth-post--reels').get('background')!],
    ['the state label on a carousel card', rule('.auth-state').get('color')!, rule('.auth-post--carousel').get('background')!]
  ])('%s is AA', (_name, fg, bg) => {
    expect(contrastOf('light', fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['late', '.auth-state__icon--late', 'var(--bg-canvas)'],
    ['adjust', '.auth-state__icon--adjust', 'var(--format-carousel-bg)'],
    ['waiting', '.auth-state__icon--waiting', 'var(--format-reels-bg)']
  ])('the %s state icon is 3:1 on its card (non-text)', (_name, selector, bg) => {
    expect(contrastOf('light', rule(selector).get('color')!, bg)).toBeGreaterThanOrEqual(3);
  });

  it('keeps the confirmation icon 3:1 on the page', () => {
    expect(contrastOf('light', rule('.auth-message--success .auth-message__icon').get('color')!, 'var(--bg-canvas)')).toBeGreaterThanOrEqual(3);
  });
});
