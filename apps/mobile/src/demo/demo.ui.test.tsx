// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const request = vi.hoisted(() => vi.fn());
const pick = vi.hoisted(() => vi.fn());
vi.mock('expo-document-picker', () => ({ getDocumentAsync: pick }));
vi.mock('../api/runtime', () => ({ api: { request }, browserPreview: false, webUrl: 'https://dev.ageniza.com.br' }));
vi.mock('react-native', async () => Object.fromEntries(await Promise.all(['View', 'Text', 'TextInput', 'Pressable', 'ScrollView', 'StyleSheet', 'Image', 'Modal', 'Platform', 'Animated', 'Easing', 'AccessibilityInfo', 'Switch', 'KeyboardAvoidingView', 'ActivityIndicator', 'Linking'].map(async (name) => [name, (await vi.importActual<{ default: unknown }>(`react-native-web/dist/exports/${name}/index.js`)).default]))));
vi.mock('expo-video', () => ({ VideoView: () => null, useVideoPlayer: () => ({ addListener: () => ({ remove() {} }) }) }));
vi.mock('react-native-svg', async () => {
  const { createElement } = await import('react');
  const part = ({ children }: { children?: ReactNode }) => createElement('svg', {}, children);
  return { default: part, ...Object.fromEntries(['Svg', 'Defs', 'LinearGradient', 'Stop', 'Rect', 'Path', 'Circle', 'Line', 'Polyline', 'Polygon', 'Ellipse', 'G', 'ClipPath'].map((key) => [key, part])) };
});
const setup = vi.hoisted(() => ({ create: vi.fn(), populate: vi.fn() }));
vi.mock('./workspace', () => ({ createDemoWorkspace: setup.create, populateDemoWorkspace: setup.populate }));
vi.mock('./config', () => ({ demoWorkspaceEnabled: true, demoAgencyName: 'Agência Horizonte · Demonstração' }));
import { DemoWorkspace } from './DemoWorkspace';
import { ContentLearning, contentSignals } from './ContentLearning';
import type { Post } from '../product/types';
const context = { type: 'agency' as const, agencyId: 'demo-one', agencyName: 'Agência Horizonte · Demonstração', isOwner: true, roleKey: 'owner', roleName: 'Owner' };
beforeEach(() => {
 request.mockReset();
 setup.create.mockReset().mockResolvedValue(context); setup.populate.mockReset();
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['png']) }));
 Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
it('offers the real example portal from an existing demo workspace', async () => {
 const portal = { type: 'client' as const, agencyId: context.agencyId, agencyName: context.agencyName, clientId: 'example-client', clientName: 'Clínica Vida · Exemplo', onboardingPending: true };
 request.mockResolvedValueOnce({ emailVerified: true, user: { email: 'tester@example.test' } })
  .mockResolvedValueOnce({ contexts: [context, portal] })
  .mockResolvedValueOnce({ data: [{ id: portal.clientId, name: portal.clientName }], meta: { totalPages: 1 } });
 const enterPortal = vi.fn();
 render(<DemoWorkspace existing={context} onEnter={() => {}} onEnterPortal={enterPortal} />);
 expect(request).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button', { name: 'Preparar meu acesso ao portal de exemplo' }));
 const portalButton = await screen.findByRole('button', { name: 'Entrar no portal de exemplo' });
 await waitFor(() => expect(portalButton.getAttribute('aria-busy')).toBe('false'));
 fireEvent.click(portalButton);
 await waitFor(() => expect(enterPortal).toHaveBeenCalledExactlyOnceWith(portal));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('requires confirmation and reuses the server agency after a partial failure', async () => {
 const enter = vi.fn(); setup.populate.mockRejectedValueOnce(new Error('Upload interrompido')).mockResolvedValueOnce(undefined);
 render(<DemoWorkspace onEnter={enter} />);
 fireEvent.click(screen.getByRole('button', { name: 'Criar agência de demonstração' }));
 expect(setup.create).not.toHaveBeenCalled();
 const button = screen.getByRole('button', { name: 'Confirmar e preparar exemplos' });
 act(() => { fireEvent.click(button); fireEvent.click(button); });
 await screen.findByText('Upload interrompido');
 expect(setup.create).toHaveBeenCalledTimes(1); expect(enter).not.toHaveBeenCalled();
 await waitFor(() => expect(screen.getByRole('button', { name: 'Continuar preparação dos exemplos' }).getAttribute('aria-disabled')).not.toBe('true'));
 await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Continuar preparação dos exemplos' })); });
 await waitFor(() => expect(enter).toHaveBeenCalledExactlyOnceWith(context));
 expect(setup.create).toHaveBeenCalledTimes(1); expect(setup.populate).toHaveBeenCalledTimes(2);
});
it('derives learning signals from the fetched post rather than editable presentation controls', () => {
 const post = { date: '2026-11-06', revision: 3, tasks: [{ status: 'pending' }, { status: 'approved' }, { status: 'delivered' }] } as Post;
 expect(contentSignals(post, '2026-11-05')).toEqual({ days: 1, pending: 2, revisions: 2 });
 const view = render(<ContentLearning post={post} />);
 fireEvent.click(screen.getByRole('button', { name: 'Entender análise do conteúdo' }));
 expect(screen.getByText(/2 tarefas pendentes/)).toBeTruthy();
 view.rerender(<ContentLearning post={{ ...post, tasks: post.tasks.map((task) => ({ ...task, status: 'approved' })) }} />);
 expect(screen.getByText(/0 tarefas pendentes/)).toBeTruthy();
});
