// @vitest-environment jsdom
// @vitest-environment-options {"pretendToBeVisual":true}
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock('../motion', () => ({ useReducedMotion: () => preference.reduced }));
import { LiquidIndicator } from './LiquidIndicator.web';

afterEach(() => { cleanup(); preference.reduced = false; });

const target = { x: 0, y: 0, width: 50, height: 56 };
function geometry(container: HTMLElement) {
  const element = container.querySelector<HTMLElement>('[data-liquid-surface]')!;
  const match = /translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\) scale\(([-\d.]+), ([-\d.]+)\)/.exec(element.style.transform);
  return { x: Number(match?.[1]), y: Number(match?.[2]), scaleX: Number(match?.[3]), scaleY: Number(match?.[4]) };
}

it('moves and deforms one surface, retargets in flight, and settles on the latest day', async () => {
  const { container, rerender } = render(<LiquidIndicator target={target} color="indigo" />);
  await waitFor(() => expect(geometry(container).x).toBeCloseTo(0));
  const surface = container.querySelector('[data-liquid-surface]');
  rerender(<LiquidIndicator target={{ ...target, x: 150 }} color="indigo" />);
  await waitFor(() => {
    const frame = geometry(container);
    expect(frame.x).toBeGreaterThan(2);
    expect(frame.x).toBeLessThan(145);
    expect(frame.scaleX).toBeGreaterThan(1.01);
  });
  const inFlight = geometry(container).x;
  rerender(<LiquidIndicator target={{ ...target, x: 50, y: 60 }} color="indigo" />);
  expect(container.querySelector('[data-liquid-surface]')).toBe(surface);
  expect(geometry(container).x).toBeCloseTo(inFlight);
  await waitFor(() => {
    expect(geometry(container).x).toBeCloseTo(50, 1);
    expect(geometry(container).y).toBeCloseTo(60, 1);
    expect(geometry(container).scaleX).toBeCloseTo(1, 2);
    expect(geometry(container).scaleY).toBeCloseTo(1, 2);
  });
});

it('snaps a resized or replaced calendar into its measured geometry', async () => {
  const { container, rerender } = render(<LiquidIndicator target={target} color="indigo" revision="november" />);
  await waitFor(() => expect(geometry(container).x).toBeCloseTo(0));
  rerender(<LiquidIndicator target={{ x: 100, y: 60, width: 70, height: 56 }} color="indigo" revision="december" />);
  await waitFor(() => expect(geometry(container)).toEqual({ x: 100, y: 60, scaleX: 1, scaleY: 1 }));
});

it('cancels movement when reduced motion is enabled and hides the decorative copy from accessibility', async () => {
  const { container, rerender } = render(<LiquidIndicator target={target} color="indigo"><span>Decorative label copy</span></LiquidIndicator>);
  rerender(<LiquidIndicator target={{ ...target, x: 150 }} color="indigo" />);
  preference.reduced = true;
  rerender(<LiquidIndicator target={{ ...target, x: 150 }} color="indigo"><span>Decorative label copy</span></LiquidIndicator>);
  await waitFor(() => expect(geometry(container)).toEqual({ x: 150, y: 0, scaleX: 1, scaleY: 1 }));
  expect(container.querySelector('[data-liquid-indicator]')?.getAttribute('aria-hidden')).toBe('true');
});
