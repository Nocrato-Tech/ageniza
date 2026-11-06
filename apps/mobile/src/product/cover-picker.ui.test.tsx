// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const request = vi.hoisted(() => vi.fn());
const pick = vi.hoisted(() => vi.fn());
const videoSource = vi.hoisted(() => vi.fn());
vi.mock('expo-document-picker', () => ({ getDocumentAsync: pick }));
vi.mock('../api/runtime', () => ({ api: { request }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator', 'Linking'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: (uri: string) => { videoSource(uri); return { addListener: () => ({ remove() {} }) }; } }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
import { ContentEditor } from './ContentEditor';
import type { Data, Repository } from './types';
afterEach(cleanup);
it('uploads a cover independently from an already selected video and excludes video thumbnails from cover choices', async () => {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
  const video = { id: 'video', clientId: 'c', folderId: 'f', kind: 'video' as const, name: 'Video.mp4', sample: true, size: 10 };
  const cover = { ...video, id: 'cover', kind: 'image' as const, name: 'Capa.png', uri: 'blob:cover' };
  const data: Data = { version: 2, clients: [{ id: 'c', name: 'Marca', handle: '' }], people: [], posts: [], activities: [], profile: { name: 'P', agency: 'A' }, permissions: [], readOnly: false, assets: [video], folders: [{ id: 'f', clientId: 'c', name: 'Pasta' }] };
  const draft = { input: { clientId: 'c', folderId: 'f', title: 'Reel com capa', caption: '', format: 'reels' as const, date: '2026-11-06', time: '', ownerId: '', mediaIds: ['video'], coverId: null } };
  const onDraftChange = vi.fn();
  const repository = { library: vi.fn().mockResolvedValueOnce({ folders: data.folders, assets: [video] }).mockResolvedValue({ folders: data.folders, assets: [video, cover] }), upload: vi.fn().mockResolvedValue(cover), assetUrl: vi.fn().mockResolvedValue('blob:thumbnail') } as unknown as Repository;
  pick.mockResolvedValue({ canceled: false, assets: [{ uri: 'blob:cover', name: 'Capa.png', mimeType: 'image/png', size: 10 }] });
  render(<ContentEditor data={data} repository={repository} clientId="c" initialDraft={draft} onDraftChange={onDraftChange} busy={false} onSave={async () => {}} onError={() => {}} onRefresh={async () => {}} />);
  await waitFor(() => expect(screen.queryByText('Carregando biblioteca…')).toBeNull());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continuar para conteúdo' }).getAttribute('aria-busy')).toBe('false'));
  fireEvent.click(screen.getByRole('button', { name: 'Continuar para conteúdo' }));
  expect(screen.queryByRole('radio', { name: 'Usar Video.mp4 como capa' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Enviar imagem de capa' }));
  await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(expect.objectContaining({ input: expect.objectContaining({ mediaIds: ['video'], coverId: 'cover' }) })));
  expect(await screen.findByRole('radio', { name: 'Usar Capa.png como capa' })).toBeTruthy();
});
