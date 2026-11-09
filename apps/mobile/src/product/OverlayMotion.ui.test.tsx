// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('react-native', async () => {
  const native = Object.fromEntries(await Promise.all(['View', 'Pressable', 'Modal', 'StyleSheet', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default])));
  const { createElement, useEffect } = await import('react');
  const animated = native.Animated as { View: unknown };
  const original = animated.View;
  animated.View = function MeasuredSurface({ onLayout, ...props }: { onLayout?: (event: { nativeEvent: { layout: { height: number } } }) => void; children?: ReactNode }) {
    useEffect(() => { onLayout?.({ nativeEvent: { layout: { height: 320 } } }); }, [onLayout]);
    return createElement(original as 'div', props);
  };
  return native;
});

import { Animated } from 'react-native';
import { OverlayMotion } from './OverlayMotion';

type Completion = (result: { finished: boolean }) => void;
const animations: { complete?: Completion; stop: ReturnType<typeof vi.fn> }[] = [];

beforeEach(() => {
  animations.length = 0;
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  vi.spyOn(Animated, 'timing').mockImplementation(() => {
    const animation = { complete: undefined as Completion | undefined, stop: vi.fn(), start: (callback?: Completion) => { animation.complete = callback; }, reset: vi.fn() };
    animations.push(animation);
    return animation;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('keeps the modal focus boundary mounted until the reverse exit completes', () => {
  const { rerender } = render(<OverlayMotion open onClose={() => {}}><button>Option</button></OverlayMotion>);
  const option = screen.getByRole('button', { name: 'Option' });
  act(() => { animations.at(-1)?.complete?.({ finished: true }); });
  rerender(<OverlayMotion open={false} onClose={() => {}}><button>Option</button></OverlayMotion>);
  expect(option.isConnected).toBe(true);
  expect(screen.queryByRole('button', { name: 'Option' })).toBeNull();
  act(() => { animations.at(-1)?.complete?.({ finished: true }); });
  expect(screen.queryByRole('button', { name: 'Option' })).toBeNull();
});

it('ignores an interrupted exit completion after the selector reopens', () => {
  const { rerender } = render(<OverlayMotion open onClose={() => {}}><button>Option</button></OverlayMotion>);
  rerender(<OverlayMotion open={false} onClose={() => {}}><button>Option</button></OverlayMotion>);
  const exit = animations.at(-1);
  rerender(<OverlayMotion open onClose={() => {}}><button>Option</button></OverlayMotion>);
  expect(exit?.stop).toHaveBeenCalled();
  act(() => { exit?.complete?.({ finished: true }); });
  expect(screen.getByRole('button', { name: 'Option' })).toBeTruthy();
});

it('dismisses immediately when reduced motion is enabled', () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  const { rerender } = render(<OverlayMotion open onClose={() => {}}><button>Option</button></OverlayMotion>);
  rerender(<OverlayMotion open={false} onClose={() => {}}><button>Option</button></OverlayMotion>);
  expect(screen.queryByRole('button', { name: 'Option' })).toBeNull();
  expect(animations).toHaveLength(0);
});
