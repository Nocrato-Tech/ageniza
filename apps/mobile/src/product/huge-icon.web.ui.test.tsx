// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const calls = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Pressable', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('motion/react', () => ({ MotionConfig: ({ children }: { children: unknown }) => children }));
vi.mock('./icons/registry.web', async () => {
  const React = await import('react');
  const Icon = React.forwardRef((_props, ref) => { React.useImperativeHandle(ref, () => ({ startAnimation: calls.start, stopAnimation: calls.stop })); return React.createElement('svg'); });
  return { animatedIcons: { 'notification-03': Icon, 'plus-sign': Icon } };
});
import { HugeIcon } from './HugeIcon.web';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
function preference(initial = false) {
  let reduced = initial; let listener: (() => void) | undefined;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ get matches() { return reduced; }, addEventListener(_name: string, callback: () => void) { listener = callback; }, removeEventListener() {} }) });
  return (value: boolean) => act(() => { reduced = value; listener?.(); });
}
it('animates from the whole parent target on hover, touch, click and focus without replacing its action', () => {
  preference(); const action = vi.fn();
  const view = render(<button onClick={action}>Large target <HugeIcon name="plus-sign" /></button>);
  const button = view.getByRole('button');
  expect(calls.start).not.toHaveBeenCalled();
  fireEvent.pointerEnter(button); expect(calls.start).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(button, { pointerType: 'touch' }); expect(calls.start).toHaveBeenCalledTimes(2);
  fireEvent.click(button); expect(calls.start).toHaveBeenCalledTimes(3); expect(action).toHaveBeenCalledOnce();
  fireEvent.focusIn(button); expect(calls.start).toHaveBeenCalledTimes(4);
  fireEvent.pointerLeave(button); expect(calls.stop).not.toHaveBeenCalled();
  view.unmount(); calls.start.mockClear(); fireEvent.pointerDown(button); expect(calls.start).not.toHaveBeenCalled();
});
it('prevents disabled interaction and cancels current animation when reduced motion is enabled', () => {
  const reduce = preference();
  const view = render(<button disabled><HugeIcon name="notification-03" /></button>);
  fireEvent.pointerDown(view.getByRole('button')); expect(calls.start).not.toHaveBeenCalled();
  view.rerender(<button><HugeIcon name="notification-03" /></button>);
  fireEvent.pointerDown(view.getByRole('button')); expect(calls.start).toHaveBeenCalledOnce();
  reduce(true); expect(calls.stop).toHaveBeenCalled(); calls.start.mockClear();
  fireEvent.pointerEnter(view.getByRole('button')); fireEvent.pointerDown(view.getByRole('button')); expect(calls.start).not.toHaveBeenCalled();
});
it('has no production Lucide imports or fallback in any mobile TSX surface', () => {
  const files = readdirSync('src', { recursive: true, withFileTypes: true });
  const surfaces = files.filter(file => file.isFile() && file.name.endsWith('.tsx') && !file.name.includes('.test.'));
  expect(surfaces.length).toBeGreaterThan(20);
  for (const file of surfaces) expect(readFileSync(join(file.parentPath, file.name), 'utf8'), file.name).not.toContain('lucide-react-native');
});

it('plays the next state even when the icon component changes', () => {
  preference();
  const view = render(<button><HugeIcon name="plus-sign" trigger={0} /></button>);
  expect(calls.start).not.toHaveBeenCalled();
  view.rerender(<button><HugeIcon name="notification-03" trigger={1} /></button>);
  expect(calls.start).toHaveBeenCalledTimes(1);
  view.rerender(<button><HugeIcon name="plus-sign" trigger={2} /></button>);
  expect(calls.start).toHaveBeenCalledTimes(2);
});
