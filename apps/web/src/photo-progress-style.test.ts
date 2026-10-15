import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { declarationsFor, readStyles } from './styles/theme-colors';

const css = readStyles('globals.css');
const source = (name: string): string => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce) {\n  .edit-client__photo-progress:indeterminate';

const PHOTO_BARS = [
  ['.edit-client__photo-progress', 'edit-client.tsx'],
  ['.collaborator-detail__photo-progress', 'collaborator-detail.tsx']
] as const;

describe('photo upload progress bar (#639)', () => {
  it.each(PHOTO_BARS)('%s is the neutral bar of the Pauta, never the indigo of the action', (selector, file) => {
    expect(source(file)).toContain(`<progress className="${selector.slice(1)}"`);
    expect(declarationsFor(css, selector).has('accent-color'), 'accent-color').toBe(false);
    expect(declarationsFor(css, selector).get('appearance')).toBe('none');
    expect(declarationsFor(css, selector).get('background')).toBe('var(--bg-hover)');
    expect(declarationsFor(css, selector).get('height')).toBe(declarationsFor(css, '.media-uploader__progress').get('height'));
    expect(declarationsFor(css, `${selector}::-webkit-progress-bar`).get('background')).toBe('var(--bg-hover)');
    expect(declarationsFor(css, `${selector}::-webkit-progress-value`).get('background')).toBe('var(--text-primary)');
    expect(declarationsFor(css, `${selector}::-moz-progress-bar`).get('background')).toBe('var(--text-primary)');
  });

  it.each(PHOTO_BARS)('%s keeps moving while the server has no value to show, and stands still for reduced motion', (selector) => {
    const rules = css.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
    const reducedAt = rules.indexOf(REDUCED_MOTION);
    expect(reducedAt).toBeGreaterThan(-1);
    const reduced = rules.slice(reducedAt);
    const inner = reduced.slice(reduced.indexOf('{') + 1, reduced.indexOf('\n}\n'));
    expect(rules).toContain('@keyframes ui-progress-slide');

    // Chrome paints the track in ::-webkit-progress-bar over the element, so the segment lives on both.
    for (const target of [`${selector}:indeterminate`, `${selector}:indeterminate::-webkit-progress-bar`]) {
      const waiting = declarationsFor(rules.slice(0, reducedAt), target);
      expect(waiting.get('background'), target).toContain('var(--text-primary)');
      expect(waiting.get('animation'), target).toContain('ui-progress-slide');
      expect(declarationsFor(inner, target).get('animation'), target).toBe('none');
    }
  });
});
