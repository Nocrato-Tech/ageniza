// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PROFILE_PHOTO_MAX_BYTES } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { formatDayMonth } from './client-detail.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

afterEach(cleanup);

const dialogDescriptors = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
beforeAll(() => {
  // jsdom has no top layer; these stubs only model opening and closing.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => {
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
  }
});

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const AGENCY_B = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_CLIENT_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });

const agencyMe = (agencyId: string, permissions: readonly string[]) => ({
  agencyId, agencyName: agencyId === AGENCY_B ? 'Agência Dois' : 'Agência Um', isOwner: false, role: { key: 'admin', name: 'Admin' }, permissions
});

/** Every permission of the module: Admin and Owner see everything (specs/clientes.md §2). */
const ADMIN_PERMISSIONS = ['cliente.visualizar', 'cliente.operar', 'cliente.cadastrar', 'cliente.arquivar', 'cliente.convidar_usuario', 'cliente.remover_usuario'];
const MANAGER_PERMISSIONS = ['cliente.visualizar', 'cliente.operar', 'cliente.cadastrar'];
const READER_PERMISSIONS = ['cliente.visualizar'];

/** The full detail answer of `GET .../clients/:clientId` (SPEC §6: registration + Geral summary). */
const padaria = {
  id: CLIENT_ID,
  name: 'Padaria Central',
  status: 'active',
  photoUrl: null as string | null,
  legalName: 'Padaria Central Ltda',
  taxId: '12345678000190',
  segment: 'Alimentação',
  website: 'https://padaria.example.test',
  instagramHandle: 'padariacentral',
  contactName: 'Maria Souza',
  contactPhone: '+55 11 99999-0000',
  contactEmail: 'maria@padaria.example.test',
  closingDate: '2026-10-30',
  archivedAt: null,
  summary: { brandStudyFilled: 5, threadsAwaitingAgency: 2, threadsAnsweredByAgency: 1, activePortalMembers: 3 }
};
const academia = {
  ...padaria,
  id: OTHER_CLIENT_ID,
  name: 'Academia Corpo',
  instagramHandle: 'academiacorpo',
  website: null,
  summary: { brandStudyFilled: 1, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 1 }
};
const archivedClient = {
  ...padaria,
  status: 'archived',
  closingDate: null,
  archivedAt: '2026-10-04T12:00:00.000Z',
  summary: { ...padaria.summary, activePortalMembers: 0 }
};
/** A client with a photo: the modal offers Removal only in that case. */
const withPhoto = { ...padaria, photoUrl: 'https://storage.test/padaria.png' as string | null };
/** A registration with everything empty: the Geral tab writes "não informado" seven times. */
const drainedClient = {
  ...padaria,
  legalName: null, taxId: null, segment: null, website: null, instagramHandle: null,
  contactName: null, contactPhone: null, contactEmail: null
};

/** The PATCH answers with the client only (without the summary; `ClientSchema` is strict). */
const registrationOf = (client: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(client).filter(([key]) => key !== 'summary'));

const registrationKeys = new Set(['summary', 'legalName', 'taxId', 'segment', 'website', 'contactName', 'contactPhone', 'contactEmail', 'archivedAt']);

const listItemOf = (client: Record<string, unknown>): Record<string, unknown> => ({
  ...Object.fromEntries(Object.entries(client).filter(([key]) => !registrationKeys.has(key))),
  threadsAwaitingAgency: 2,
  pendingInvitations: 0
});

interface Scenario {
  readonly authenticated?: boolean;
  readonly permissions?: readonly string[];
  readonly client?: (clientId: string, agencyId: string) => Response | Promise<Response>;
  readonly clients?: () => Response | Promise<Response>;
  readonly patch?: (body: unknown) => Response | Promise<Response>;
  readonly putPhoto?: (body: unknown) => Response | Promise<Response>;
  readonly deletePhoto?: () => Response | Promise<Response>;
}

/** Behaves like the real API: 401 without a session, one 404 for every hidden client. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const authenticated = scenario.authenticated ?? true;
  const permissions = scenario.permissions ?? ADMIN_PERMISSIONS;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (path.endsWith('/auth/session')) return authenticated ? json(sessionBody) : json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);
    if (!authenticated) return json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(me[1]!, permissions));
    const clients = /\/agencies\/([^/]+)\/clients$/.exec(path);
    if (clients !== null) return scenario.clients?.() ?? json({ data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
    const photo = /\/agencies\/([^/]+)\/clients\/([^/]+)\/photo$/.exec(path);
    if (photo !== null) {
      if (method === 'PUT') return scenario.putPhoto?.(JSON.parse(String(init?.body))) ?? json({ photoUrl: 'https://storage.test/nova.png' });
      if (method === 'DELETE') return scenario.deletePhoto?.() ?? noContent();
    }
    const detail = /\/agencies\/([^/]+)\/clients\/([^/]+)$/.exec(path);
    if (detail !== null) {
      if (method === 'PATCH') {
        if (scenario.patch === undefined) throw new Error(`unexpected PATCH ${url}`);
        return scenario.patch(JSON.parse(String(init?.body)));
      }
      return scenario.client?.(detail[2]!, detail[1]!) ?? (detail[2] === CLIENT_ID ? json(padaria) : json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface ProbeTarget {
  pathname: string;
  search: string;
  navigate: NavigateFunction;
}

function Probe({ probe }: { probe: ProbeTarget }) {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.search = location.search;
  probe.navigate = useNavigate();
  return null;
}

const clientUrl = (clientId = CLIENT_ID, tab = 'geral') => `/agencia/${AGENCY_A}/clientes/${clientId}/${tab}`;

const renderClientDetail = (impl: typeof fetch, entry = clientUrl()) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: ProbeTarget = { pathname: '', search: '', navigate: () => undefined };
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <Probe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { container: rendered.container, probe, queryClient };
};

const tabPanel = (container: HTMLElement): HTMLElement => {
  const panel = container.querySelector<HTMLElement>('.client-detail__panel');
  if (panel === null) throw new Error('The detail panel was not rendered.');
  return panel;
};

const openEditDialog = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Editar' }));
  return await screen.findByRole('dialog', { name: 'Editar cliente' });
};

/** The form group of the edit modal, identified by its heading ("Cliente", "Empresa"...). */
const groupOf = (dialog: HTMLElement, heading: string): HTMLElement => {
  const headingElement = within(dialog).getByRole('heading', { name: heading });
  const group = headingElement.closest('.edit-client__group');
  if (group === null) throw new Error(`The edit group ${heading} was not rendered.`);
  return group as HTMLElement;
};

const editNameInput = (dialog: HTMLElement): HTMLInputElement =>
  within(groupOf(dialog, 'Cliente')).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
const editInstagramInput = (dialog: HTMLElement): HTMLInputElement =>
  within(groupOf(dialog, 'Cliente')).getByRole('textbox', { name: 'Instagram' }) as HTMLInputElement;
const editTaxIdInput = (dialog: HTMLElement): HTMLInputElement =>
  within(groupOf(dialog, 'Empresa')).getByRole('textbox', { name: 'CNPJ ou CPF' }) as HTMLInputElement;
const editWebsiteInput = (dialog: HTMLElement): HTMLInputElement =>
  within(groupOf(dialog, 'Empresa')).getByRole('textbox', { name: 'Site' }) as HTMLInputElement;
const editContactEmailInput = (dialog: HTMLElement): HTMLInputElement =>
  within(groupOf(dialog, 'Contato do dono')).getByRole('textbox', { name: 'E-mail' }) as HTMLInputElement;
const modalFileInput = (dialog: HTMLElement): HTMLInputElement =>
  dialog.querySelector('input[type="file"]') as HTMLInputElement;

describe('client detail (#136)', () => {
  it('renders identity, status, closing badge and the General summary', async () => {
    const { impl } = makeFetch();
    renderClientDetail(impl);

    expect(await screen.findByRole('heading', { name: 'Padaria Central' })).toBeTruthy();
    expect(screen.getByText('@padariacentral')).toBeTruthy();
    expect(screen.getByText('Ativo')).toBeTruthy();
    expect(screen.getByText('encerra em 30/10')).toBeTruthy();
    expect(screen.getByText('PC')).toBeTruthy();
    expect(screen.getByText('Padaria Central Ltda')).toBeTruthy();
    expect(screen.getByText('12345678000190')).toBeTruthy();
    expect(screen.getByText('Alimentação')).toBeTruthy();
    expect(screen.getByText('https://padaria.example.test')).toBeTruthy();
    expect(screen.getByText('Maria Souza')).toBeTruthy();
    expect(screen.getByText('+55 11 99999-0000')).toBeTruthy();
    expect(screen.getByText('maria@padaria.example.test')).toBeTruthy();
    expect(screen.getByText('5 de 7')).toBeTruthy();
    expect(screen.getByText('2 aguardando a agência')).toBeTruthy();
    expect(screen.getByText('1 com resposta da agência')).toBeTruthy();
    expect(screen.getByText('3 pessoas com acesso')).toBeTruthy();
    expect(screen.getByText('Pendentes, atrasos e próximos posts aparecem quando os módulos de Conteúdo e Tarefas existirem.')).toBeTruthy();
    const progress = screen.getByRole('progressbar') as HTMLProgressElement;
    expect(progress.value).toBe(5);
    expect(progress.max).toBe(7);
  });

  it('writes "1 pessoa com acesso" for a single member', async () => {
    const { impl } = makeFetch({ client: () => json(academia) });
    renderClientDetail(impl, clientUrl(OTHER_CLIENT_ID));

    expect(await screen.findByText('1 pessoa com acesso')).toBeTruthy();
    expect(screen.queryByText('0 pessoas com acesso')).toBeNull();
  });

  it('gives every tab its own URL and keeps the tab on a reload', async () => {
    const { impl } = makeFetch();
    const { probe } = renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });

    for (const [label, slug] of [['Conteúdos', 'conteudos'], ['Tarefas', 'tarefas'], ['Estudo de marca', 'estudo-de-marca'], ['Relatórios', 'relatorios'], ['Acessos', 'acessos']] as const) {
      fireEvent.click(screen.getByRole('link', { name: label }));
      expect(await screen.findByRole('heading', { name: label })).toBeTruthy();
      expect(probe.pathname).toBe(clientUrl(CLIENT_ID, slug));
      expect(screen.getByRole('link', { name: label }).getAttribute('aria-current')).toBe('page');
    }

    // A reload into the Tarefas address lands on Tarefas, not on Geral.
    cleanup();
    const second = makeFetch();
    renderClientDetail(second.impl, clientUrl(CLIENT_ID, 'tarefas'));
    expect(await screen.findByRole('heading', { name: 'Tarefas' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tarefas' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('heading', { name: 'Cadastro' })).toBeNull();
  });

  it('redirects the bare client address to Geral', async () => {
    const { impl } = makeFetch();
    const { probe } = renderClientDetail(impl, `/agencia/${AGENCY_A}/clientes/${CLIENT_ID}`);

    expect(await screen.findByRole('heading', { name: 'Padaria Central' })).toBeTruthy();
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
  });

  it('leads every General block to its tab with a click, and the back link to the wallet', async () => {
    const { impl } = makeFetch();
    const { container, probe } = renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });

    const general = container.querySelector<HTMLElement>('.client-general');
    if (general === null) throw new Error('The General tab was not rendered.');
    expect(screen.getByRole('link', { name: '← Clientes' }).getAttribute('href')).toBe(`/agencia/${AGENCY_A}/clientes`);
    const brandLink = within(general).getByRole('link', { name: /Estudo de marca/ });
    const conversationsLink = within(general).getByRole('link', { name: /Conversas/ });
    const portalLink = within(general).getByRole('link', { name: /Portal/ });
    expect(brandLink.getAttribute('href')).toBe(clientUrl(CLIENT_ID, 'estudo-de-marca'));
    expect(conversationsLink.getAttribute('href')).toBe(clientUrl(CLIENT_ID, 'estudo-de-marca'));
    expect(portalLink.getAttribute('href')).toBe(clientUrl(CLIENT_ID, 'acessos'));

    fireEvent.click(brandLink);
    expect(await screen.findByRole('heading', { name: 'Estudo de marca' })).toBeTruthy();
    expect(probe.pathname).toBe(clientUrl(CLIENT_ID, 'estudo-de-marca'));
  });

  it('writes "Não informado" for every empty registration field instead of hiding it', async () => {
    const { impl } = makeFetch({ client: () => json(drainedClient) });
    renderClientDetail(impl);

    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getAllByText('Não informado')).toHaveLength(7);
    expect(screen.queryByText('@padariacentral')).toBeNull();
  });

  it('shows Editar only for cliente.operar on an active client, and opens the edit modal', async () => {
    const reader = makeFetch({ permissions: READER_PERMISSIONS });
    renderClientDetail(reader.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    cleanup();

    const manager = makeFetch({ permissions: MANAGER_PERMISSIONS });
    renderClientDetail(manager.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(await openEditDialog()).toBeTruthy();
  });

  it('shows the closing actions only for cliente.arquivar', async () => {
    const reader = makeFetch({ permissions: READER_PERMISSIONS });
    renderClientDetail(reader.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: 'Ações de encerramento' })).toBeNull();
    cleanup();

    const manager = makeFetch({ permissions: MANAGER_PERMISSIONS });
    renderClientDetail(manager.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: 'Ações de encerramento' })).toBeNull();
    cleanup();

    const admin = makeFetch();
    renderClientDetail(admin.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    // #139 has not landed: the control is visibly inert, never a menu that does nothing.
    expect(screen.getByRole('button', { name: 'Ações de encerramento' }).hasAttribute('disabled')).toBe(true);
  });

  it('never shows Editar on an archived client, and offers Reativar only to cliente.arquivar', async () => {
    const admin = makeFetch({ client: () => json(archivedClient) });
    renderClientDetail(admin.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByText('Arquivado')).toBeTruthy();
    expect(screen.getByText('Cliente arquivado em 04/10')).toBeTruthy();
    expect(screen.queryByText(/encerra em/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ações de encerramento' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeTruthy();
    cleanup();

    const manager = makeFetch({ permissions: MANAGER_PERMISSIONS, client: () => json(archivedClient) });
    renderClientDetail(manager.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByText('Cliente arquivado em 04/10')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reativar' })).toBeNull();
  });

  it('shows the Acessos tab only with cliente.convidar_usuario, and the typed URL is not found without it', async () => {
    const admin = makeFetch();
    const { probe } = renderClientDetail(admin.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    fireEvent.click(screen.getByRole('link', { name: 'Acessos' }));
    expect(await screen.findByRole('heading', { name: 'Acessos' })).toBeTruthy();
    expect(probe.pathname).toBe(clientUrl(CLIENT_ID, 'acessos'));
    cleanup();

    const manager = makeFetch({ permissions: MANAGER_PERMISSIONS });
    const managerRender = renderClientDetail(manager.impl, clientUrl(CLIENT_ID, 'acessos'));
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Acessos' })).toBeNull();
    expect(managerRender.container.textContent).not.toContain('Padaria Central');
    cleanup();

    const reader = makeFetch({ permissions: READER_PERMISSIONS });
    renderClientDetail(reader.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('link', { name: 'Acessos' })).toBeNull();
  });

  it('keeps the Portal block as text when the person cannot see the Acessos tab', async () => {
    const { impl } = makeFetch({ permissions: MANAGER_PERMISSIONS });
    renderClientDetail(impl);

    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByText('3 pessoas com acesso')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Portal/ })).toBeNull();
  });

  it.each(['conteudos', 'tarefas', 'relatorios', 'estudo-de-marca', 'acessos'])('draws %s as a name and one sentence, with no extra control', async (tab) => {
    const { impl } = makeFetch();
    const { container } = renderClientDetail(impl, clientUrl(CLIENT_ID, tab));

    await screen.findByRole('heading', { name: 'Padaria Central' });
    const panel = tabPanel(container);
    expect(within(panel).queryByRole('button')).toBeNull();
    expect(within(panel).queryByRole('link')).toBeNull();
    expect(within(panel).queryByRole('textbox')).toBeNull();
  });

  it('renders a website as a safe external link, and a hostile value as text', async () => {
    const { impl } = makeFetch();
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const site = screen.getByRole('link', { name: 'https://padaria.example.test' });
    expect(site.getAttribute('target')).toBe('_blank');
    expect(site.getAttribute('rel')).toBe('noopener noreferrer');
    cleanup();

    const hostile = makeFetch({ client: () => json({ ...padaria, website: 'javascript:alert(1)' }) });
    const rendered = renderClientDetail(hostile.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByText('javascript:alert(1)')).toBeTruthy();
    expect(rendered.container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('draws header and panel skeletons on the first load', async () => {
    const { impl } = makeFetch({ client: () => new Promise<Response>(() => undefined) });
    const { container } = renderClientDetail(impl);

    await screen.findByRole('link', { name: '← Clientes' });
    expect(container.querySelectorAll('.client-detail .ui-skeleton').length).toBeGreaterThanOrEqual(5);
  });

  it('offers a retry when the detail fails, without echoing the API message', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      client: () => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500)
          : json(padaria);
      }
    });
    renderClientDetail(impl);

    const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível carregar o cliente.');
    expect(alert.textContent).not.toContain('private diagnostic');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('heading', { name: 'Padaria Central' })).toBeTruthy();
  });

  it.each([403, 404])('answers %i as the same not-found, without revealing the client', async (status) => {
    const { impl, calls } = makeFetch({
      client: () => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'sensitive detail' } }, status)
    });
    renderClientDetail(impl);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.queryByText('Padaria Central')).toBeNull();
    expect(screen.queryByText('sensitive detail')).toBeNull();
    expect(calls.filter((call) => call.includes('/clients/'))).toHaveLength(1);
  });

  it.each(['not-a-uuid', '..%2Fme', 'x?tab=acessos'])('refuses the malformed client id %s without a request', async (id) => {
    const { impl, calls } = makeFetch();
    renderClientDetail(impl, `/agencia/${AGENCY_A}/clientes/${encodeURIComponent(id)}/geral`);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(calls.some((call) => call.includes('/clients/'))).toBe(false);
  });

  it('never renders a client returned for another id', async () => {
    const { impl } = makeFetch({ client: () => json(academia) });
    renderClientDetail(impl);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível carregar o cliente.');
    expect(screen.queryByText('Academia Corpo')).toBeNull();
  });

  it('renders hostile registration fields as text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { impl } = makeFetch({ client: () => json({ ...padaria, name: hostile, legalName: hostile, segment: hostile, contactName: hostile }) });
    const rendered = renderClientDetail(impl);

    await screen.findByRole('heading', { name: hostile });
    expect(within(rendered.container).getAllByText(hostile).length).toBeGreaterThanOrEqual(4);
    expect(rendered.container.querySelector('img')).toBeNull();
    expect(rendered.container.querySelector('[onerror]')).toBeNull();
  });

  it('never shows one agency\'s client under another with the same cache', async () => {
    // The same id exists in both agencies; only the agency id in the cache key keeps them apart:
    // under agency B the request is new (its own key) and the API answers 404.
    const { impl } = makeFetch({ client: (_clientId, agencyId) =>
      agencyId === AGENCY_B ? json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404) : json(padaria) });
    const { probe } = renderClientDetail(impl);

    await screen.findByRole('heading', { name: 'Padaria Central' });
    await act(async () => { probe.navigate(`/agencia/${AGENCY_B}/clientes/${CLIENT_ID}/geral`); });

    await screen.findByRole('heading', { name: 'Page not found' });
    expect(screen.queryByText('Padaria Central')).toBeNull();
  });
});

describe('edit client modal (#137)', () => {
  it('opens with every registration field prefilled, grouped by the section 3 order', async () => {
    const { impl } = makeFetch();
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    expect(within(dialog).getByRole('heading', { name: 'Cliente' })).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Empresa' })).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Contato do dono' })).toBeTruthy();
    expect(editNameInput(dialog).value).toBe('Padaria Central');
    expect(editInstagramInput(dialog).value).toBe('padariacentral');
    expect(editTaxIdInput(dialog).value).toBe('12345678000190');
    expect(editWebsiteInput(dialog).value).toBe('https://padaria.example.test');
    expect(editContactEmailInput(dialog).value).toBe('maria@padaria.example.test');
    // The portal note sits with the contact fields (acceptance of #137).
    expect(within(groupOf(dialog, 'Contato do dono')).getByText('Este é o contato da empresa. Quem entra no portal é definido na aba Acessos.')).toBeTruthy();
    // No photo yet: initials; and no removal offer for a photo that does not exist.
    expect(within(dialog).getByText('PC')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Remover' })).toBeNull();
  });

  it('stays disabled until something changes, and sends only the changed fields', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({ patch: (body) => { bodies.push(body); return json(registrationOf(padaria)); } });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    const submit = within(dialog).getByRole('button', { name: 'Salvar' });
    expect(submit.hasAttribute('disabled')).toBe(true);

    // Instagram was typed with the @: it travels without it (the column stores it without).
    fireEvent.change(editInstagramInput(dialog), { target: { value: '@novo_handle' } });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(bodies).toEqual([{ instagramHandle: 'novo_handle' }]));
    expect(bodies[0]).not.toHaveProperty('name');

    // Only the name changes now: the body carries it alone.
    fireEvent.change(editNameInput(dialog), { target: { value: 'Padaria Renovada' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ name: 'Padaria Renovada' });
  });

  it('sends null when a field is cleared, and the CNPJ/CPF mask is stripped', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({ patch: (body) => { bodies.push(body); return json(registrationOf(padaria)); } });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    fireEvent.change(editInstagramInput(dialog), { target: { value: '' } });
    fireEvent.change(editTaxIdInput(dialog), { target: { value: '98.765.432/0001-10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toEqual([{ instagramHandle: null, taxId: '98765432000110' }]));
  });

  it('refuses an empty name on the field, sending nothing', async () => {
    const { impl, calls } = makeFetch();
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    const name = editNameInput(dialog);

    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Informe o nome do cliente.')).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(calls.some((call) => call.startsWith('PATCH'))).toBe(false);
  });

  it('shows the name-in-use message on the name field on a 409, keeping the typed value', async () => {
    const { impl } = makeFetch({ patch: () => json({ error: { code: 'CLIENT_NAME_IN_USE', message: 'private diagnostic' } }, 409) });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    const name = editNameInput(dialog);

    fireEvent.change(name, { target: { value: 'Padaria Dois Irmãos' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    const error = await within(dialog).findByText('Já existe um cliente ativo com este nome.');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(error.getAttribute('id')).toBe(`${name.getAttribute('aria-describedby')}`);
    expect(name.value).toBe('Padaria Dois Irmãos');
    expect(dialog.textContent).not.toContain('private diagnostic');
    expect(screen.getByRole('dialog', { name: 'Editar cliente' })).toBe(dialog);
  });

  it('marks the refused field on a 400 with its message, keeping everything else', async () => {
    const { impl } = makeFetch({
      patch: () => json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'validation failed',
          details: { issues: [{ path: 'taxId', code: 'custom', message: 'private issue message' }] }
        }
      }, 400)
    });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    const taxId = editTaxIdInput(dialog);

    fireEvent.change(taxId, { target: { value: '123' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('CNPJ ou CPF deve ter 11 ou 14 dígitos.')).toBeTruthy();
    expect(taxId.getAttribute('aria-invalid')).toBe('true');
    expect(taxId.value).toBe('123');
    expect(dialog.textContent).not.toContain('private');
  });

  it('keeps a server error inside the modal with the typed value, and allows trying again', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      patch: (body) => {
        attempts += 1;
        if (attempts === 1) return json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500);
        const name = (body as { name: string }).name;
        return json({ ...registrationOf(padaria), name });
      }
    });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    const name = editNameInput(dialog);
    fireEvent.change(name, { target: { value: 'Padaria Renovada' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível salvar o cliente. Tente de novo.');
    expect(dialog.textContent).not.toContain('private diagnostic');
    expect(name.value).toBe('Padaria Renovada');
    expect(screen.getByRole('dialog', { name: 'Editar cliente' })).toBe(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(within(dialog).queryByText('Não foi possível salvar o cliente. Tente de novo.')).toBeNull();
  });

  it('shows the new name in the header and in the roster without a reload (SPEC §6 invalidation)', async () => {
    let current = padaria;
    const { impl } = makeFetch({
      client: () => json(current),
      clients: () => json({ data: [listItemOf(current)], meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 } }),
      patch: (body) => {
        current = { ...current, name: (body as { name: string }).name };
        return json(registrationOf(current));
      }
    });
    const { probe } = renderClientDetail(impl, `/agencia/${AGENCY_A}/clientes`);
    await screen.findByText('Padaria Central');

    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
    const dialog = await openEditDialog();

    fireEvent.change(editNameInput(dialog), { target: { value: 'Padaria Renovada' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(current.name).toBe('Padaria Renovada'));

    // The header behind the modal reads the same cache: no reload needed.
    expect(await screen.findByRole('heading', { name: 'Padaria Renovada' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Fechar edição do cliente' }));
    fireEvent.click(screen.getByRole('link', { name: '← Clientes' }));
    // The roster was invalidated; without it, the cached "Padaria Central" would stay.
    expect(await screen.findByText('Padaria Renovada')).toBeTruthy();
    expect(screen.queryByText('Padaria Central')).toBeNull();
  });

  it('refuses a photo of the wrong type with a message, without touching the current photo', async () => {
    const { impl, calls } = makeFetch();
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    fireEvent.change(modalFileInput(dialog), {
      target: { files: [new File(['<html>'], 'pagina.html', { type: 'text/html' })] }
    });
    expect(await within(dialog).findByText('Formato não aceito. Envie uma foto PNG, JPEG, GIF ou WebP.')).toBeTruthy();
    expect(calls.some((call) => call.startsWith('PUT'))).toBe(false);
    expect(within(dialog).queryByText('PC')).toBeTruthy();
    expect(dialog.querySelector('img')).toBeNull();
  });

  it('refuses a photo above the size ceiling with a message, without touching the current photo', async () => {
    const { impl, calls } = makeFetch();
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    fireEvent.change(modalFileInput(dialog), {
      target: { files: [new File([new Uint8Array(PROFILE_PHOTO_MAX_BYTES + 1)], 'grande.png', { type: 'image/png' })] }
    });
    expect(await within(dialog).findByText('A foto passa do tamanho máximo aceito.')).toBeTruthy();
    expect(calls.some((call) => call.startsWith('PUT'))).toBe(false);
  });

  it('uploads a valid photo with its own state, independent of Salvar', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const photoBodies: unknown[] = [];
    let current = padaria;
    let resolveUpload: ((response: Response) => void) | undefined;
    const pendingUpload = new Promise<Response>((resolve) => { resolveUpload = resolve; });
    const { impl } = makeFetch({
      client: () => json(current),
      putPhoto: (body) => {
        photoBodies.push(body);
        current = { ...current, photoUrl: 'https://storage.test/nova.png' };
        return pendingUpload;
      }
    });
    const { container } = renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    const upload = within(dialog).getByRole('button', { name: 'Trocar foto' });

    // Salvar is enabled by a pending edit; the photo state must not disable it.
    fireEvent.change(editInstagramInput(dialog), { target: { value: '@novo_handle' } });
    expect(within(dialog).getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(false);

    fireEvent.change(modalFileInput(dialog), {
      target: { files: [new File([pngBytes], 'foto.png', { type: 'image/png' })] }
    });
    await waitFor(() => expect(photoBodies).toEqual([{ imageBase64: Buffer.from(pngBytes).toString('base64') }]), { timeout: 5000 });
    expect(await within(dialog).findByText('Enviando foto…')).toBeTruthy();
    // Only the photo control is busy; the registration controls stay free (issue #137).
    expect(upload.hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'Salvar' }).hasAttribute('disabled')).toBe(false);

    await act(async () => { resolveUpload?.(json({ photoUrl: 'https://storage.test/nova.png' })); });
    await waitFor(() => expect(dialog.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/nova.png'));
    // The header behind the modal shows the new photo, and Remover becomes available.
    await waitFor(() => expect(container.querySelector('.client-detail__header img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/nova.png'));
    expect(within(dialog).getByRole('button', { name: 'Remover' })).toBeTruthy();
  });

  it('removes the photo, showing the initials again', async () => {
    let current = withPhoto;
    const { impl, calls } = makeFetch({
      client: () => json(current),
      deletePhoto: (): Response => { current = { ...current, photoUrl: null }; return noContent(); }
    });
    const { container } = renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    expect(dialog.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/padaria.png');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }));

    await waitFor(() => expect(calls).toContain(`DELETE /agencies/${AGENCY_A}/clients/${CLIENT_ID}/photo`));
    await waitFor(() => expect(within(dialog).getByText('PC')).toBeTruthy());
    expect(within(dialog).queryByRole('button', { name: 'Remover' })).toBeNull();
    // The header behind the modal loses the photo too, after the invalidated detail answers.
    await waitFor(() => expect(container.querySelector('.client-detail__header img')).toBeNull());
  });

  it('opens the modal only for cliente.operar, never for an archived client', async () => {
    const manager = makeFetch({ permissions: MANAGER_PERMISSIONS, client: () => json(archivedClient) });
    renderClientDetail(manager.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();

    const reader = makeFetch({ permissions: READER_PERMISSIONS });
    renderClientDetail(reader.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();

    const admin = makeFetch({ client: () => json(archivedClient) });
    renderClientDetail(admin.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('formatDayMonth (#136)', () => {
  it.each([
    ['2026-10-30', '30/10'],
    ['2026-10-04T12:00:00.000Z', '04/10'],
    ['2026-01-01', '01/01']
  ])('labels %s as %s, in any timezone', (value, expected) => {
    expect(formatDayMonth(value)).toBe(expected);
  });
});