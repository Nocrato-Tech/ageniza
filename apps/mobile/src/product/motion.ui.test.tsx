// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Pressable', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
import { ScreenMotion } from './motion';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('animates web navigation once and interrupts the previous arrival without remounting focused content', () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  const { rerender, getByLabelText } = render(<ScreenMotion identity="first"><input aria-label="Draft" defaultValue="Keep this draft" /></ScreenMotion>);
  const input = getByLabelText('Draft');
  input.focus();
  expect(animate).toHaveBeenCalledOnce();
  rerender(<ScreenMotion identity="second"><input aria-label="Draft" defaultValue="Keep this draft" /></ScreenMotion>);
  expect(cancel).toHaveBeenCalledOnce();
  expect(animate).toHaveBeenCalledTimes(2);
  expect(getByLabelText('Draft')).toBe(input);
  expect(document.activeElement).toBe(input);
});

it('applies reduced motion immediately and cancels an active arrival when the preference changes', () => {
  let reduce = true;
  let notify: (() => void) | undefined;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ get matches() { return reduce; }, addEventListener(_event: string, callback: () => void) { notify = callback; }, removeEventListener() {} }) });
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate });
  const { rerender } = render(<ScreenMotion identity="first"><span>Visible immediately</span></ScreenMotion>);
  expect(animate).not.toHaveBeenCalled();
  act(() => { reduce = false; notify?.(); });
  expect(animate).not.toHaveBeenCalled();
  rerender(<ScreenMotion identity="second"><span>Next view</span></ScreenMotion>);
  expect(animate).toHaveBeenCalledOnce();
  act(() => { reduce = true; notify?.(); });
  expect(cancel).toHaveBeenCalledOnce();
  rerender(<ScreenMotion identity="third"><span>Next view</span></ScreenMotion>);
  expect(animate).toHaveBeenCalledOnce();
});
