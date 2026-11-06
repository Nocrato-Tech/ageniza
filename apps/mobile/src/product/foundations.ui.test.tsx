// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
const request = vi.hoisted(() => vi.fn());
vi.mock('../api/runtime', () => ({ api: { request }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator', 'Linking', 'RefreshControl', 'BackHandler', 'Share'].map(async (name) => [name, name === 'BackHandler' ? { addEventListener: () => ({ remove() {} }) } : name === 'Share' ? { share: async () => ({}) } : (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo-status-bar', () => ({ StatusBar: () => null }));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
import { Field, Action } from './ui';
afterEach(cleanup);
it('associates field guidance and errors with a readable input', () => {
  render(<Field label="Nome" value="" hint="Nome exibido no portal" error="Informe seu nome." />);
  const input = screen.getByRole('textbox', { name: 'Nome' });
  expect(input.getAttribute('aria-invalid')).toBe('true');
  const ids = input.getAttribute('aria-describedby')?.split(' ') ?? [];
  expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual(['Nome exibido no portal', 'Informe seu nome.']);
});
it('keeps the action name visible while busy and refuses repeated presses', () => {
  const onPress = vi.fn();
  render(<Action label="Enviar para aprovação" busy onPress={onPress} />);
  expect(screen.getByText('Enviar para aprovação')).toBeTruthy();
  const action = screen.getByRole('button', { name: 'Enviar para aprovação' });
  expect(action.getAttribute('aria-busy')).toBe('true');
  fireEvent.click(action);
  expect(onPress).not.toHaveBeenCalled();
});
