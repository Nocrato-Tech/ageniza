// @vitest-environment jsdom
// @vitest-environment-options {"pretendToBeVisual":true}
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';

const layout = vi.hoisted(() => new Map<string, (event: unknown) => void>());
vi.mock('react-native', async () => {
  const { createElement, forwardRef } = await import('react');
  const native = Object.fromEntries(await Promise.all(['View', 'Pressable', 'Platform'].map(async (name) => [name, (await vi.importActual<{ default: React.ElementType }>(`react-native-web/dist/exports/${name}/index.js`)).default])));
  return { ...native, View: forwardRef((props: { children?: React.ReactElement<{ accessibilityLabel?: string }>; onLayout?: (event: unknown) => void }, ref) => {
    const { onLayout, ...rest } = props;
    const name = props.children?.props?.accessibilityLabel;
    if (onLayout && name) layout.set(name, onLayout);
    return createElement(native.View!, { ...rest, ref });
  }) };
});
vi.mock('../ui', () => ({
  Card: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Txt: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  IconButton: ({ label, onPress }: { label: string; onPress(): void }) => <button onClick={onPress}>{label}</button>,
  ui: {},
  useColors: () => ({ indigo: 'blue', surface: 'white', muted: 'gray', text: 'black' }),
}));
vi.mock('../icons', () => ({ ChevronLeft: () => null, ChevronRight: () => null }));
vi.mock('../motion', () => ({ useReducedMotion: () => false }));
vi.mock('./MonthMotion', async () => import('./MonthMotion.web'));
vi.mock('./LiquidIndicator', () => ({ LiquidIndicator: ({ target }: { target: unknown }) => <div data-selection-target={JSON.stringify(target)} /> }));
import { Calendar } from '../Calendar';

afterEach(() => { cleanup(); layout.clear(); });

it('keeps measured liquid selection after reversing before the old month unmounts without a new layout event', () => {
  const calendar = (month: string) => <Calendar from={`2026-${month}-01`} to={`2026-${month}-${month === '11' ? '30' : '31'}`} label={month} posts={[]} onMonth={() => {}}>{() => null}</Calendar>;
  const { container, rerender } = render(calendar('11'));
  const november = { x: 300, y: 0, width: 50, height: 56 };
  const december = { x: 50, y: 0, width: 50, height: 56 };
  const notify = (month: string, rect: typeof november) => layout.get([...layout.keys()].find((name) => name.includes(`1 de ${month} de 2026`))!)!({ nativeEvent: { layout: rect } });
  act(() => notify('novembro', november));
  rerender(calendar('12'));
  act(() => notify('dezembro', december));
  rerender(calendar('11'));
  const selection = () => container.querySelector('[data-month-viewport="grid"] [data-month-present="true"] [data-selection-target]')?.getAttribute('data-selection-target');
  expect(selection()).toBe(JSON.stringify(november));
  act(() => notify('dezembro', { ...december, x: 100 }));
  expect(selection()).toBe(JSON.stringify(november));
});
