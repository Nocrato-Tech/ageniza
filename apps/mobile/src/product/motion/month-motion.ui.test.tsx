// @vitest-environment jsdom
// @vitest-environment-options {"pretendToBeVisual":true}
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const preference = vi.hoisted(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'] }); return { reduced: false }; });
vi.mock('../motion', () => ({ useReducedMotion: () => preference.reduced }));
import { MonthMotion } from './MonthMotion.web';

afterEach(async () => { cleanup(); preference.reduced = false; await vi.advanceTimersByTimeAsync(64); });
afterAll(() => vi.useRealTimers());
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const panel = (container: HTMLElement, month: string) => container.querySelector<HTMLElement>(`[data-month-panel="${month}"]`)!;
const x = (element: HTMLElement) => Number(/translate3d\(([-\d.]+)/.exec(element.style.transform)?.[1]);

it('slides the grid forward with an inert outgoing month and leaves header focus and callbacks available', async () => {
  const next = vi.fn();
  const select = vi.fn();
  const calendar = (month: string) => <><button onClick={next}>Next month</button><MonthMotion identity={month}><button onClick={select}>{month}</button></MonthMotion></>;
  const { container, rerender } = render(calendar('2026-11'));
  const arrow = screen.getByRole('button', { name: 'Next month' });
  arrow.focus();
  fireEvent.click(arrow);
  expect(next).toHaveBeenCalledOnce();
  rerender(calendar('2026-12'));
  expect(document.activeElement).toBe(arrow);
  expect(screen.queryByRole('button', { name: '2026-11' })).toBeNull();
  expect(panel(container, '2026-11').hasAttribute('inert')).toBe(true);
  fireEvent.click(panel(container, '2026-11').querySelector('button')!);
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '2026-12' }));
  expect(select).toHaveBeenCalledOnce();
  await advance(80);
  expect(x(panel(container, '2026-12'))).toBeGreaterThan(0);
  expect(x(panel(container, '2026-12'))).toBeLessThan(100);
  expect(x(panel(container, '2026-11'))).toBeLessThan(0);
  await advance(400);
  expect(panel(container, '2026-11')).toBeNull();
  expect(x(panel(container, '2026-12'))).toBe(0);
});

it('reverses an unfinished month change from its current position and restores only the latest month', async () => {
  const calendar = (month: string) => <MonthMotion identity={month}><button>{month}</button></MonthMotion>;
  const { container, rerender } = render(calendar('2026-11'));
  const november = panel(container, '2026-11');
  rerender(calendar('2026-12'));
  await advance(64);
  expect(x(november)).toBeLessThan(-1);
  expect(x(november)).toBeGreaterThan(-99);
  const current = x(november);
  rerender(calendar('2026-11'));
  expect(panel(container, '2026-11')).toBe(november);
  expect(x(november)).toBeCloseTo(current);
  expect(november.hasAttribute('inert')).toBe(false);
  expect(screen.queryByRole('button', { name: '2026-12' })).toBeNull();
  await advance(400);
  expect(panel(container, '2026-12')).toBeNull();
  expect(x(november)).toBe(0);
});

it('brings earlier months in from the left and cancels ongoing movement for reduced motion', async () => {
  const calendar = (month: string) => <MonthMotion identity={month}><span>{month}</span></MonthMotion>;
  const { container, rerender } = render(calendar('2026-12'));
  rerender(calendar('2026-11'));
  expect(x(panel(container, '2026-11'))).toBeLessThan(0);
  preference.reduced = true;
  rerender(calendar('2026-11'));
  await advance(16);
  expect(panel(container, '2026-12')).toBeNull();
  expect(x(panel(container, '2026-11'))).toBe(0);
  rerender(calendar('2026-10'));
  await advance(16);
  expect(panel(container, '2026-11')).toBeNull();
  expect(x(panel(container, '2026-10'))).toBe(0);
});
