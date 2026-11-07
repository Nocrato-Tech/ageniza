// @vitest-environment jsdom
// The demo gate (issue #834): with EXPO_PUBLIC_DEMO_WORKSPACE off, no demo entry is offered by the app shell or by the content screen.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const gate = vi.hoisted(() => ({ enabled: false }));
vi.mock('../demo/config', () => ({ get demoWorkspaceEnabled() { return gate.enabled; }, demoAgencyName: 'Agência Horizonte · Demonstração' }));
vi.mock('../demo/DemoWorkspace', () => ({ DemoWorkspace: () => <p>Demo workspace screen</p> }));
vi.mock('../demo/WebNotifications', () => ({ WebNotifications: () => <p>Demo notifications</p> }));
vi.mock('../demo/ContentLearning', () => ({ ContentLearning: () => <p>Demo content learning</p> }));
const repository = vi.hoisted(() => ({ demo: false, load: vi.fn(), detail: vi.fn(), library: vi.fn(), thumbnail: vi.fn(), save: vi.fn(), move: vi.fn() }));
vi.mock('./remote', () => ({ remoteRepository: () => repository }));
import { writeDraft } from './draft-store';
import { MobileApp } from './MobileApp';
import type { Data, Post } from './types';

const post: Post = { id: 'p1', clientId: 'c1', title: 'Conteúdo de teste', caption: 'Legenda', format: 'image', status: 'in_production', date: '2026-11-10', time: '10:00', ownerId: 'm1', folderId: '', mediaIds: [], coverId: null, revision: 1, tasks: [], comments: [] };
const data: Data = { version: 2, clients: [{ id: 'c1', name: 'Marca', handle: '' }], people: [{ id: 'm1', name: 'Pessoa', job: '', role: 'Dono', email: 'p@example.test', self: true, owner: true }], posts: [post], activities: [], profile: { name: 'Pessoa', agency: 'Agência' }, permissions: ['*'], readOnly: false, assets: [], folders: [] };

const context = { type: 'agency' as const, agencyId: 'one', agencyName: 'Agência', isOwner: true, roleKey: 'owner', roleName: 'Owner' };
beforeEach(() => {
  window.sessionStorage.clear(); request.mockReset().mockResolvedValue({ user: { id: 'user-one' } }); repository.load.mockReset().mockResolvedValue(data); repository.detail.mockReset().mockResolvedValue(post); repository.library.mockReset().mockResolvedValue({ folders: [], assets: [] });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(cleanup);
it('retains content search when returning from its detail', async () => {
  render(<MobileApp context={context} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Conteúdos' }));
  fireEvent.click(screen.getByRole('button', { name: 'Filtros de conteúdo' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Buscar conteúdo' }), { target: { value: 'teste' } });
  fireEvent.click(screen.getByRole('button', { name: 'Abrir Conteúdo de teste' }));
  await screen.findByRole('button', { name: 'Editar conteúdo' });
  fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
  expect((await screen.findByRole('textbox', { name: 'Buscar conteúdo' }) as HTMLInputElement).value).toBe('teste');
});
it('reports the confirmed action even when list refresh fails, without suggesting a duplicate write', async () => {
  render(<MobileApp context={context} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Abrir Conteúdo de teste' }));
  await screen.findByRole('button', { name: 'Enviar para aprovação' });
  repository.move.mockResolvedValue({ ...post, status: 'awaiting_approval' }); repository.load.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Enviar para aprovação' }));
  await screen.findByText(/Conteúdo enviado para aprovação/);
  expect(screen.getByText(/não foi atualizada/)).toBeTruthy();
  expect(repository.move).toHaveBeenCalledTimes(1);
});

it('asks before leaving unsaved content and can keep editing without losing its title', async () => {
  render(<MobileApp context={context} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Criar conteúdo' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Título interno *' }), { target: { value: 'Nova ideia da marca' } });
  fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
  await screen.findByText('Sair da criação de conteúdo?');
  fireEvent.click(screen.getByRole('button', { name: 'Continuar editando' }));
  expect((screen.getByRole('textbox', { name: 'Título interno *' }) as HTMLInputElement).value).toBe('Nova ideia da marca');
});
it('recovers an unsaved draft after remounting in the same browser account and context', async () => {
  const first = render(<MobileApp context={context} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Criar conteúdo' }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Título interno *' }), { target: { value: 'Ideia preservada nesta aba' } });
  first.unmount();
  render(<MobileApp context={context} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Criar conteúdo' }));
  expect((await screen.findByRole('textbox', { name: 'Título interno *' }) as HTMLInputElement).value).toBe('Ideia preservada nesta aba');
  expect(screen.getByText('Rascunho recuperado')).toBeTruthy();
});
it('waits for trusted identity before opening an editor and preserves a recovered draft', async () => {
  let resolveSession: (value: unknown) => void = () => {};
  request.mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; }));
  writeDraft(window.sessionStorage, { userId: 'user-one', context: { type: 'agency', id: 'one' } }, 'new-all', { input: { clientId: 'c1', folderId: '', ownerId: 'm1', title: 'Rascunho anterior', caption: 'Legenda preservada', format: 'image', date: '2026-11-10', time: '10:00', mediaIds: [], coverId: null } });
  render(<MobileApp context={context} onExit={() => {}} />);
  const create = await screen.findByRole('button', { name: 'Criar conteúdo' });
  fireEvent.click(create); fireEvent.click(create);
  expect(screen.queryByRole('textbox', { name: 'Título interno *' })).toBeNull();
  expect(screen.getByLabelText('Preparando rascunho')).toBeTruthy();
  await act(async () => resolveSession({ user: { id: 'user-one' } }));
  expect((await screen.findByRole('textbox', { name: 'Título interno *' }) as HTMLInputElement).value).toBe('Rascunho anterior');
  expect(screen.getByText('Rascunho recuperado')).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
});

it('uses honest memory-only exit copy when browser storage cannot save', async () => {
  const stored = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  try {
    render(<MobileApp context={context} onExit={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Criar conteúdo' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Título interno *' }), { target: { value: 'Somente memória' } });
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(await screen.findByText(/O rascunho ficará em memória/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manter nesta sessão e sair' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Guardar rascunho e sair' })).toBeNull();
  } finally { stored.mockRestore(); }
});

it('does not reopen a pending editor after the user navigates elsewhere', async () => {
  let resolveSession: (value: unknown) => void = () => {};
  request.mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; }));
  render(<MobileApp context={context} onExit={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Criar conteúdo' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Calendário' }));
  await act(async () => resolveSession({ user: { id: 'user-one' } }));
  expect(screen.queryByRole('textbox', { name: 'Título interno *' })).toBeNull();
  expect(screen.getByText('Calendário editorial')).toBeTruthy();
});


it('filters clients without reloading the repository or replaying the whole page arrival', async () => {
 Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener(){},removeEventListener(){}})});
 const calls: HTMLElement[]=[];
 Object.defineProperty(HTMLElement.prototype,'animate',{configurable:true,value:function(this:HTMLElement){calls.push(this);return {cancel:()=>{},playState:'finished'};}});
 const {container}=render(<MobileApp context={context} onExit={()=>{}} />);
 fireEvent.click(await screen.findByRole('tab',{name:'Conteúdos'}));
 const client=await screen.findByRole('button',{name:'Filtrar Marca'});
 const page=container.querySelector('[data-motion="peer"]');
 expect(page).toBeTruthy();
 const before=calls.filter((element)=>element===page).length;
 const loads=repository.load.mock.calls.length;
 fireEvent.click(client);
 expect(container.querySelector('[data-motion="peer"]')).toBe(page);
 expect(calls.filter((element)=>element===page)).toHaveLength(before);
 expect(repository.load).toHaveBeenCalledTimes(loads);
});
