// @vitest-environment jsdom
// The demo gate (issue #834): with EXPO_PUBLIC_DEMO_WORKSPACE off, no demo entry is offered by the app shell or by the content screen.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});const gate = vi.hoisted(() => ({ enabled: false }));
const agencyName = 'Agência Horizonte · Demonstração';
vi.mock('../demo/config', () => ({ get demoWorkspaceEnabled() { return gate.enabled; }, demoAgencyName: 'Agência Horizonte · Demonstração' }));
vi.mock('../demo/DemoWorkspace', () => ({ DemoWorkspace: () => <p>Demo workspace screen</p> }));
vi.mock('../demo/WebNotifications', () => ({ WebNotifications: () => <p>Demo notifications</p> }));
vi.mock('../demo/ContentLearning', () => ({ ContentLearning: () => <p>Demo content learning</p> }));
const repository = vi.hoisted(() => ({ demo: false, load: vi.fn(), detail: vi.fn(), library: vi.fn(), thumbnail: vi.fn() }));
vi.mock('./remote', () => ({ remoteRepository: () => repository }));
import { MobileApp } from './MobileApp';
import { PostDetail } from './PostDetail';
import type { Data, Post, Repository } from './types';

const post: Post = { id: 'p1', clientId: 'c1', title: 'Conteúdo de teste', caption: 'Legenda', format: 'image', status: 'in_production', date: '2026-11-10', time: '10:00', ownerId: 'm1', folderId: '', mediaIds: [], coverId: null, revision: 1, tasks: [], comments: [] };
const data: Data = { version: 2, clients: [{ id: 'c1', name: 'Marca', handle: '' }], people: [{ id: 'm1', name: 'Pessoa', job: '', role: 'Dono', email: 'p@example.test', self: true, owner: true }], posts: [post], activities: [], profile: { name: 'Pessoa', agency: 'Agência' }, permissions: ['*'], readOnly: false, assets: [], folders: [] };
const context = (name: string) => ({ type: 'agency' as const, agencyId: 'one', agencyName: name, isOwner: true, roleKey: 'owner', roleName: 'Owner' });
beforeEach(() => {
  gate.enabled = false; request.mockReset().mockResolvedValue({}); repository.load.mockReset().mockResolvedValue(data);
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(cleanup);
async function openMore(name = agencyName) {
  const view = render(<MobileApp context={context(name)} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Mais' }));
  await screen.findByRole('button', { name: 'Plano e assinatura' });
  return view;
}

it('offers the demo setup from More only when the gate is on, and only for the demo agency', async () => {
  const { unmount } = await openMore();
  expect(screen.queryByRole('button', { name: 'Preparar dados de demonstração' })).toBeNull();
  unmount(); gate.enabled = true;
  await openMore();
  expect(screen.getByRole('button', { name: 'Preparar dados de demonstração' })).toBeTruthy();
});
it('does not open the demo setup screen once the gate is off, even if the screen was already chosen', async () => {
  gate.enabled = true;
  const view = await openMore();
  fireEvent.click(screen.getByRole('button', { name: 'Preparar dados de demonstração' }));
  expect(await screen.findByText('Demo workspace screen')).toBeTruthy();
  gate.enabled = false;
  view.rerender(<MobileApp context={context(agencyName)} onExit={() => {}} />); // a render of the shell after the gate went off
  await waitFor(() => expect(screen.queryByText('Demo workspace screen')).toBeNull());
});
it('shows the demo notifications panel only when the gate is on', async () => {
  const { unmount } = render(<MobileApp context={context('Outra agência')} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Notificações' }));
  await screen.findByText('Tudo em movimento.');
  expect(screen.queryByText('Demo notifications')).toBeNull();
  unmount(); gate.enabled = true;
  render(<MobileApp context={context('Outra agência')} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Notificações' }));
  expect(await screen.findByText('Demo notifications')).toBeTruthy();
});
it('shows the content learning panel on a content only when the gate is on', () => {
  const props = { post, data, side: 'agency' as const, repository: repository as unknown as Repository, busy: false, onMove: async () => {}, onUpdate: async () => true, onEdit: () => {}, onError: () => {} };
  const { unmount } = render(<PostDetail {...props} />);
  expect(screen.getByText('Conteúdo de teste')).toBeTruthy();
  expect(screen.queryByText('Demo content learning')).toBeNull();
  unmount(); gate.enabled = true;
  render(<PostDetail {...props} />);
  expect(screen.getByText('Demo content learning')).toBeTruthy();
});