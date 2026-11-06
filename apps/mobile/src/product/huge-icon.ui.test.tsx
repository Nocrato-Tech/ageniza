// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { createElement } from 'react';
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Pressable', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('react-native-svg', () => ({ default: ({ children, ...props }: Record<string, unknown>) => createElement('svg', props, children as never), Path: 'path', Circle: 'circle', Line: 'line', Polyline: 'polyline' }));
import { geometry } from './icons/geometry';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('ships nonempty SVG geometry for every supported icon without external resources', () => {
  for (const shapes of Object.values(geometry)) {
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) if (shape.tag === 'path') expect('d' in shape.attrs && shape.attrs.d).toMatch(/^M/);
  }
});
