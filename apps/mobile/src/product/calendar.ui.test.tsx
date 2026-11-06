// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'ActivityIndicator'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('react-native-svg', async () => { const { createElement } = await import('react'); const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children); return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) }; });
import { Calendar } from './Calendar';
import type { Post } from './types';
afterEach(cleanup);
const posts = [{ id: 'one', date: '2026-11-06', status: 'awaiting_approval' }, { id: 'two', date: '2026-11-06', status: 'published' }] as Post[];
it('announces content quantity and states and keeps the externally selected day after remount', () => {
  const onSelectDay = vi.fn();
  const view = render(<Calendar from="2026-11-01" to="2026-11-30" label="novembro de 2026" posts={posts} onMonth={() => {}} selectedDay="2026-11-10" onSelectDay={onSelectDay}>{(day) => <span>{`Seleção: ${day}`}</span>}</Calendar>);
  const button = screen.getByRole('button', { name: /6 de novembro de 2026.*2 conteúdos.*Aguardando aprovação.*Publicado/ });
  fireEvent.click(button);
  expect(onSelectDay).toHaveBeenCalledWith('2026-11-06');
  expect(screen.getByText('Seleção: 2026-11-10')).toBeTruthy();
  view.unmount();
  render(<Calendar from="2026-11-01" to="2026-11-30" label="novembro de 2026" posts={posts} onMonth={() => {}} selectedDay="2026-11-06">{(day) => <span>{`Seleção: ${day}`}</span>}</Calendar>);
  expect(screen.getByText('Seleção: 2026-11-06')).toBeTruthy();
  expect(screen.getByRole('button', { name: /6 de novembro de 2026.*2 conteúdos/ }).getAttribute('aria-pressed')).toBe('true');
});
