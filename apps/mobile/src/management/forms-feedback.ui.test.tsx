// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import { ClientAccess } from './ClientAccess';
import { TeamScreen } from './TeamScreen';
import { ClientManagement } from './ClientManagement';
import { StoriesScreen } from './StoriesScreen';

afterEach(cleanup);
beforeEach(() => { request.mockReset().mockResolvedValue({ data: [], meta: { totalPages: 1 } }); Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) }); });

it('focuses an invalid portal email and preserves it without granting access', async () => {
  render(<ClientAccess root="/agencies/one/clients/two" permissions={['cliente.convidar_usuario']} readOnly={false} />);
  await screen.findByText('Nenhum acesso nesta lista');
  const email = screen.getByLabelText('E-mail para acesso');
  fireEvent.change(email, { target: { value: 'invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar e enviar boas-vindas' }));
  expect(await screen.findByText('Informe um e-mail válido.')).toBeTruthy();
  expect(document.activeElement).toBe(email);
  expect(email.getAttribute('aria-invalid')).toBe('true');
  expect((email as HTMLInputElement).value).toBe('invalid');
  expect(request.mock.calls.every(([, options]) => options.method !== 'POST')).toBe(true);
});

it('focuses invalid team invite email while retaining the selected role without sending', async () => {
  const role = { id: '11111111-1111-4111-8111-111111111111', key: 'production', name: 'Produção' };
  request.mockImplementation(async (path: string) => path.endsWith('/roles') ? { data: [role] } : { data: [], meta: { totalPages: 1 } });
  render(<TeamScreen context={{ type: 'agency', agencyId: 'one', agencyName: 'Agência', isOwner: true, roleKey: 'owner', roleName: 'Owner' }} permissions={['colaborador.convidar']} readOnly={false} />);
  fireEvent.click(await screen.findByRole('tab', { name: 'Convites' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Papel do convite' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Selecionar Produção' }));
  const email = screen.getByLabelText('E-mail da pessoa');
  fireEvent.change(email, { target: { value: 'invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar convite' }));
  expect(await screen.findByText('Informe um e-mail válido.')).toBeTruthy();
  expect(document.activeElement).toBe(email);
  expect(email.getAttribute('aria-invalid')).toBe('true');
  expect(request.mock.calls.every(([, options]) => options.method !== 'POST')).toBe(true);
});

it('identifies the specific invalid client registration field and keeps the other values', async () => {
  request.mockResolvedValue({ id: 'two', name: 'Clínica Vida', status: 'active', summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, activePortalMembers: 0 } });
  render(<ClientManagement context={{ type: 'agency', agencyId: 'one', agencyName: 'Agência', isOwner: true, roleKey: 'owner', roleName: 'Owner' }} initialClientId="two" permissions={['cliente.operar']} readOnly={false} onChanged={async () => {}} onContents={() => {}} />);
  const email = await screen.findByLabelText('E-mail do contato');
  fireEvent.change(email, { target: { value: 'invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar cadastro' }));
  expect(await screen.findByText('Informe um e-mail de contato válido.')).toBeTruthy();
  expect(document.activeElement).toBe(email);
  expect(email.getAttribute('aria-invalid')).toBe('true');
  expect((screen.getByLabelText('Nome do cliente') as HTMLInputElement).value).toBe('Clínica Vida');
  expect(request.mock.calls.every(([, options]) => options.method !== 'PATCH')).toBe(true);
});


it('keeps the real portal-access POST contract after correcting the email', async () => {
  render(<ClientAccess root="/agencies/one/clients/two" permissions={['cliente.convidar_usuario']} readOnly={false} />);
  await screen.findByText('Nenhum acesso nesta lista');
  fireEvent.change(screen.getByLabelText('E-mail para acesso'), { target: { value: 'Person@Example.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Adicionar e enviar boas-vindas' }));
  expect(await screen.findByText('Acesso adicionado.')).toBeTruthy();
  expect(request).toHaveBeenCalledWith('/agencies/one/clients/two/members', { method: 'POST', body: { email: 'person@example.test' } });
});


it('uses the branded closing-date picker and preserves the date-only closing PUT', async () => {
  const detail = { id: 'two', name: 'Clínica Vida', status: 'active', closingDate: '2026-12-15', summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, activePortalMembers: 0 } };
  request.mockResolvedValue(detail);
  render(<ClientManagement context={{ type: 'agency', agencyId: 'one', agencyName: 'Agência', isOwner: true, roleKey: 'owner', roleName: 'Owner' }} initialClientId="two" permissions={['cliente.arquivar']} readOnly={false} onChanged={async () => {}} onContents={() => {}} />);
  const date = await screen.findByLabelText('Último dia do contrato (AAAA-MM-DD)');
  expect(date.getAttribute('type')).toBe('text');
  fireEvent.click(screen.getByRole('button', { name: 'Abrir calendário' }));
  fireEvent.change(await screen.findByLabelText('Data (AAAA-MM-DD)'), { target: { value: '2026-12-20' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar data' }));
  expect((date as HTMLInputElement).value).toBe('2026-12-20');
  fireEvent.click(screen.getByRole('button', { name: 'Agendar encerramento' }));
  expect(await screen.findByText('Encerramento agendado.')).toBeTruthy();
  expect(request).toHaveBeenCalledWith('/agencies/one/clients/two/closing', { method: 'PUT', body: { closingDate: '2026-12-20' } });
});

it('uses the branded story picker and saves the selected calendar day unchanged', async () => {
  request.mockImplementation(async (path: string, options: { method?: string; body?: { scriptOn: string; scenes: unknown[] } }) => options.method === 'POST' ? { id: 'script-one', status: 'draft', scriptOn: options.body?.scriptOn, scenes: options.body?.scenes } : { data: { storyScripts: [] } });
  render(<StoriesScreen context={{ type: 'agency', agencyId: 'one', agencyName: 'Agência', isOwner: true, roleKey: 'owner', roleName: 'Owner' }} clients={[{ id: 'two', name: 'Clínica Vida', handle: '' }]} permissions={['conteudo.operar']} readOnly={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Criar roteiro' }));
  const date = screen.getByLabelText('Data do roteiro (AAAA-MM-DD)');
  expect(date.getAttribute('type')).toBe('text');
  fireEvent.click(screen.getByRole('button', { name: 'Abrir calendário' }));
  fireEvent.change(await screen.findByLabelText('Data (AAAA-MM-DD)'), { target: { value: '2026-12-20' } });
  fireEvent.click(screen.getByRole('button', { name: 'Confirmar data' }));
  fireEvent.change(screen.getByLabelText('Texto da cena 1'), { target: { value: 'Apresente a novidade.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar roteiro' }));
  expect(await screen.findByText('Roteiro salvo.')).toBeTruthy();
  expect(request).toHaveBeenCalledWith('/agencies/one/clients/two/story-scripts', { method: 'POST', body: { scriptOn: '2026-12-20', scenes: [{ text: 'Apresente a novidade.', guidance: null }] } });
});

it('keeps the portal story date read-only without exposing a date picker', async () => {
  request.mockResolvedValue({ data: [{ id: 'script-one', scriptOn: '2026-11-12', status: 'sent', scenes: [{ text: 'Apresente a novidade.', guidance: null }] }] });
  render(<StoriesScreen context={{ type: 'client', clientId: 'two', clientName: 'Clínica Vida', agencyId: 'one', agencyName: 'Agência', onboardingPending: false }} clients={[]} permissions={[]} readOnly />);
  fireEvent.click(await screen.findByRole('button', { name: /Abrir roteiro de/ }));
  expect((screen.getByLabelText('Data do roteiro (AAAA-MM-DD)') as HTMLInputElement).readOnly).toBe(true);
  expect(screen.queryByRole('button', { name: 'Abrir calendário' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Salvar roteiro' })).toBeNull();
});
