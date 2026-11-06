// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const request = vi.hoisted(() => vi.fn());
const mode = vi.hoisted(() => ({ demo: false }));
vi.mock('../demo/config', () => ({ get demoWorkspaceEnabled() { return mode.demo; } }));
const approvalRequest = vi.hoisted(() => vi.fn());
vi.mock('../api/approval', () => ({ createApprovalClient: () => ({ request: approvalRequest, clear: async () => {} }) }));
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('../api/runtime', () => ({ api: { request }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator', 'Linking'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
import { PasswordField } from './PasswordField';
afterEach(cleanup);
it('prevents revealing a disabled password and preserves input selection after keyboard focus moves to the toggle', () => {
  const { rerender } = render(<PasswordField label="Senha" value="secret password" editable={false} autoComplete="current-password" />);
  const input = screen.getByLabelText('Senha') as HTMLInputElement;
  const disabled = screen.getByRole('button', { name: 'Mostrar Senha' });
  fireEvent.click(disabled);
  expect(input.type).toBe('password');
  expect(disabled.getAttribute('aria-disabled')).toBe('true');
  rerender(<PasswordField label="Senha" value="secret password" autoComplete="current-password" />);
  input.focus(); input.setSelectionRange(2, 7);
  screen.getByRole('button', { name: 'Mostrar Senha' }).focus();
  fireEvent.click(screen.getByRole('button', { name: 'Mostrar Senha' }));
  expect(document.activeElement).toBe(input);
  expect(input.type).toBe('text');
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(7);
});
