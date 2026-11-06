// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { Header, Selector, Tabs, MediaDisplay } from './ui';
import type { Asset, Post } from './types';

afterEach(cleanup);
beforeEach(() => { Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }); });

it('distinguishes the active portal from the personal account and exposes separate actions', () => {
  const context = vi.fn(); const profile = vi.fn();
  render(<Header contextLabel="Clínica Vida" contextType="client" onContext={context} onProfile={profile} />);
  fireEvent.click(screen.getByRole('button', { name: 'Trocar agência ou portal. Portal: Clínica Vida' }));
  expect(context).toHaveBeenCalledOnce();
  expect(profile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Minha conta' }));
  expect(profile).toHaveBeenCalledOnce();
});
it('searches large selectors and shows an honest empty result without changing the selection', async () => {
  const select = vi.fn();
  render(<Selector label="Cliente" value="1" onChange={select} options={Array.from({ length: 9 }, (_, i) => ({ id: String(i), label: i === 8 ? 'Clínica Vida e Saúde' : `Cliente ${i}` }))} />);
  fireEvent.click(screen.getByRole('button', { name: 'Cliente' }));
  const search = await screen.findByLabelText('Buscar Cliente');
  fireEvent.change(search, { target: { value: 'inexistente' } });
  expect(screen.getByText('Nenhum resultado. Tente outro termo.')).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
  fireEvent.change(search, { target: { value: 'clinica' } });
  fireEvent.click(screen.getByRole('button', { name: 'Selecionar Clínica Vida e Saúde' }));
  expect(select).toHaveBeenCalledWith('8');
});

it('keeps many tabs in a horizontally scrollable strip and selects the requested tab', () => {
  const change = vi.fn();
  render(<Tabs value="0" onChange={change} options={Array.from({ length: 5 }, (_, i) => ({ id: String(i), label: `Etapa ${i}` }))} />);
  expect(screen.getByLabelText('Abas. Deslize para ver mais opções.')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'Etapa 4' }));
  expect(change).toHaveBeenCalledWith('4');
  expect(screen.getByRole('tab', { name: 'Etapa 0' }).getAttribute('aria-selected')).toBe('true');
});

it('reserves the image preview space during loading and failure, and retries the real URL request', async () => {
  let fail: (error: Error) => void = () => {};
  const assetUrl = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValue('https://example.test/image.png');
  const asset: Asset = { id: 'image-one', clientId: 'client-one', folderId: 'folder-one', name: 'Capa da campanha', kind: 'image', size: 100 };
  const post = { id: 'content-one', clientId: 'client-one', title: 'Campanha de saúde' } as Post;
  render(<MediaDisplay asset={asset} post={post} repository={{ assetUrl }} />);
  const frame = screen.getByLabelText('Prévia de Capa da campanha');
  expect(frame.style.height).toBe('410px');
  expect(screen.getByLabelText('Carregando mídia')).toBeTruthy();
  await act(async () => fail(new Error('offline')));
  expect(screen.getByText('Não foi possível carregar a mídia.')).toBeTruthy();
  expect(frame.style.height).toBe('410px');
  fireEvent.click(screen.getByRole('button', { name: 'Recarregar mídia' }));
  await waitFor(() => expect(assetUrl).toHaveBeenCalledTimes(2));
  expect(assetUrl).toHaveBeenLastCalledWith('client-one', 'content-one', 'image-one', 'original');
});

it('explains when a selector has no available options without inventing a selection', async () => {
  const change = vi.fn();
  render(<Selector label="Pasta" value="" options={[]} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Pasta' }));
  expect(await screen.findByText('Nenhuma opção disponível.')).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
});
