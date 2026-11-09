// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const request = vi.hoisted(() => vi.fn());
const mode = vi.hoisted(() => ({ demo: false }));
vi.mock('../demo/config', () => ({ get demoWorkspaceEnabled() { return mode.demo; } }));
const approvalRequest = vi.hoisted(() => vi.fn());
vi.mock('../api/approval', () => ({ createApprovalClient: () => ({ request: approvalRequest, clear: async () => {} }) }));
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
import { BrandStudy } from './BrandStudy';
import { TeamScreen } from './TeamScreen';
import { ClientManagement } from './ClientManagement';

const agency = { type: 'agency' as const, agencyId: 'one', agencyName: 'Agência', isOwner: true, roleKey: 'owner', roleName: 'Owner' };
const study = { filled: 1, sections: [{ key: 'branding', body: 'Identidade aprovada.', archetype: null, colors: null }], personas: [] };
const animations = vi.fn(() => ({ cancel: vi.fn(), playState: 'finished' }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  request.mockReset(); animations.mockClear();
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animations });
});

it('retains a focused brand draft while typing and makes the cancelled editor inert until its exit finishes', async () => {
  request.mockResolvedValue(study);
  render(<BrandStudy root="/clients/two" canEdit />);
  fireEvent.click(await screen.findByRole('button', { name: 'Editar Identidade da marca' }));
  const input = screen.getByRole('textbox', { name: 'Identidade da marca' });
  input.focus();
  fireEvent.change(input, { target: { value: 'Rascunho novo' } });
  expect(screen.getByRole('textbox', { name: 'Identidade da marca' })).toBe(input);
  expect(document.activeElement).toBe(input);
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar edição' }));
  expect(input.isConnected).toBe(true);
  expect(input.closest('[inert]')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Identidade da marca' })).toBeNull();
  await waitFor(() => expect(input.isConnected).toBe(false));
  expect(request.mock.calls.every(([, options]) => !options.method)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Editar Identidade da marca' }));
  expect((screen.getByRole('textbox', { name: 'Identidade da marca' }) as HTMLTextAreaElement).value).toBe('Identidade aprovada.');
});

it('animates client tab context changes without animating typing or losing the registration draft', async () => {
  request.mockImplementation(async (path: string) => path.endsWith('/brand-study') ? study : { id: 'two', name: 'Clínica Vida', status: 'active', summary: { brandStudyFilled: 1, threadsAwaitingAgency: 0, activePortalMembers: 0 } });
  render(<ClientManagement context={agency} initialClientId="two" permissions={['cliente.operar']} readOnly={false} onChanged={async () => {}} onContents={() => {}} />);
  const name = await screen.findByRole('textbox', { name: 'Nome do cliente' });
  const beforeTyping = animations.mock.calls.length;
  name.focus();
  fireEvent.change(name, { target: { value: 'Nome em edição' } });
  expect(document.activeElement).toBe(name);
  expect(animations.mock.calls).toHaveLength(beforeTyping);
  fireEvent.click(screen.getByRole('tab', { name: 'Marca' }));
  await screen.findByText('Identidade aprovada.');
  expect(animations.mock.calls.length).toBeGreaterThan(beforeTyping);
  fireEvent.click(screen.getByRole('tab', { name: 'Geral' }));
  expect((screen.getByRole('textbox', { name: 'Nome do cliente' }) as HTMLInputElement).value).toBe('Nome em edição');
  expect(request.mock.calls.every(([, options]) => !options.method)).toBe(true);
});

it('animates opening and returning from a collaborator while preserving the focused job field during edits', async () => {
  request.mockResolvedValue({ data: [{ membershipId: 'member-two', name: 'Bruno', email: 'bruno@example.test', jobTitle: 'Editor', role: { key: 'production', name: 'Produção' }, isOwner: false, isSelf: false, status: 'active', joinedAt: '2026-10-01' }], meta: { totalPages: 1 } });
  render(<TeamScreen context={agency} permissions={['colaborador.visualizar', 'colaborador.alterar_funcao']} readOnly={false} />);
  const open = await screen.findByRole('button', { name: 'Abrir Bruno' });
  const beforeOpen = animations.mock.calls.length;
  fireEvent.click(open);
  const job = screen.getByRole('textbox', { name: 'Cargo' });
  expect(animations.mock.calls.length).toBeGreaterThan(beforeOpen);
  const beforeTyping = animations.mock.calls.length;
  job.focus();
  fireEvent.change(job, { target: { value: 'Editor sênior' } });
  expect(document.activeElement).toBe(job);
  expect(animations.mock.calls).toHaveLength(beforeTyping);
  fireEvent.click(screen.getByRole('button', { name: 'Voltar à equipe' }));
  expect(screen.getByRole('button', { name: 'Abrir Bruno' })).toBeTruthy();
  expect(animations.mock.calls.length).toBeGreaterThan(beforeTyping);
  expect(request.mock.calls.every(([, options]) => !options.method)).toBe(true);
});


it('keeps team tabs mounted while changing mode with a pending server response', async () => {
  let finish!: (value: unknown) => void;
  request.mockImplementation(async (path: string) => path.includes('/roles') ? { data: [] } : path.includes('/invitations') ? {data:[],meta:{totalPages:1}} : path.includes('status=removed') ? new Promise((resolve)=>{finish=resolve;}) : { data: [], meta: { totalPages: 1 } });
  render(<TeamScreen context={agency} permissions={['colaborador.visualizar','colaborador.convidar','colaborador.remover']} readOnly={false} />);
  const active = screen.getByRole('tab',{name:'Equipe'});
  fireEvent.click(screen.getByRole('tab',{name:'Removidos'}));
  expect(screen.getByRole('tab',{name:'Equipe'})).toBe(active);
  expect(screen.getByRole('tab',{name:'Removidos'}).getAttribute('aria-selected')).toBe('true');
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
});
