// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Pressable', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('react-native-svg', () => ({ default: ({ children, ...props }: Record<string, unknown>) => createElement('svg', props, children as never), Path: 'path', Circle: 'circle', Line: 'line', Polyline: 'polyline' }));
import { HugeIcon } from './HugeIcon';
import { geometry } from './icons/geometry';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('plays one interaction, cancels on replacement, and respects reduced motion', () => {
  let reduce = false;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ get matches() { return reduce; }, addEventListener() {}, removeEventListener() {} }) });
  const cancel = vi.fn(); const animate = vi.fn(() => ({ cancel }));
  Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, value: animate });
  const { rerender } = render(<HugeIcon name="notification-03" trigger={0} />);
  expect(animate).not.toHaveBeenCalled();
  rerender(<HugeIcon name="notification-03" trigger={1} />);
  expect(animate).toHaveBeenCalledOnce();
  rerender(<HugeIcon name="notification-03" trigger={2} />);
  expect(cancel).toHaveBeenCalledOnce();
  expect(animate).toHaveBeenCalledTimes(2);
  reduce = true;
  cleanup();
  render(<HugeIcon name="tick-02" trigger />);
  expect(animate).toHaveBeenCalledTimes(2);
});
it('ships nonempty SVG geometry for every supported icon without external resources', () => {
  for (const shapes of Object.values(geometry)) {
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) if (shape.tag === 'path') expect('d' in shape.attrs && shape.attrs.d).toMatch(/^M/);
  }
});
