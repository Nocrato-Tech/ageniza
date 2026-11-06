// @vitest-environment jsdom
// The component's own guard (issue #834): with the gate off, DemoWorkspace renders nothing, so no entry can offer to create the demo agency.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
vi.mock('./config', () => ({ demoWorkspaceEnabled: false }));
import { DemoWorkspace } from './DemoWorkspace';
afterEach(cleanup);

it('renders no demo entry when the gate is off', () => {
  const { container } = render(<DemoWorkspace onEnter={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Criar agência de demonstração' })).toBeNull();
  expect(container.textContent).toBe('');
});
