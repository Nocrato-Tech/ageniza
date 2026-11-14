// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const request = vi.hoisted(() => vi.fn());
vi.mock('../demo/config', () => ({ demoWorkspaceEnabled: false }));
vi.mock('../api/approval', () => ({ createApprovalClient: () => ({ request: vi.fn(), clear: async () => {} }) }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: vi.fn() }));
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('../api/runtime', () => ({ api: { request }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator', 'Linking'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
vi.mock('../product/StateSwap', () => import('../product/StateSwap.web'));
vi.mock('../product/Disclosure', () => import('../product/Disclosure.web'));
import { ApiError } from '../api/client';
import { BrandStudy } from './BrandStudy';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  request.mockReset();
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: vi.fn(() => ({ cancel: vi.fn(), playState: 'finished' })) });
});

const ROOT = '/agencies/one/clients/two';
const MARIA = '11111111-1111-4111-8111-111111111111';
const JOAO = '22222222-2222-4222-8222-222222222222';
const persona = (id: string, name: string, messageCount: number) => ({ id, name, description: null, pains: null, desires: null, objections: null, messageCount });
const study = (personas: ReturnType<typeof persona>[]) => ({ filled: 1, sections: [{ key: 'observations', body: 'Algo', archetype: null, colors: null }], personas });

it('deletes only the chosen persona, tells how many messages go with her and refreshes the list', async () => {
  let personas = [persona(MARIA, 'Dona Maria', 3), persona(JOAO, 'Seu João', 1)];
  request.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (options?.method === 'DELETE') { personas = personas.filter((item) => path !== `${ROOT}/personas/${item.id}`); return undefined; }
    return study(personas);
  });
  render(<BrandStudy root={ROOT} canEdit />);
  expect(await screen.findByText('Dona Maria')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Excluir persona Dona Maria' }));
  expect(screen.getByText('Excluir a persona Dona Maria?')).toBeTruthy();
  expect(screen.getByText('A conversa dela, com 3 mensagens, também será apagada. Não dá para desfazer.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Excluir persona Seu João' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão da persona Dona Maria' }));
  await waitFor(() => expect(request).toHaveBeenCalledWith(`${ROOT}/personas/${MARIA}`, { method: 'DELETE' }));
  await waitFor(() => expect(screen.queryByText('Dona Maria')).toBeNull());
  expect(screen.getByText('Seu João')).toBeTruthy();
  expect(screen.getByText('Persona excluída.')).toBeTruthy();
  expect(request.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1);
});

it('keeps the persona when the person gives up', async () => {
  request.mockResolvedValue(study([persona(MARIA, 'Dona Maria', 0)]));
  render(<BrandStudy root={ROOT} canEdit />);
  fireEvent.click(await screen.findByRole('button', { name: 'Excluir persona Dona Maria' }));
  expect(screen.getByText('Ela ainda não tem mensagens. Não dá para desfazer.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Manter persona Dona Maria' }));
  expect(screen.getByRole('button', { name: 'Excluir persona Dona Maria' })).toBeTruthy();
  expect(request.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
});

it('says the persona is gone and drops her from the list when the API answers 404', async () => {
  let personas = [persona(MARIA, 'Dona Maria', 2), persona(JOAO, 'Seu João', 0)];
  request.mockImplementation(async (_path: string, options?: { method?: string }) => {
    if (options?.method === 'DELETE') { personas = [persona(JOAO, 'Seu João', 0)]; throw new ApiError(404, 'NOT_FOUND', 'Não encontrado'); }
    return study(personas);
  });
  render(<BrandStudy root={ROOT} canEdit />);
  fireEvent.click(await screen.findByRole('button', { name: 'Excluir persona Dona Maria' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar exclusão da persona Dona Maria' }));
  expect(await screen.findByText('Esta persona não existe mais.')).toBeTruthy();
  await waitFor(() => expect(screen.queryByText('Dona Maria')).toBeNull());
  expect(screen.getByText('Seu João')).toBeTruthy();
});

it('offers no deletion without edit permission', async () => {
  request.mockResolvedValue(study([persona(MARIA, 'Dona Maria', 0)]));
  render(<BrandStudy root="/clients/two" canEdit={false} agency={false} />);
  expect(await screen.findByText('Dona Maria')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Excluir persona Dona Maria' })).toBeNull();
});
