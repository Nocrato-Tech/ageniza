import { describe, expect, it } from 'vitest';

import { contrastOf, declarationsFor, readStyles, rgbOf, themes } from './theme-colors';

const css = readStyles('globals.css');
const rule = (selector: string) => declarationsFor(css, selector);
const reducedMotionBlocks = () => [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((match) => match[1]!).join(' ');

const BUTTONS = ['primary', 'secondary', 'ghost', 'destructive'];
const CONTROLS = ['.ui-pill--action', '.ui-segmented__option', '.ui-tabs__tab', '.ui-tabs__panel'];
const COMPONENT_RULES = /^\s*\.(ui-icon|ui-icon-button|ui-pill|ui-segmented|ui-tabs|ui-field|ui-text-input|ui-select|ui-textarea|ui-popover|ui-popover-anchor)[^{}]*\{([^{}]*)\}/gm;

describe('component states', () => {
  it.each(BUTTONS)('gives the %s button a hover that changes how it looks', (variant) => {
    const hover = rule(`.ui-button--${variant}:hover:not(:disabled):not(.ui-button--loading)`);

    expect([...hover.keys()].some((property) => ['filter', 'background', 'color'].includes(property))).toBe(true);
  });

  it('gives the action pill a hover on both tones, and none while it is disabled', () => {
    expect(rule('.ui-pill--action.ui-pill--neutral:hover:not(:disabled):not(.ui-pill--loading)').get('background')).toBe('var(--bg-hover)');
    expect(rule('.ui-pill--action.ui-pill--accent:hover:not(:disabled):not(.ui-pill--loading)').get('filter')).toBe('brightness(0.94)');
  });

  it('raises the text of an unchosen option and a tab on hover, never their background', () => {
    const option = rule(".ui-segmented__option:hover:not(:disabled):not([aria-disabled='true']):not([aria-checked='true'])");
    const tab = rule('.ui-tabs__tab:hover:not(:disabled)');

    expect(option.get('color')).toBe('var(--text-primary)');
    expect(option.has('background')).toBe(false);
    expect(tab.get('color')).toBe('var(--text-primary)');
    expect(tab.has('background')).toBe(false);
  });

  it('keeps the global focus ring on buttons and rings every new control with the focus token', () => {
    expect(rule('button:focus-visible').get('outline')).toBe('3px solid var(--focus-ring)');
    for (const selector of CONTROLS.map((control) => `${control}:focus-visible`)) {
      expect(rule(selector).get('outline'), selector).toBe('3px solid var(--focus-ring)');
    }
  });

  it('underlines only the open tab, in ink and never in indigo', () => {
    const open = rule(".ui-tabs__tab[aria-selected='true']");

    expect(open.get('border-bottom-color')).toBe('var(--text-primary)');
    expect(rule('.ui-tabs__tab').get('border-bottom')).toBe('2px solid transparent');
    expect(rule('.ui-tabs__list').get('border-bottom')).toBe('1px solid var(--border-subtle)');
  });

  it('insets the ring of a tab, which sits inside a scroll box that would clip an outer one', () => {
    expect(rule('.ui-tabs__tab:focus-visible').get('outline-offset')).toBe('-3px');
  });

  it.each([
    '.ui-button:disabled:not(.ui-button--loading)',
    '.ui-pill:disabled:not(.ui-pill--loading)',
    '.ui-segmented__option:disabled',
    '.ui-tabs__tab:disabled'
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

  it('shows the busy cursor on a segmented control that is loading', () => {
    expect(rule(".ui-segmented[aria-busy='true']").get('cursor')).toBe('progress');
    expect(rule(".ui-segmented__option[aria-disabled='true']").get('cursor')).toBe('progress');
    expect(rule(".ui-segmented__option[aria-disabled='true']").get('opacity')).toBe('0.55');
  });

  it('turns the transitions off for people who ask for less motion', () => {
    const reducedAt = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)![1]!;
    const animated = ['.ui-button', '.ui-pill--action', '.ui-segmented__option', '.ui-tabs__tab'];

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

  it('rounds the controls with the Pauta radii: capsule, field, panel', () => {
    expect(rule('.ui-pill').get('border-radius')).toBe('var(--radius-full)');
    expect(rule('.ui-segmented__option').get('border-radius')).toBe('var(--radius-md)');
    expect(rule('.ui-segmented').get('border-radius')).toBe('var(--radius-lg)');
    expect(rule('.ui-button').get('border-radius')).toBe('var(--radius-md)');
  });

  it('sizes every icon the same, 16px inside a capsule or a tab', () => {
    expect(rule('.ui-icon > svg').get('width')).toBe('1.25rem');
    expect(rule('.ui-icon > svg').get('stroke-width')).toBe('1.75');
    expect(rule('.ui-pill .ui-icon > svg').get('width')).toBe('1rem');
    expect(rule('.ui-tabs__tab .ui-icon > svg').get('height')).toBe('1rem');
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
    ['.ui-pill--action.ui-pill--neutral', SURFACES],
    ['.ui-segmented__option', ['var(--bg-surface)']],
    ['.ui-tabs__tab', SURFACES]
  ])('%s text is AA over the surfaces it sits on', (selector, surfaces) => {
    for (const surface of surfaces) expect(contrastOf(theme, colours(selector as string).fg, surface), `${selector} on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the ghost and secondary text AA on their hover surface', () => {
    const hover = rule('.ui-button--secondary:hover:not(:disabled):not(.ui-button--loading)');

    expect(contrastOf(theme, hover.get('color')!, hover.get('background')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the tab text AA when selected', () => {
    for (const surface of SURFACES) {
      expect(contrastOf(theme, rule(".ui-tabs__tab[aria-selected='true']").get('color')!, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the neutral pill and the chosen option AA on their own fill', () => {
    const pill = colours('.ui-pill--neutral');
    const option = colours(".ui-segmented__option[aria-checked='true']");

    expect(contrastOf(theme, pill.fg, pill.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf(theme, option.fg, option.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('pairs the neutral pill and the chosen option as the design system table lists them', () => {
    expect(colours('.ui-pill--neutral')).toEqual({ fg: 'var(--text-secondary)', bg: 'var(--bg-hover)' });
    expect(colours(".ui-segmented__option[aria-checked='true']")).toEqual({ fg: 'var(--text-primary)', bg: 'var(--bg-hover)' });
  });

  it('keeps the accent pill AA on its fill and the hover of the neutral action pill AA', () => {
    const accent = colours('.ui-pill--accent');
    const hover = rule('.ui-pill--action.ui-pill--neutral:hover:not(:disabled):not(.ui-pill--loading)');

    expect(contrastOf(theme, accent.fg, accent.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf(theme, 'var(--text-primary)', hover.get('background')!)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the focus ring visible over the surfaces (3:1 for non-text)', () => {
    for (const surface of SURFACES) expect(contrastOf(theme, 'var(--focus-ring)', surface)).toBeGreaterThanOrEqual(3);
  });
});

const CONTROLS_WITH_EDGE = ['.ui-text-input', '.ui-select', '.ui-textarea', '.ui-choice-card'];

describe('border/control', () => {
  it('is built from existing primitives, with no new colour', () => {
    expect(themes.light.get('--border-control')).toBe('color-mix(in srgb, var(--color-slate-400) 40%, var(--color-ink-600))');
    expect(themes.dark.get('--border-control')).toBe(themes.light.get('--border-control'));
  });

  it('resolves to #6D7989', () => {
    expect(rgbOf('var(--border-control)', 'dark').map(Math.round)).toEqual([0x6d, 0x79, 0x89]);
    expect(rgbOf('var(--border-control)', 'light').map(Math.round)).toEqual([0x6d, 0x79, 0x89]);
  });

  it.each(['light', 'dark'] as const)('is 3:1 on the surface and on the canvas in %s', (theme) => {
    expect(contrastOf(theme, 'var(--border-control)', 'var(--bg-surface)')).toBeGreaterThanOrEqual(3);
    expect(contrastOf(theme, 'var(--border-control)', 'var(--bg-canvas)')).toBeGreaterThanOrEqual(3);
  });

  it('is the edge of the input, the select, the textarea and the choice card', () => {
    for (const selector of CONTROLS_WITH_EDGE) expect(rule(selector).get('border'), selector).toBe('1px solid var(--border-control)');
  });

  it('leaves the decorative borders on border/default', () => {
    expect(rule('.ui-avatar').has('border')).toBe(false);
    expect(rule('.ui-button--secondary').get('border-color')).toBe('var(--border-default)');
    expect(rule('.ui-pill--action.ui-pill--neutral').get('border-color')).toBe('var(--border-default)');
  });

  it('rounds the fields like the Pauta button and field radius', () => {
    for (const selector of CONTROLS_WITH_EDGE) expect(rule(selector).get('border-radius'), selector).toBe('var(--radius-md)');
  });
});

describe('field states', () => {
  const FIELDS = ['.ui-text-input', '.ui-select', '.ui-textarea'];

  it('darkens the edge on hover but never while disabled', () => {
    for (const selector of FIELDS) expect(rule(`${selector}:hover:not(:disabled)`).get('border-color'), selector).toBe('var(--text-muted)');
  });

  it('draws the invalid edge in the danger text colour', () => {
    for (const selector of FIELDS) expect(rule(`${selector}[aria-invalid='true']:not(:disabled)`).get('border-color'), selector).toBe('var(--text-danger)');
  });

  it('dims a disabled field and shows it cannot be used', () => {
    for (const selector of ['.ui-text-input:disabled', '.ui-select:disabled', '.ui-textarea:disabled']) {
      expect(rule(selector).get('opacity'), selector).toBe('0.55');
      expect(rule(selector).get('cursor'), selector).toBe('not-allowed');
    }
    expect(rule('.ui-field:has(:disabled) > .ui-field__label').get('opacity')).toBe('0.55');
  });

  it('keeps the focus ring on every field, the select included', () => {
    for (const selector of ['input:focus-visible', 'select:focus-visible', 'textarea:focus-visible']) {
      expect(rule(selector).get('outline'), selector).toBe('3px solid var(--focus-ring)');
    }
  });

  it('shows a spinner after the label of a loading field', () => {
    const spinner = rule('.ui-field--loading > .ui-field__label::after');

    expect(spinner.get('animation')).toContain('ui-button-spin');
    expect(spinner.get('content')).toBe("''");
  });

  it('colours the placeholder and the counter from tokens that pass AA on the surface', () => {
    expect(rule('.ui-text-input::placeholder').get('color')).toBe('var(--text-muted)');
    expect(rule('.ui-field__counter--over').get('color')).toBe('var(--text-danger)');
    for (const theme of ['light', 'dark'] as const) {
      expect(contrastOf(theme, 'var(--text-muted)', 'var(--bg-surface)')).toBeGreaterThanOrEqual(4.5);
      expect(contrastOf(theme, 'var(--text-danger)', 'var(--bg-surface)')).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('turns the edge transition off for people who ask for less motion', () => {
    const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)];
    const reduced = blocks.map((match) => match[1]!).join(' ');

    expect(declarationsFor(reduced, '.ui-text-input').get('transition')).toBe('none');
    expect(declarationsFor(reduced, '.ui-select').get('transition')).toBe('none');
    expect(declarationsFor(reduced, '.ui-textarea').get('transition')).toBe('none');
  });
});

describe('dialog and popover', () => {
  it('lifts the dialog on the floating shadow with the modal radius, on the surface', () => {
    const modal = rule('.ui-modal');

    expect(modal.get('border-radius')).toBe('var(--radius-xl)');
    expect(modal.get('box-shadow')).toBe('var(--shadow-floating)');
    expect(modal.get('background')).toBe('var(--bg-surface)');
    expect(modal.get('border')).toBe('1px solid var(--border-default)');
  });

  it('sizes the dialog small, medium and large, and keeps it inside the screen', () => {
    expect(rule('.ui-modal--sm').get('width')).toBe('min(calc(100% - var(--space-8)), 28rem)');
    expect(rule('.ui-modal').get('width')).toBe('min(calc(100% - var(--space-8)), 40rem)');
    expect(rule('.ui-modal--lg').get('width')).toBe('min(calc(100% - var(--space-8)), 52rem)');
    expect(rule('.ui-modal').get('max-height')).toBe('calc(100dvh - var(--space-8))');
  });

  it('puts the actions at the foot, to the right', () => {
    const foot = rule('.ui-modal__actions');

    expect(foot.get('justify-content')).toBe('flex-end');
    expect(foot.get('flex-wrap')).toBe('wrap');
  });

  it('floats the popover on the elevated surface with the floating shadow, above the page', () => {
    const popover = rule('.ui-popover');

    expect(popover.get('background')).toBe('var(--bg-elevated)');
    expect(popover.get('box-shadow')).toBe('var(--shadow-floating)');
    expect(popover.get('border-radius')).toBe('var(--radius-lg)');
    expect(popover.get('position')).toBe('absolute');
    expect(popover.get('z-index')).toBe('20');
    expect(rule('.ui-popover-anchor').get('position')).toBe('relative');
  });

  it('anchors each placement to its own corner', () => {
    expect(rule('.ui-popover--bottom-start').get('top')).toBe('calc(100% + var(--space-2))');
    expect(rule('.ui-popover--bottom-end').get('top')).toBe('calc(100% + var(--space-2))');
    expect(rule('.ui-popover--top-start').get('bottom')).toBe('calc(100% + var(--space-2))');
    expect(rule('.ui-popover--top-end').get('bottom')).toBe('calc(100% + var(--space-2))');
    expect(rule('.ui-popover--bottom-start').get('left')).toBe('0');
    expect(rule('.ui-popover--top-start').get('left')).toBe('0');
    expect(rule('.ui-popover--bottom-end').get('right')).toBe('0');
    expect(rule('.ui-popover--top-end').get('right')).toBe('0');
  });

  it('rings the card for keyboard users only', () => {
    expect(rule('.ui-popover:focus').get('outline')).toBe('none');
    expect(rule('.ui-popover:focus-visible').get('outline')).toBe('3px solid var(--focus-ring)');
  });

  it('moves with an 8px rise and a fade, and not at all for people who ask for less motion', () => {
    const base = css.replace(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g, '');
    expect(declarationsFor(base, '.ui-modal[open]').get('animation')).toBe('ui-float-in var(--motion-base) var(--motion-easing-standard)');
    expect(declarationsFor(base, '.ui-popover').get('animation')).toBe('ui-float-in var(--motion-fast) var(--motion-easing-standard)');
    expect(rule('from').get('opacity')).toBe('0');
    expect(rule('from').get('transform')).toBe('translateY(var(--space-2))');
    const blocks = reducedMotionBlocks();
    expect(declarationsFor(blocks, '.ui-modal[open]').get('animation')).toBe('none');
    expect(declarationsFor(blocks, '.ui-popover').get('animation')).toBe('none');
  });

  it.each(['light', 'dark'] as const)('keeps the text AA on the surface it sits on in %s', (theme) => {
    expect(contrastOf(theme, 'var(--text-primary)', rule('.ui-popover').get('background')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf(theme, rule('.ui-modal__description').get('color')!, rule('.ui-modal').get('background')!)).toBeGreaterThanOrEqual(4.5);
  });
});
