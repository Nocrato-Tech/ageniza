// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { TeamScreen } from './TeamScreen';
import { ClientAccess } from './ClientAccess';
import { BrandStudy } from './BrandStudy';
import { ClientManagement } from './ClientManagement';
import { ClientListQuerySchema, CollaboratorListQuerySchema } from '@ageniza/contracts';
import { ClientPhoto } from './ClientPhoto';
import { ContentEditor } from '../product/ContentEditor';
import type { Data, Repository } from '../product/types';

beforeEach(() => {
  request.mockReset(); pick.mockReset();
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(cleanup);

const agency = { type: 'agency' as const, agencyId: 'agency-one', agencyName: 'Agência Um', roleKey: 'production', roleName: 'Produção', isOwner: false };
const people = [
  { membershipId: 'member-one', name: 'Ana Design', email: 'ana@example.test', jobTitle: 'Designer', role: { key: 'production', name: 'Produção' }, isOwner: false, isSelf: true, status: 'active', joinedAt: '2026-10-01T00:00:00Z' },
  { membershipId: 'member-two', name: 'Bruno Vídeo', email: 'bruno@example.test', jobTitle: 'Editor', role: { key: 'production', name: 'Produção' }, isOwner: false, isSelf: false, status: 'active', joinedAt: '2026-10-01T00:00:00Z' }
];
describe('management permissions and mutation targets', () => {
  it('keeps a viewing-only collaborator from seeing account administration', async () => {
    request.mockResolvedValue({ data: people, meta: { totalPages: 1 } });
    render(<TeamScreen context={agency} permissions={['colaborador.visualizar']} readOnly={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir Bruno Vídeo' }));
    expect(screen.getByText('bruno@example.test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Salvar cargo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remover da equipe' })).toBeNull();
    expect(request.mock.calls.every(([path]) => String(path).includes('/collaborators?'))).toBe(true);
  });
  it('allows reducing access during read-only mode and removes the second person, never the first', async () => {
    request.mockResolvedValue({ data: people, meta: { totalPages: 1 } });
    render(<TeamScreen context={agency} permissions={['colaborador.visualizar', 'colaborador.remover']} readOnly />);
    fireEvent.click(await screen.findByRole('button', { name: 'Abrir Bruno Vídeo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remover da equipe' }));
    expect(screen.getByText('Remover este acesso encerra todas as sessões da pessoa')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar remoção do acesso' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/agencies/agency-one/collaborators/member-two/remove', { method: 'POST' }));
    expect(request.mock.calls.some(([path]) => String(path).includes('member-one/remove'))).toBe(false);
  });
  it('hides adding portal access in read-only mode but keeps the server-approved removal action', async () => {
    request.mockResolvedValue({ data: [{ accessId: 'access-two', email: 'client@example.test', name: null, status: 'active', entered: true, since: '2026-10-01' }], meta: { totalPages: 1 } });
    render(<ClientAccess root="/agencies/agency-one/clients/client-one" permissions={['cliente.convidar_usuario', 'cliente.remover_usuario']} readOnly />);
    expect(screen.queryByRole('button', { name: 'Adicionar e enviar boas-vindas' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Remover acesso de client@example.test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar remoção do portal' }));
    await waitFor(() => expect(request).toHaveBeenCalledWith('/agencies/agency-one/clients/client-one/members/access-two/remove', { method: 'POST' }));
  });
  it('does not permit portal brand-study comments while the agency is read-only', async () => {
    request.mockImplementation(async (path: string) => path.endsWith('/brand-study') ? { filled: 1, sections: [{ key: 'branding', body: 'Identidade aprovada.', archetype: null, colors: null }], personas: [] } : { data: [], meta: { totalPages: 1 } });
    render(<BrandStudy root="/clients/client-one" agency={false} canEdit={false} readOnly />);
    fireEvent.click(await screen.findByRole('button', { name: 'Conversar sobre Identidade da marca' }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => String(path).includes('/clients/client-one/threads?sectionKey=branding'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'Enviar mensagem' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar Identidade da marca' })).toBeNull();
  });
});


describe('client photo boundaries', () => {
  const root = '/agencies/agency-one/clients/client-two';
  it('does not expose photo mutations to a viewer', () => {
    render(<ClientPhoto root={root} name="Marca" photoUrl={null} editable={false} onChanged={async () => {}} />);
    expect(screen.queryByRole('button', { name: 'Alterar foto do cliente' })).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it('does not mutate when the picker is cancelled or the image exceeds the limit', async () => {
    pick.mockResolvedValueOnce({ canceled: true }).mockResolvedValueOnce({ canceled: false, assets: [{ size: 10 * 1024 * 1024 + 1 }] });
    render(<ClientPhoto root={root} name="Marca" photoUrl={null} editable onChanged={async () => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Alterar foto do cliente' }));
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Alterar foto do cliente' }).getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Alterar foto do cliente' }));
    expect(await screen.findByText('Escolha uma imagem de até 10 MB.')).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });
  it('uploads only to the selected client and distinguishes a failed reload from a failed write', async () => {
    pick.mockResolvedValue({ canceled: false, assets: [{ file: new File(['image'], 'cover.png', { type: 'image/png' }), size: 5 }] });
    request.mockResolvedValue({});
    const changed = vi.fn().mockRejectedValue(new Error('offline'));
    render(<ClientPhoto root={root} name="Marca" photoUrl={null} editable onChanged={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Alterar foto do cliente' }));
    expect(await screen.findByText('A foto foi atualizada no servidor. Atualize o cadastro para recarregar a imagem.')).toBeTruthy();
    expect(request).toHaveBeenCalledExactlyOnceWith(`${root}/photo`, { method: 'PUT', body: { imageBase64: 'aW1hZ2U=' } });
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('requires confirmation and does not delete a different client photo', async () => {
    request.mockResolvedValue({});
    render(<ClientPhoto root={root} name="Marca" photoUrl="https://example.test/photo.png" editable onChanged={async () => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remover foto do cliente' }));
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Manter foto' }));
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remover foto do cliente' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar remoção da foto' }));
    await waitFor(() => expect(request).toHaveBeenCalledExactlyOnceWith(`${root}/photo`, { method: 'DELETE' }));
  });
});

describe('content editor recovery', () => {
  it('retries an already created draft by its server id instead of creating it again', async () => {
    const clientId = '11111111-1111-4111-8111-111111111111';
    const folderId = '22222222-2222-4222-8222-222222222222';
    const contentId = '33333333-3333-4333-8333-333333333333';
    const data: Data = { version: 2, clients: [{ id: clientId, name: 'Marca', handle: '' }], people: [], posts: [], activities: [], profile: { name: 'Pessoa', agency: 'Agência' }, permissions: [], readOnly: false, assets: [], folders: [{ id: folderId, clientId, name: 'Publicações' }] };
    const repository = { library: async () => ({ folders: data.folders, assets: [] }) } as unknown as Repository;
    const save = vi.fn(async (_input, _id, created) => { created?.(contentId); });
    render(<ContentEditor data={data} repository={repository} clientId={clientId} busy={false} onSave={save} onError={() => {}} onRefresh={async () => {}} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Título interno *' }), { target: { value: 'Conteúdo real' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continuar para conteúdo' }).getAttribute('aria-disabled')).not.toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Continuar para conteúdo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Conferir prévia' }));
    fireEvent.click(screen.getByRole('button', { name: 'Criar conteúdo' }));
    expect(await screen.findByText('Conteúdo já criado')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][1]).toBeUndefined();
    expect(save.mock.calls[1][1]).toBe(contentId);
  });
});

describe('list queries follow the actual route contract', () => {
  it('loads team initially without an empty search and sends trimmed encoded search', async () => {
    request.mockImplementation(async (path: string) => {
      const url = new URL(path, 'https://api.example.test');
      CollaboratorListQuerySchema.parse(Object.fromEntries(url.searchParams));
      return { data: people, meta: { totalPages: 1 } };
    });
    render(<TeamScreen context={agency} permissions={['colaborador.visualizar']} readOnly={false} />);
    await screen.findByRole('button', { name: 'Abrir Bruno Vídeo' });
    expect(new URL(request.mock.calls[0][0], 'https://api.example.test').searchParams.has('q')).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar na equipe' }), { target: { value: '  Ana & Design  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => new URL(path, 'https://api.example.test').searchParams.get('q') === 'Ana & Design')).toBe(true));
  });
  it('loads the client portfolio without empty search and validates subsequent searches', async () => {
    request.mockImplementation(async (path: string) => {
      const url = new URL(path, 'https://api.example.test');
      ClientListQuerySchema.parse(Object.fromEntries(url.searchParams));
      return { data: [{ id: 'client-one', name: 'Marca', instagramHandle: null, status: 'active' }], meta: { totalPages: 1 } };
    });
    render(<ClientManagement context={agency} permissions={['cliente.visualizar']} readOnly={false} onChanged={async () => {}} onContents={() => {}} />);
    await screen.findByRole('button', { name: 'Gerenciar Marca' });
    expect(new URL(request.mock.calls[0][0], 'https://api.example.test').searchParams.has('search')).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar cliente' }), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar cliente' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(new URL(request.mock.calls[1][0], 'https://api.example.test').searchParams.has('search')).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: 'Buscar cliente' }), { target: { value: ' Marca & Saúde ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Buscar cliente' }));
    await waitFor(() => expect(request.mock.calls.some(([path]) => new URL(path, 'https://api.example.test').searchParams.get('search') === 'Marca & Saúde')).toBe(true));
  });
});
