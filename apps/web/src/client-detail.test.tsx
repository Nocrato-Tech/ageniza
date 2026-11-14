// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PROFILE_PHOTO_MAX_BYTES } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { formatArchivedDay, formatDayMonth } from './client-detail.js';
import { clientRegistrationExtras } from './client-registration-fixture.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { useCommittedLocation } from './location-probe-fixture.js';

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
  agencyId, agencyName: agencyId === AGENCY_B ? 'Agência Dois' : 'Agência Um', isOwner: false, membershipId: null, role: { key: 'admin', name: 'Admin' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions
});

/** Every permission of the module: Admin and Owner see everything (specs/clientes.md §2). */
const ADMIN_PERMISSIONS = ['cliente.visualizar', 'cliente.operar', 'cliente.cadastrar', 'cliente.arquivar', 'cliente.convidar_usuario', 'cliente.remover_usuario', 'conteudo.visualizar'];
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
  ...clientRegistrationExtras,
  city: 'São Paulo',
  summary: {
    brandStudyFilled: 5, threadsAwaitingAgency: 2, threadsAnsweredByAgency: 1, activePortalMembers: 3,
    contentsThisMonth: 16, mediaFiles: 171, mediaFolders: 5,
    workers: [{ membershipId: 'ffffffff-0000-4000-8000-000000000001', name: 'Marina Bastos', photoUrl: null }, { membershipId: 'ffffffff-0000-4000-8000-000000000002', name: 'João Pedro Alves', photoUrl: null }],
    workersMore: 2
  }
};
const academia = {
  ...padaria,
  id: OTHER_CLIENT_ID,
  name: 'Academia Corpo',
  instagramHandle: 'academiacorpo',
  website: null,
  city: null,
  summary: { brandStudyFilled: 1, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 1, contentsThisMonth: 3, mediaFiles: 12, mediaFolders: 2, workers: [], workersMore: 0 }
};
/** The API clears `closingDate` on archiving; the fixture still carries one on purpose, so the
 *  "encerra em" badge can be proven dead on an archived client (mutation survived otherwise). */
const archivedClient = {
  ...padaria,
  status: 'archived',
  closingDate: '2026-10-30',
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

const registrationKeys = new Set(['summary', 'legalName', 'taxId', 'segment', 'city', 'website', 'contactName', 'contactPhone', 'contactEmail', 'archivedAt', 'createdAt']);

const listItemOf = (client: Record<string, unknown>): Record<string, unknown> => ({
  ...Object.fromEntries(Object.entries(client).filter(([key]) => !registrationKeys.has(key))),
  threadsAwaitingAgency: 2,
  pendingInvitations: 0
});

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Scenario {
  readonly authenticated?: boolean;
  readonly permissions?: readonly string[];
  readonly client?: (clientId: string, agencyId: string) => Response | Promise<Response>;
  readonly clients?: () => Response | Promise<Response>;
  readonly patch?: (body: unknown) => Response | Promise<Response>;
  readonly putPhoto?: (body: unknown) => Response | Promise<Response>;
  readonly deletePhoto?: () => Response | Promise<Response>;
  readonly brandStudy?: () => Response | Promise<Response>;
  readonly contents?: (url: URL) => Response | Promise<Response>;
  readonly comments?: (threadId: string, method: string) => Response | Promise<Response>;
  readonly threads?: (method: string, url: URL, body: unknown) => Response | Promise<Response>;
  readonly members?: () => Response | Promise<Response>;
  readonly clientInvitations?: () => Response | Promise<Response>;
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
    // The two content tabs of #138/#140 read their own endpoints; the tests here only need them
    // to answer so the tab renders.
    const brandStudy = /\/agencies\/([^/]+)\/clients\/([^/]+)\/brand-study$/.exec(path);
    if (brandStudy !== null) return scenario.brandStudy?.() ?? json({ filled: 5, sections: [], personas: [] });
    // The Conteúdos tab renders the view of the client (#272, tested with its own fake in contents.test.tsx); here it only answers empty.
    if (/\/agencies\/[^/]+\/clients\/[^/]+\/contents$/.test(path)) {
      if (scenario.contents !== undefined) return scenario.contents(url);
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      return json({ data: { contents: [], storyScripts: [] }, meta: { from, to, count: 0 } });
    }
    const comments = /\/agencies\/[^/]+\/clients\/[^/]+\/threads\/([^/]+)\/comments$/.exec(path);
    if (comments !== null) return scenario.comments?.(comments[1]!, method) ?? json({ data: [], meta: { page: 1, pageSize: 50, totalItems: 0, totalPages: 1 } });
    // The Geral tab lists the requests for material of the client; here it answers empty unless the scenario says otherwise.
    if (/\/agencies\/[^/]+\/clients\/[^/]+\/threads$/.test(path)) {
      return scenario.threads?.(method, url, init?.body === undefined ? undefined : JSON.parse(String(init.body)))
        ?? json({ data: [], meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } });
    }
    const members = /\/agencies\/([^/]+)\/clients\/([^/]+)\/members$/.exec(path);
    if (members !== null) return scenario.members?.() ?? json({ data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
    const clientInvitations = /\/agencies\/([^/]+)\/clients\/([^/]+)\/invitations$/.exec(path);
    if (clientInvitations !== null) return scenario.clientInvitations?.() ?? json({ data: [], meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 } });
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
  state: unknown;
  navigate: NavigateFunction;
}

function Probe({ probe }: { probe: ProbeTarget }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.state = location.state;
    probe.navigate = navigate;
  });
  return null;
}

const clientUrl = (clientId = CLIENT_ID, tab = 'geral') => `/agencia/${AGENCY_A}/clientes/${clientId}/${tab}`;

const renderClientDetail = (impl: typeof fetch, entry: string | { pathname: string; state?: unknown } = clientUrl()) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: ProbeTarget = { pathname: '', search: '', state: undefined, navigate: () => undefined };
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

/** The trail link back to the roster, the way back of every tab. */
const rosterLink = (): HTMLElement => within(screen.getByRole('navigation', { name: 'Você está em' })).getByRole('link', { name: 'Clientes' });

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
const editLegalNameInput = (dialog: HTMLElement): HTMLInputElement =>
  within(groupOf(dialog, 'Empresa')).getByRole('textbox', { name: 'Razão social' }) as HTMLInputElement;
const editTaxIdInput = (dialog: HTMLElement): HTMLInputElement =>
  within(groupOf(dialog, 'Empresa')).getByRole('textbox', { name: 'CNPJ ou CPF' }) as HTMLInputElement;
const editWebsiteInput = (dialog: HTMLElement): HTMLInputElement =>
  within(groupOf(dialog, 'Empresa')).getByRole('textbox', { name: 'Site' }) as HTMLInputElement;
const editContactEmailInput = (dialog: HTMLElement): HTMLInputElement =>
  within(groupOf(dialog, 'Contato do dono')).getByRole('textbox', { name: 'E-mail' }) as HTMLInputElement;
const modalFileInput = (dialog: HTMLElement): HTMLInputElement =>
  dialog.querySelector('input[type="file"]') as HTMLInputElement;

describe('client detail (#136)', () => {
  const crumbs = (): HTMLElement => screen.getByRole('navigation', { name: 'Você está em' });
  const tabsNav = (): HTMLElement => screen.getByRole('navigation', { name: 'Seções do cliente' });
  const tabLink = (label: RegExp | string): HTMLElement => within(tabsNav()).getByRole('link', { name: label });
  const blockOf = (container: HTMLElement, name: RegExp): HTMLElement => {
    const general = container.querySelector<HTMLElement>('.client-general');
    if (general === null) throw new Error('The Visão geral was not rendered.');
    return within(general).getByRole('link', { name });
  };

  it('renders the header of the board: trail, name, state, @ and city, closing day and who works on the client', async () => {
    const { impl } = makeFetch();
    renderClientDetail(impl);

    expect(await screen.findByRole('heading', { name: 'Padaria Central' })).toBeTruthy();
    expect(within(crumbs()).getByRole('link', { name: 'Clientes' }).getAttribute('href')).toBe(`/agencia/${AGENCY_A}/clientes`);
    expect(within(crumbs()).getByText('Padaria Central').getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('@padariacentral · São Paulo')).toBeTruthy();
    expect(screen.getByText('Ativo')).toBeTruthy();
    expect(screen.getByText('encerra em 30/10')).toBeTruthy();
    expect(screen.getByText('PC')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Quem trabalha neste cliente: Marina Bastos, João Pedro Alves' })).toBeTruthy();
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.queryByText('Saúde do cliente')).toBeNull();
  });

  it('renders the four blocks of the board with the figures of the summary, and the registration with its own Editar and its note', async () => {
    const { impl } = makeFetch();
    const { container } = renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });

    const study = blockOf(container, /Estudo de marca/);
    expect(study.textContent).toBe('Estudo de marca5 de 7seções preenchidasVer o estudo');
    const progress = within(study).getByRole('progressbar') as HTMLProgressElement;
    expect(progress.value).toBe(5);
    expect(progress.max).toBe(7);
    expect(blockOf(container, /Conversas/).textContent).toBe('Conversas2aguardando a agênciaVer conversas');
    expect(blockOf(container, /Portal/).textContent).toBe('Portal3pessoas com acessoVer acessos');
    expect(blockOf(container, /Mídias/).textContent).toBe('Mídias171arquivos em 5 pastasAbrir mídias');

    const registration = screen.getByRole('heading', { name: 'Cadastro' }).closest('section') as HTMLElement;
    expect(within(registration).getByText('Padaria Central Ltda')).toBeTruthy();
    expect(within(registration).getByText('12345678000190')).toBeTruthy();
    expect(within(registration).getByText('Alimentação')).toBeTruthy();
    expect(within(registration).getByText('https://padaria.example.test')).toBeTruthy();
    expect(within(registration).getByText('Maria Souza')).toBeTruthy();
    expect(within(registration).getByText('+55 11 99999-0000')).toBeTruthy();
    expect(within(registration).getByText('maria@padaria.example.test')).toBeTruthy();
    expect(within(registration).getByText('Este é o contato da empresa. Quem entra no portal é definido na aba Acessos. Campo vazio mostra “Não informado”.')).toBeTruthy();
    expect(within(registration).getByRole('button', { name: 'Editar cadastro' }).textContent).toBe('Editar');
  });

  it('writes the singular for a single member, a single file and a single folder', async () => {
    const single = { ...academia, summary: { ...academia.summary, mediaFiles: 1, mediaFolders: 1 } };
    const { impl } = makeFetch({ client: () => json(single) });
    const { container } = renderClientDetail(impl, clientUrl(OTHER_CLIENT_ID));
    await screen.findByRole('heading', { name: 'Academia Corpo' });

    expect(blockOf(container, /Portal/).textContent).toBe('Portal1pessoa com acessoVer acessos');
    expect(blockOf(container, /Mídias/).textContent).toBe('Mídias1arquivo em 1 pastaAbrir mídias');
    expect(screen.queryByText('0 pessoas com acesso')).toBeNull();
  });

  it('draws the five tabs of the board with the count each one reads from the API, and no Tarefas or Relatórios', async () => {
    const { impl } = makeFetch();
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });

    expect(within(tabsNav()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Visão geral', 'Conteúdos16', 'Mídias171', 'Marca', 'Acessos3']);
    expect(tabLink('Visão geral').getAttribute('aria-current')).toBe('page');
    expect(within(tabsNav()).queryByRole('link', { name: /Tarefas|Relatórios|Geral$/ })).toBeNull();
    cleanup();

    // Other numbers on every tab: a count read from the wrong field would show here.
    const other = { ...academia, summary: { ...academia.summary, contentsThisMonth: 7, mediaFiles: 42, activePortalMembers: 9 } };
    renderClientDetail(makeFetch({ client: () => json(other) }).impl, clientUrl(OTHER_CLIENT_ID));
    await screen.findByRole('heading', { name: 'Academia Corpo' });
    expect(within(tabsNav()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Visão geral', 'Conteúdos7', 'Mídias42', 'Marca', 'Acessos9']);
  });

  it('shows only the tabs the person may open, and no count of one that is hidden (never a zero)', async () => {
    const manager = makeFetch({ permissions: MANAGER_PERMISSIONS });
    renderClientDetail(manager.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(within(tabsNav()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Visão geral', 'Marca']);
    cleanup();

    const withoutCounts = { ...padaria, summary: { brandStudyFilled: 5, threadsAwaitingAgency: 2, threadsAnsweredByAgency: 1, activePortalMembers: 3 } };
    const { impl } = makeFetch({ client: () => json(withoutCounts) });
    const { container } = renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(within(tabsNav()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Visão geral', 'Conteúdos', 'Mídias', 'Marca', 'Acessos3']);
    expect(container.querySelector('.client-general__block--sky')).toBeNull();
    expect(screen.queryByRole('img', { name: /Quem trabalha/ })).toBeNull();
  });

  it('has a button in the header that opens the calendar of the client with the roster address kept, as the primary of the block', async () => {
    const roster = `/agencia/${AGENCY_A}/clientes?search=padaria&page=2`;
    const { impl } = makeFetch();
    const { probe } = renderClientDetail(impl, { pathname: clientUrl(), state: { clientListUrl: roster } });
    await screen.findByRole('heading', { name: 'Padaria Central' });

    const button = screen.getByRole('link', { name: 'Abrir no Calendário Editorial' });
    expect(button.getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos/${CLIENT_ID}`);
    expect(button.classList.contains('ui-button--primary')).toBe(true);
    expect(within(tabsNav()).queryByRole('link', { name: 'Calendário Editorial' })).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/conteudos/${CLIENT_ID}`));
    // The way back to the roster the person came from travels with the button.
    expect(probe.state).toEqual({ clientListUrl: roster });
  });

  it('shows the button for an archived client too (as a secondary: Reativar is its primary), and hides it without conteudo.visualizar', async () => {
    const archived = makeFetch({ client: () => json(archivedClient) });
    renderClientDetail(archived.impl);
    expect((await screen.findByRole('link', { name: 'Abrir no Calendário Editorial' })).classList.contains('ui-button--secondary')).toBe(true);
    cleanup();

    const reader = makeFetch({ permissions: READER_PERMISSIONS });
    renderClientDetail(reader.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('link', { name: 'Abrir no Calendário Editorial' })).toBeNull();
  });

  it('gives every tab its own URL, marks the open one and keeps the tab on a reload', async () => {
    const { impl } = makeFetch();
    const { probe } = renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });

    const tabs = [
      [/^Conteúdos/, 'conteudos', 'Nenhum conteúdo em'],
      [/^Mídias/, 'midias', undefined],
      [/^Marca/, 'estudo-de-marca', 'Estudo de marca'],
      [/^Acessos/, 'acessos', 'Pessoas com acesso ao portal'],
      [/^Visão geral/, 'geral', 'Cadastro']
    ] as const;
    for (const [label, slug, content] of tabs) {
      fireEvent.click(tabLink(label));
      await waitFor(() => expect(probe.pathname).toBe(clientUrl(CLIENT_ID, slug)));
      if (slug === 'conteudos') expect(await screen.findByText(/^Nenhum conteúdo em /)).toBeTruthy();
      else if (content !== undefined) expect(await screen.findByRole('heading', { name: content })).toBeTruthy();
      expect(tabLink(label).getAttribute('aria-current')).toBe('page');
    }

    // A reload into the Marca address lands on Marca, not on the Visão geral.
    cleanup();
    renderClientDetail(makeFetch().impl, clientUrl(CLIENT_ID, 'estudo-de-marca'));
    expect(await screen.findByRole('heading', { name: 'Estudo de marca' })).toBeTruthy();
    expect(tabLink(/^Marca/).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('heading', { name: 'Cadastro' })).toBeNull();
  });

  it('carries the trail of the open tab: Clientes > name (a link back to the Visão geral) > tab', async () => {
    const { impl } = makeFetch();
    const { probe } = renderClientDetail(impl, clientUrl(CLIENT_ID, 'conteudos'));
    await screen.findByRole('heading', { name: 'Padaria Central' });

    expect(within(crumbs()).getByText('Conteúdos').getAttribute('aria-current')).toBe('page');
    const name = within(crumbs()).getByRole('link', { name: 'Padaria Central' });
    expect(name.getAttribute('href')).toBe(clientUrl(CLIENT_ID, 'geral'));
    fireEvent.click(name);
    await waitFor(() => expect(probe.pathname).toBe(clientUrl(CLIENT_ID, 'geral')));
    expect(await screen.findByRole('heading', { name: 'Cadastro' })).toBeTruthy();
  });

  it('redirects the bare client address to the Visão geral', async () => {
    const { impl } = makeFetch();
    const { probe } = renderClientDetail(impl, `/agencia/${AGENCY_A}/clientes/${CLIENT_ID}`);

    expect(await screen.findByRole('heading', { name: 'Padaria Central' })).toBeTruthy();
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
  });

  it.each(['tarefas', 'relatorios'])('sends the old /%s address to the Visão geral, with the roster address kept (the tab no longer exists)', async (slug) => {
    const roster = `/agencia/${AGENCY_A}/clientes?search=padaria`;
    const { impl } = makeFetch();
    const { probe } = renderClientDetail(impl, { pathname: clientUrl(CLIENT_ID, slug), state: { clientListUrl: roster } });

    expect(await screen.findByRole('heading', { name: 'Cadastro' })).toBeTruthy();
    expect(probe.pathname).toBe(clientUrl());
    expect(probe.state).toEqual({ clientListUrl: roster });
    expect(within(tabsNav()).queryByRole('link', { name: /Tarefas|Relatórios/ })).toBeNull();
  });

  it('leads back through the trail link Clientes, and names the link by what it says', async () => {
    const { impl } = makeFetch();
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });

    const back = within(crumbs()).getByRole('link', { name: 'Clientes' });
    expect(back.textContent).toBe('Clientes');
    expect(back.getAttribute('href')).toBe(`/agencia/${AGENCY_A}/clientes`);
  });

  it('preserves the roster search, filter and page when returning from the detail (#136, review of #379)', async () => {
    const { impl } = makeFetch({
      clients: () => json({ data: [listItemOf(padaria)], meta: { page: 2, pageSize: 20, totalItems: 21, totalPages: 2 } })
    });
    const { probe } = renderClientDetail(impl, `/agencia/${AGENCY_A}/clientes?search=padaria&status=archived&page=2`);
    await screen.findByText('Padaria Central');
    const back = (): HTMLElement => within(crumbs()).getByRole('link', { name: 'Clientes' });

    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
    expect(back().getAttribute('href')).toBe(`/agencia/${AGENCY_A}/clientes?search=padaria&status=archived&page=2`);

    // A tab click inside the detail must not drop the roster address (review of #379 r2).
    fireEvent.click(await within(await screen.findByRole('navigation', { name: 'Seções do cliente' })).findByRole('link', { name: /^Marca/ }));
    expect(await screen.findByRole('heading', { name: 'Estudo de marca' })).toBeTruthy();
    expect(back().getAttribute('href')).toBe(`/agencia/${AGENCY_A}/clientes?search=padaria&status=archived&page=2`);

    fireEvent.click(back());
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes`));
    expect(probe.search).toContain('search=padaria');
    expect(probe.search).toContain('status=archived');
    expect(probe.search).toContain('page=2');
  });

  it('keeps the roster address through the Portal block into Acessos (review of #379 r2)', async () => {
    const { impl } = makeFetch({
      clients: () => json({ data: [listItemOf(padaria)], meta: { page: 2, pageSize: 20, totalItems: 21, totalPages: 2 } })
    });
    const { container, probe } = renderClientDetail(impl, `/agencia/${AGENCY_A}/clientes?search=padaria&status=archived&page=2`);
    await screen.findByText('Padaria Central');

    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
    await screen.findByRole('heading', { name: 'Padaria Central' });
    fireEvent.click(blockOf(container, /Portal/));
    expect(await screen.findByRole('heading', { name: 'Pessoas com acesso ao portal' })).toBeTruthy();
    expect(probe.pathname).toBe(clientUrl(CLIENT_ID, 'acessos'));

    const back = within(crumbs()).getByRole('link', { name: 'Clientes' });
    expect(back.getAttribute('href')).toBe(`/agencia/${AGENCY_A}/clientes?search=padaria&status=archived&page=2`);
    fireEvent.click(back);
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes`));
    expect(probe.search).toContain('search=padaria');
    expect(probe.search).toContain('status=archived');
    expect(probe.search).toContain('page=2');
  });

  it('only restores a roster address of this agency from the navigation state (review of #379)', async () => {
    const { impl } = makeFetch();
    const { probe } = renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(within(crumbs()).getByRole('link', { name: 'Clientes' }).getAttribute('href')).toBe(`/agencia/${AGENCY_A}/clientes`);

    // A state naming another agency's roster is refused, falling back to the plain list.
    await act(async () => { probe.navigate(clientUrl(), { state: { clientListUrl: `/agencia/${AGENCY_B}/clientes?search=x` } }); });
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(within(crumbs()).getByRole('link', { name: 'Clientes' }).getAttribute('href')).toBe(`/agencia/${AGENCY_A}/clientes`);

    // A state naming this agency's roster is honored with everything it carried.
    await act(async () => { probe.navigate(clientUrl(), { state: { clientListUrl: `/agencia/${AGENCY_A}/clientes?search=padaria&status=archived&page=2` } }); });
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(within(crumbs()).getByRole('link', { name: 'Clientes' }).getAttribute('href')).toBe(`/agencia/${AGENCY_A}/clientes?search=padaria&status=archived&page=2`);
  });

  it('leads every block to its tab with a click, the roster address in the state of each link, and Mídias too', async () => {
    const roster = `/agencia/${AGENCY_A}/clientes?search=padaria`;
    const { impl } = makeFetch();
    const { container, probe } = renderClientDetail(impl, { pathname: clientUrl(), state: { clientListUrl: roster } });
    await screen.findByRole('heading', { name: 'Padaria Central' });

    expect(blockOf(container, /Estudo de marca/).getAttribute('href')).toBe(clientUrl(CLIENT_ID, 'estudo-de-marca'));
    expect(blockOf(container, /Conversas/).getAttribute('href')).toBe(clientUrl(CLIENT_ID, 'estudo-de-marca'));
    expect(blockOf(container, /Portal/).getAttribute('href')).toBe(clientUrl(CLIENT_ID, 'acessos'));
    expect(blockOf(container, /Mídias/).getAttribute('href')).toBe(clientUrl(CLIENT_ID, 'midias'));

    fireEvent.click(blockOf(container, /Estudo de marca/));
    expect(await screen.findByRole('heading', { name: 'Estudo de marca' })).toBeTruthy();
    expect(probe.pathname).toBe(clientUrl(CLIENT_ID, 'estudo-de-marca'));
    expect(probe.state).toEqual({ clientListUrl: roster });

    // The browser back between tabs returns to the Visão geral.
    await act(async () => { probe.navigate(-1); });
    expect(await screen.findByRole('heading', { name: 'Cadastro' })).toBeTruthy();
    expect(probe.pathname).toBe(clientUrl(CLIENT_ID, 'geral'));

    fireEvent.click(blockOf(container, /Conversas/));
    expect(await screen.findByRole('heading', { name: 'Estudo de marca' })).toBeTruthy();
    expect(probe.pathname).toBe(clientUrl(CLIENT_ID, 'estudo-de-marca'));
    await act(async () => { probe.navigate(-1); });
    expect(await screen.findByRole('heading', { name: 'Cadastro' })).toBeTruthy();

    fireEvent.click(blockOf(container, /Portal/));
    expect(await screen.findByRole('heading', { name: 'Pessoas com acesso ao portal' })).toBeTruthy();
    expect(probe.pathname).toBe(clientUrl(CLIENT_ID, 'acessos'));
    expect(probe.state).toEqual({ clientListUrl: roster });
    await act(async () => { probe.navigate(-1); });
    expect(await screen.findByRole('heading', { name: 'Cadastro' })).toBeTruthy();

    fireEvent.click(blockOf(container, /Mídias/));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl(CLIENT_ID, 'midias')));
    expect(probe.state).toEqual({ clientListUrl: roster });
  });

  it('draws the meta line of the other tabs as the board does: segment, city and "cliente desde" (month of the registration in São Paulo)', async () => {
    // 01:30Z of 1 September is still August in São Paulo.
    const { impl } = makeFetch({ client: () => json({ ...padaria, createdAt: '2026-09-01T01:30:00.000Z' }) });
    renderClientDetail(impl, clientUrl(CLIENT_ID, 'estudo-de-marca'));
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByText('Alimentação · São Paulo · cliente desde agosto de 2026')).toBeTruthy();
  });

  it('says the Acessos meta as the board does', async () => {
    renderClientDetail(makeFetch().impl, clientUrl(CLIENT_ID, 'acessos'));
    await screen.findByRole('heading', { name: 'Pessoas com acesso ao portal' });
    expect(screen.getByText('Padaria Central · quem aprova os posts, sem criar conta')).toBeTruthy();
  });

  describe('Pedidos de material on the Visão geral (decisions 2026-11-10 and 2026-11-11)', () => {
    const THREAD_ID = 'cccccccc-1111-4111-8111-111111111111';
    const SECOND_THREAD_ID = 'cccccccc-2222-4222-8222-222222222222';
    const RESOLVED_THREAD_ID = 'cccccccc-3333-4333-8333-333333333333';
    const request = (overrides: Record<string, unknown> = {}) => ({
      id: THREAD_ID,
      subject: { materialRequest: true },
      state: 'open',
      openedBy: { name: 'Marina Bastos', side: 'agency' },
      lastComment: { side: 'agency', at: '2026-10-13T01:30:00.000Z', excerpt: 'Envie 3 fotos da equipe' },
      commentCount: 1,
      resolvedBy: null,
      resolvedAt: null,
      dueOn: '2099-12-31',
      title: 'Fotos da equipe',
      ...overrides
    });
    const listOf = (...items: Record<string, unknown>[]): Response =>
      json({ data: items, meta: { page: 1, pageSize: 100, totalItems: items.length, totalPages: 1 } });
    /** The listing asks twice, open and resolved: each answer is its own. */
    const byState = (open: Record<string, unknown>[], resolved: Record<string, unknown>[] = []) => (_method: string, url: URL): Response =>
      url.searchParams.get('state') === 'resolved' ? listOf(...resolved) : listOf(...open);
    const openOnly = (...items: Record<string, unknown>[]) => byState(items);
    const sectionOf = async (): Promise<HTMLElement> => await screen.findByRole('region', { name: 'Pedidos de material' });
    const rowOf = (section: HTMLElement, title: string): HTMLElement => within(section).getByText(title).closest('button') as HTMLElement;

    it('lists the requests as the board does: title, the last words, who it waits on, the deadline and the state, open ones first', async () => {
      const urls: string[] = [];
      const open = [
        request({ dueOn: '2000-01-01' }),
        request({ id: SECOND_THREAD_ID, title: 'Forno novo', openedBy: { name: 'Marina Bastos', side: 'agency' }, lastComment: { side: 'client', at: '2026-11-10T01:30:00.000Z', excerpt: 'Mandamos as fotos do forno novo. Serve?' }, dueOn: '2099-12-31' })
      ];
      const resolved = [request({ id: RESOLVED_THREAD_ID, title: 'Logotipo', state: 'resolved', dueOn: null, lastComment: { side: 'agency', at: '2026-10-13T01:30:00.000Z', excerpt: 'Logo em alta resolução.' }, resolvedBy: { name: 'Marina Bastos' }, resolvedAt: '2026-11-06T01:30:00.000Z' })];
      const { impl } = makeFetch({ threads: (method, url) => { urls.push(`${method} ${url.search}`); return byState(open, resolved)(method, url); } });
      renderClientDetail(impl);

      const section = await sectionOf();
      await within(section).findByText('Fotos da equipe');
      expect(within(section).getByRole('heading', { name: 'Pedidos de material' })).toBeTruthy();
      expect(within(section).getByText('3')).toBeTruthy();
      expect(within(section).getByText('2 aguardando')).toBeTruthy();
      expect(within(section).getAllByRole('button').map((button) => button.textContent)).toEqual([
        'Pedir material',
        'Fotos da equipe“Envie 3 fotos da equipe” · Aberta por Marina Bastos (agência)Entregar até 01/01 · atrasadoaberta',
        // 01:30Z of the 10th is the 9th in São Paulo.
        'Forno novo“Mandamos as fotos do forno novo. Serve?” · Cliente · 9 de novEntregar até 31/12aguardando você',
        'Logotipo“Logo em alta resolução.” · Resolvida por Marina Bastos em 5 de novresolvida'
      ]);
      expect(within(section).getByText('Abertos primeiro, depois resolvidos. Depois de enviada, a mensagem não pode ser editada nem apagada.')).toBeTruthy();
      expect(urls).toContain('GET ?materialRequest=true&state=open&pageSize=100');
      expect(urls).toContain('GET ?materialRequest=true&state=resolved&pageSize=100');
    });

    it('flags only the late one with its words, and a request opened before the title existed keeps the generic name', async () => {
      const { impl } = makeFetch({ threads: openOnly(request({ title: null, dueOn: '2000-01-01' }), request({ id: SECOND_THREAD_ID, title: 'Prazo longe', dueOn: '2099-12-31' })) });
      renderClientDetail(impl);
      const section = await sectionOf();
      await within(section).findByText('Prazo longe');

      expect(within(section).getByText('Entregar até 01/01 · atrasado')).toBeTruthy();
      expect(within(section).getByText('Entregar até 31/12')).toBeTruthy();
      expect(within(section).getByText('Pedido de material')).toBeTruthy();
      expect(section.querySelectorAll('.client-requests__due--late')).toHaveLength(1);
    });

    it('opens the thread of the row that was clicked (two rows), reading its own comments', async () => {
      const comments: string[] = [];
      const { impl } = makeFetch({
        threads: openOnly(request(), request({ id: SECOND_THREAD_ID, title: 'Forno novo', lastComment: { side: 'agency', at: '2026-10-13T01:30:00.000Z', excerpt: 'Mande as fotos do forno' } })),
        comments: (threadId, method) => { comments.push(`${method} ${threadId}`); return json({ data: [], meta: { page: 1, pageSize: 50, totalItems: 0, totalPages: 1 } }); }
      });
      renderClientDetail(impl);
      const section = await sectionOf();
      await within(section).findByText('Forno novo');

      fireEvent.click(rowOf(section, 'Forno novo'));
      const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });
      await waitFor(() => expect(comments).toEqual([`GET ${SECOND_THREAD_ID}`]));
      expect(within(dialog).getByRole('button', { name: 'Resolver' })).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar conversa' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pedido de material' })).toBeNull());

      fireEvent.click(rowOf(section, 'Fotos da equipe'));
      await screen.findByRole('dialog', { name: 'Pedido de material' });
      await waitFor(() => expect(comments).toEqual([`GET ${SECOND_THREAD_ID}`, `GET ${THREAD_ID}`]));
    });

    it('opens the request named in ?pedido= (a notification), reading its own comments and not the other row', async () => {
      const comments: string[] = [];
      const { impl } = makeFetch({
        threads: openOnly(request(), request({ id: SECOND_THREAD_ID, title: 'Forno novo' })),
        comments: (threadId, method) => { comments.push(`${method} ${threadId}`); return json({ data: [], meta: { page: 1, pageSize: 50, totalItems: 0, totalPages: 1 } }); }
      });
      renderClientDetail(impl, `${clientUrl()}?pedido=${SECOND_THREAD_ID}`);

      const dialog = await screen.findByRole('dialog', { name: 'Pedido de material' });
      expect(within(dialog).getByRole('button', { name: 'Resolver' })).toBeTruthy();
      await waitFor(() => expect(comments).toEqual([`GET ${SECOND_THREAD_ID}`]));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar conversa' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pedido de material' })).toBeNull());
    });

    it('opens the page as usual when ?pedido= names a request that does not exist', async () => {
      const { impl } = makeFetch({ threads: openOnly(request()) });
      renderClientDetail(impl, `${clientUrl()}?pedido=${SECOND_THREAD_ID}`);
      const section = await sectionOf();
      await within(section).findByText('Fotos da equipe');

      expect(screen.queryByRole('dialog', { name: 'Pedido de material' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('says there is no request, and a failed read with Tentar de novo that reads again, never the empty text', async () => {
      const empty = makeFetch();
      renderClientDetail(empty.impl);
      expect(await within(await sectionOf()).findByText('Nenhum pedido de material')).toBeTruthy();
      cleanup();

      let failing = true;
      const { impl } = makeFetch({ threads: (method, url) => failing ? json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500) : openOnly(request())(method, url) });
      renderClientDetail(impl);
      const section = await sectionOf();
      const alert = await within(section).findByRole('alert', undefined, { timeout: 5000 });
      expect(alert.textContent).toContain('Não foi possível carregar os pedidos de material.');
      expect(alert.textContent).not.toContain('private diagnostic');
      expect(within(section).queryByText('Nenhum pedido de material')).toBeNull();
      failing = false;
      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await within(section).findByText('Fotos da equipe')).toBeTruthy();
      expect(within(section).queryByRole('alert')).toBeNull();
    });

    it('shows a loading shape on the first read, with no "Pedir material" yet', async () => {
      const { impl } = makeFetch({ threads: () => new Promise<Response>(() => undefined) });
      const { container } = renderClientDetail(impl);
      const section = await sectionOf();
      expect(section.querySelector('.client-requests__skeleton')?.getAttribute('aria-busy')).toBe('true');
      expect(container.querySelectorAll('.client-requests__skeleton .ui-skeleton')).toHaveLength(2);
      expect(within(section).queryByRole('button', { name: 'Pedir material' })).toBeNull();
      expect(within(section).queryByText('Nenhum pedido de material')).toBeNull();
    });

    it.each([
      ['an admin', ADMIN_PERMISSIONS, true],
      ['a manager', MANAGER_PERMISSIONS, true],
      ['a reader, who only has cliente.visualizar', READER_PERMISSIONS, false]
    ])('shows "Pedir material" to %s only with cliente.operar', async (_who, permissions, sees) => {
      const { impl } = makeFetch({ permissions, threads: openOnly(request()) });
      renderClientDetail(impl);
      const section = await sectionOf();
      await within(section).findByText('Fotos da equipe');
      expect(within(section).queryByRole('button', { name: 'Pedir material' }) !== null).toBe(sees);
    });

    it('does not offer "Pedir material" on an archived client, but still lists its requests', async () => {
      const { impl } = makeFetch({ client: () => json(archivedClient), threads: openOnly(request()) });
      renderClientDetail(impl);
      const section = await sectionOf();
      await within(section).findByText('Fotos da equipe');
      expect(within(section).queryByRole('button', { name: 'Pedir material' })).toBeNull();
    });

    it('opens a request from the client page with a deadline, posts it to the threads route and closes', async () => {
      const posted: unknown[] = [];
      const { impl } = makeFetch({
        threads: (method, _url, body) => {
          if (method !== 'POST') return listOf();
          posted.push(body);
          return json({
            thread: request({ lastComment: { side: 'agency', at: '2026-10-13T01:30:00.000Z', excerpt: 'Envie o logotipo' } }),
            comment: { id: 'dddddddd-1111-4111-8111-111111111111', body: 'Envie o logotipo', side: 'agency', author: null, createdAt: '2026-10-13T01:30:00.000Z' }
          }, 201);
        }
      });
      renderClientDetail(impl);
      const section = await sectionOf();
      fireEvent.click(await within(section).findByRole('button', { name: 'Pedir material' }));
      const dialog = await screen.findByRole('dialog', { name: 'Pedir material' });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Título do pedido' }), { target: { value: 'Logotipo' } });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'O que você precisa do cliente' }), { target: { value: 'Envie o logotipo' } });
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Prazo (opcional)' }), { target: { value: '31/12/2099' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));

      // The date is past the 90 days from today: the screen refuses it before the request leaves, and keeps what was typed.
      await within(dialog).findByText('Escolha um prazo de hoje até 90 dias à frente.');
      expect(posted).toHaveLength(0);
      expect((within(dialog).getByRole('textbox', { name: 'Título do pedido' }) as HTMLInputElement).value).toBe('Logotipo');
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Prazo (opcional)' }), { target: { value: '' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pedir material' })).toBeNull());
      expect(posted).toStrictEqual([{ subject: { materialRequest: true }, title: 'Logotipo', body: 'Envie o logotipo' }]);
    });
  });

  describe('the Conteúdos tab (decision 2026-11-11)', () => {
    // 15:00Z of the 12th is 12:00 of the 12th in São Paulo; the sends below sit at 01:30Z, still the previous São Paulo day.
    const NOW = '2026-11-12T15:00:00.000Z';
    const CONTENT_PERMISSIONS = [...ADMIN_PERMISSIONS, 'conteudo.operar'];
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(NOW));
    });
    afterEach(() => { vi.useRealTimers(); });

    const content = (n: number, overrides: Record<string, unknown> = {}) => ({
      id: `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`,
      title: `Conteúdo ${n}`,
      platform: 'instagram',
      format: 'image',
      publishOn: '2026-11-20',
      publishAtTime: null,
      status: 'in_production',
      owner: { membershipId: 'ffffffff-0000-4000-8000-000000000001', name: 'João Pedro Alves' },
      coverAssetId: null,
      thumbnailAssetId: null,
      revision: 1,
      publishedOn: null,
      tasksTotal: 0,
      tasksApproved: 0,
      approval: null,
      ...overrides
    });
    const sent = (instant: string) => ({ sentAt: instant, dueAt: null, dueOn: null, note: null });
    const BOARD = [
      content(1, { title: 'Cardápio de Natal', format: 'carousel', publishOn: '2026-11-20', status: 'awaiting_approval', approval: sent('2026-11-10T01:30:00.000Z') }),
      content(2, { title: 'Sextou com pão de mel', publishOn: '2026-11-21', status: 'awaiting_approval', approval: sent('2026-11-12T01:30:00.000Z') }),
      content(3, { title: 'Promoção do café da manhã', publishOn: '2026-11-09', status: 'in_production', owner: { membershipId: 'ffffffff-0000-4000-8000-000000000002', name: 'Júlia Prado' } }),
      content(4, { title: 'Como escolher o pão certo', format: 'reels', publishOn: '2026-11-16' }),
      content(5, { title: 'Tour pela padaria', format: 'reels', publishOn: '2026-11-19', owner: null }),
      content(6, { title: 'Bastidores da fornada', format: 'reels', publishOn: '2026-11-25', status: 'adjusting' }),
      content(7, { title: 'Pão de fermentação natural', format: 'reels', publishOn: '2026-11-12', publishAtTime: '18:00:00', status: 'approved', owner: null }),
      content(8, { title: 'Cheirinho de manhã', publishOn: '2026-11-17', status: 'approved' }),
      content(9, { title: 'Cancelado', publishOn: '2026-11-18', status: 'cancelled' })
    ];
    const withContents = (items: Record<string, unknown>[], extra: Partial<Scenario> = {}) => makeFetch({
      contents: (url) => json({ data: { contents: items, storyScripts: [] }, meta: { from: url.searchParams.get('from'), to: url.searchParams.get('to'), count: items.length } }),
      ...extra
    });
    const groupOf = (title: string): HTMLElement => screen.getByRole('heading', { level: 2, name: title }).closest('section') as HTMLElement;
    const groupTitles = (): (string | null)[] => Array.from(document.querySelectorAll('.client-contents__group h2')).map((heading) => heading.textContent);
    const rowsOf = (group: HTMLElement): (string | null)[] => within(group).getAllByRole('link').map((link) => link.textContent).filter((text) => text !== 'Reenviar o link');
    const contentsUrl = clientUrl(CLIENT_ID, 'conteudos');

    it('reads the month of the client in São Paulo days, with the period the list needs and no more', async () => {
      const urls: string[] = [];
      const { impl } = withContents(BOARD, {
        contents: (url) => { urls.push(url.search); return json({ data: { contents: BOARD, storyScripts: [] }, meta: { from: url.searchParams.get('from'), to: url.searchParams.get('to'), count: BOARD.length } }); }
      });
      renderClientDetail(impl, contentsUrl);
      await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' });
      expect(urls).toEqual(['?from=2026-11-01&to=2026-11-30']);
    });

    it('draws the header of the board: the meta line, the secondary calendar link and the primary "Nova publicação"', async () => {
      const { impl } = withContents(BOARD, { permissions: CONTENT_PERMISSIONS });
      const { probe } = renderClientDetail(impl, { pathname: contentsUrl, state: { clientListUrl: `/agencia/${AGENCY_A}/clientes?search=padaria` } });
      await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' });

      expect(screen.getByText('16 conteúdos em novembro · 2 esperando o cliente')).toBeTruthy();
      const calendar = screen.getByRole('link', { name: 'Abrir no Calendário Editorial' });
      expect(calendar.classList.contains('ui-button--secondary')).toBe(true);
      expect(calendar.getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos/${CLIENT_ID}`);
      const create = screen.getByRole('button', { name: 'Nova publicação' });
      expect(create.classList.contains('ui-button--primary')).toBe(true);
      expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();

      fireEvent.click(create);
      await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/conteudos/${CLIENT_ID}/novo`));
      expect(probe.search).toBe('?dia=2026-11-12');
      expect(probe.state).toEqual({ clientListUrl: `/agencia/${AGENCY_A}/clientes?search=padaria` });
    });

    it('offers "Nova publicação" only to who can operate contents, on an active client, and says the singular of the meta', async () => {
      const { impl } = withContents(BOARD);
      renderClientDetail(impl, contentsUrl);
      await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' });
      expect(screen.queryByRole('button', { name: 'Nova publicação' })).toBeNull();
      cleanup();

      const archived = withContents(BOARD, { permissions: CONTENT_PERMISSIONS, client: () => json(archivedClient) });
      renderClientDetail(archived.impl, contentsUrl);
      await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' });
      expect(screen.queryByRole('button', { name: 'Nova publicação' })).toBeNull();
      cleanup();

      const one = withContents([content(1, { status: 'awaiting_approval', approval: sent('2026-11-12T01:30:00.000Z') })], { client: () => json({ ...padaria, summary: { ...padaria.summary, contentsThisMonth: 1 } }) });
      renderClientDetail(one.impl, contentsUrl);
      expect(await screen.findByText('1 conteúdo em novembro · 1 esperando o cliente')).toBeTruthy();
    });

    it('groups by who has to act, with the count of each group, the rows of the board and no cancelled content', async () => {
      const { impl } = withContents(BOARD);
      renderClientDetail(impl, contentsUrl);
      await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' });

      expect(groupTitles()).toEqual(['Esperando o cliente', 'Atrasado', 'Em produção', 'Aprovado e agendado']);
      expect(rowsOf(groupOf('Esperando o cliente'))).toEqual([
        // Sent at 01:30Z of the 10th: the 9th in São Paulo, three days before the 12th (UTC would say two).
        'Cardápio de NatalCarrossel · 20 nov · enviado há 3 diasJAAguardando',
        // Sent at 01:30Z of the 12th: the 11th in São Paulo, one day before.
        'Sextou com pão de melEstático · 21 nov · enviado há 1 diaJAAguardando'
      ]);
      expect(rowsOf(groupOf('Atrasado'))).toEqual(['Promoção do café da manhãEstático · deveria ter saído em 9 novJPAtrasado 3 dias']);
      expect(rowsOf(groupOf('Aprovado e agendado'))).toEqual([
        'Pão de fermentação naturalReels · hoje, 18hAgendado',
        'Cheirinho de manhãEstático · 17 novJAAprovado'
      ]);
      expect(within(groupOf('Esperando o cliente')).getByText('2')).toBeTruthy();
      expect(within(groupOf('Em produção')).getByText('3')).toBeTruthy();
      expect(screen.queryByText('Cancelado')).toBeNull();
    });

    it('shows two rows of "Em produção" with "+ N em produção" and "ver todos", which shows the rest', async () => {
      const { impl } = withContents(BOARD);
      renderClientDetail(impl, contentsUrl);
      await screen.findByRole('heading', { level: 2, name: 'Em produção' });

      expect(rowsOf(groupOf('Em produção'))).toEqual([
        'Como escolher o pão certoReels · 16 novJAEm produção',
        'Tour pela padariaReels · 19 novEm produção'
      ]);
      expect(within(groupOf('Em produção')).getByText(/^\+ 1 em produção/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'ver todos' }));
      expect(rowsOf(groupOf('Em produção'))).toHaveLength(3);
      expect(within(groupOf('Em produção')).getByRole('link', { name: /Bastidores da fornada/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'ver todos' })).toBeNull();
    });

    it('opens the content of the row that was clicked, at the calendar address, with the roster address in the state', async () => {
      const roster = `/agencia/${AGENCY_A}/clientes?search=padaria`;
      const { impl } = withContents(BOARD);
      const { probe } = renderClientDetail(impl, { pathname: contentsUrl, state: { clientListUrl: roster } });
      await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' });

      const second = within(groupOf('Esperando o cliente')).getByRole('link', { name: /Sextou com pão de mel/ });
      expect(second.getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos/${CLIENT_ID}/${content(2).id}?data=2026-11-21`);
      expect(within(groupOf('Esperando o cliente')).getByRole('link', { name: /Cardápio de Natal/ }).getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos/${CLIENT_ID}/${content(1).id}?data=2026-11-20`);
      fireEvent.click(second);
      await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/conteudos/${CLIENT_ID}/${content(2).id}`));
      expect(probe.search).toBe('?data=2026-11-21');
      expect(probe.state).toEqual({ clientListUrl: roster });
    });

    it('regroups by date and by format with the chips, keeps the choice in the address and returns to who has to act', async () => {
      const { impl } = withContents(BOARD);
      const { probe } = renderClientDetail(impl, { pathname: contentsUrl, state: { clientListUrl: `/agencia/${AGENCY_A}/clientes?search=padaria` } });
      await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' });

      const chips = (): string[] => within(screen.getByRole('group', { name: 'Agrupar' })).getAllByRole('button').map((chip) => `${chip.textContent}:${chip.getAttribute('aria-pressed')}`);
      expect(chips()).toEqual(['Por quem precisa agir:true', 'Por data:false', 'Por formato:false']);

      fireEvent.click(screen.getByRole('button', { name: 'Por data' }));
      await waitFor(() => expect(probe.search).toBe('?agrupar=data'));
      expect(chips()).toEqual(['Por quem precisa agir:false', 'Por data:true', 'Por formato:false']);
      expect(groupTitles()).toEqual(
        ['9 de novembro', '12 de novembro', '16 de novembro', '17 de novembro', '19 de novembro', '20 de novembro', '21 de novembro', '25 de novembro']
      );
      expect(screen.queryByRole('button', { name: 'ver todos' })).toBeNull();
      expect(screen.queryByRole('link', { name: /Reenviar o link/ })).toBeNull();
      expect(probe.state).toEqual({ clientListUrl: `/agencia/${AGENCY_A}/clientes?search=padaria` });

      fireEvent.click(screen.getByRole('button', { name: 'Por formato' }));
      await waitFor(() => expect(probe.search).toBe('?agrupar=formato'));
      expect(groupTitles()).toEqual(['Carrossel', 'Reels', 'Estático']);
      expect(rowsOf(groupOf('Carrossel'))).toHaveLength(1);
      expect(rowsOf(groupOf('Reels'))).toHaveLength(4);
      expect(rowsOf(groupOf('Estático'))).toHaveLength(3);

      fireEvent.click(screen.getByRole('button', { name: 'Por quem precisa agir' }));
      await waitFor(() => expect(probe.search).toBe(''));
      expect(await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' })).toBeTruthy();
    });

    it.each([['data', 'Por data'], ['formato', 'Por formato']])('opens already grouped when the address says ?agrupar=%s', async (value, label) => {
      const { impl } = withContents(BOARD);
      renderClientDetail(impl, `${contentsUrl}?agrupar=${value}`);
      await screen.findByRole('group', { name: 'Agrupar' });
      expect(screen.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.queryByRole('heading', { level: 2, name: 'Esperando o cliente' })).toBeNull();
    });

    it('offers "Reenviar o link" in the waiting group only to who manages the portal access, as an external link', async () => {
      const { impl } = withContents(BOARD);
      renderClientDetail(impl, contentsUrl);
      await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' });
      const resend = within(groupOf('Esperando o cliente')).getByRole('link', { name: 'Reenviar o link para Padaria Central (abre em nova aba)' });
      expect(resend.textContent).toBe('Reenviar o link');
      expect(resend.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/\?text=/);
      expect(resend.getAttribute('target')).toBe('_blank');
      expect(resend.getAttribute('rel')).toBe('noopener noreferrer');
      expect(within(groupOf('Aprovado e agendado')).queryByRole('link', { name: /Reenviar/ })).toBeNull();
      cleanup();

      const reader = withContents(BOARD, { permissions: ['cliente.visualizar', 'conteudo.visualizar'] });
      renderClientDetail(reader.impl, contentsUrl);
      await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' });
      expect(screen.queryByRole('link', { name: /Reenviar o link/ })).toBeNull();
    });

    it('says a month with no content as the first use, and a month that could not be read as a failure with a retry', async () => {
      const empty = withContents([]);
      renderClientDetail(empty.impl, contentsUrl);
      expect(await screen.findByText('Nenhum conteúdo em novembro')).toBeTruthy();
      expect(screen.getByText('Os conteúdos do cliente planejados para este mês aparecem aqui, agrupados pelo que precisa de quem.')).toBeTruthy();
      expect(screen.queryByRole('group', { name: 'Agrupar' })).toBeNull();
      cleanup();

      let failing = true;
      const { impl } = makeFetch({
        contents: (url) => failing
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500)
          : json({ data: { contents: BOARD, storyScripts: [] }, meta: { from: url.searchParams.get('from'), to: url.searchParams.get('to'), count: BOARD.length } })
      });
      renderClientDetail(impl, contentsUrl);
      const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
      expect(alert.textContent).toContain('Não foi possível carregar os conteúdos. Tente de novo.');
      expect(alert.textContent).not.toContain('private diagnostic');
      expect(screen.queryByText('Nenhum conteúdo em novembro')).toBeNull();
      failing = false;
      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await screen.findByRole('heading', { level: 2, name: 'Esperando o cliente' })).toBeTruthy();
    });

    it('shows a loading shape on the first read', async () => {
      const { impl } = makeFetch({ contents: () => new Promise<Response>(() => undefined) });
      const { container } = renderClientDetail(impl, contentsUrl);
      await screen.findByRole('heading', { name: 'Padaria Central' });
      expect(container.querySelector('.client-contents__skeleton')?.getAttribute('aria-busy')).toBe('true');
      expect(screen.queryByText('Nenhum conteúdo em novembro')).toBeNull();
    });

    it('is not found without conteudo.visualizar, with no client in the page, and the old creation address still leads to the calendar', async () => {
      const reader = makeFetch({ permissions: READER_PERMISSIONS });
      const { container } = renderClientDetail(reader.impl, contentsUrl);
      expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
      expect(container.textContent).not.toContain('Padaria Central');
      cleanup();

      const { impl } = withContents(BOARD);
      const { probe } = renderClientDetail(impl, `${contentsUrl}/novo?dia=2026-11-12`);
      await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/conteudos/${CLIENT_ID}/novo`));
      expect(probe.search).toBe('?dia=2026-11-12');
    });
  });

  it('writes "Não informado" for every empty registration field, and never renders a bare "@"', async () => {
    const { impl } = makeFetch({ client: () => json(drainedClient) });
    const { container } = renderClientDetail(impl);

    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getAllByText('Não informado')).toHaveLength(7);
    expect(container.textContent).not.toContain('@');
    expect(screen.queryByText('@null')).toBeNull();
  });

  it('labels the registration document as "CNPJ ou CPF" on the General tab (review of #379)', async () => {
    const { impl } = makeFetch();
    const { container } = renderClientDetail(impl);

    await screen.findByRole('heading', { name: 'Padaria Central' });
    const general = container.querySelector<HTMLElement>('.client-general');
    if (general === null) throw new Error('The General tab was not rendered.');
    // The same label the edit modal uses: the field accepts both documents (#137).
    expect(within(general).getByText('CNPJ ou CPF')).toBeTruthy();
  });

  it('shows the archiving day in America/Sao_Paulo, not the UTC slice (review of #379)', async () => {
    // 01:00 UTC is 22h of the previous day in São Paulo: archiving at 22h of 07/10 becomes the
    // 8th in UTC. The banner must say the agency's day.
    const { impl } = makeFetch({ client: () => json({ ...archivedClient, archivedAt: '2026-10-08T01:00:00.000Z' }) });
    renderClientDetail(impl);

    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByText('Cliente arquivado em 07/10')).toBeTruthy();
    expect(screen.queryByText('Cliente arquivado em 08/10')).toBeNull();
  });

  it('shows Editar only for cliente.operar on an active client, and opens the edit modal', async () => {
    const reader = makeFetch({ permissions: READER_PERMISSIONS });
    renderClientDetail(reader.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    cleanup();

    renderClientDetail(makeFetch({ permissions: MANAGER_PERMISSIONS }).impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(await openEditDialog()).toBeTruthy();
  });

  it('shows the closing actions only for cliente.arquivar', async () => {
    const manager = makeFetch({ permissions: MANAGER_PERMISSIONS });
    renderClientDetail(manager.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: 'Ações do cliente' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reativar' })).toBeNull();
    cleanup();

    const admin = makeFetch();
    renderClientDetail(admin.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByRole('button', { name: 'Ações do cliente' })).toBeTruthy();
  });

  it('never shows Editar on an archived client; Reativar is the only lifecycle action (#139)', async () => {
    const admin = makeFetch({ client: () => json(archivedClient) });
    renderClientDetail(admin.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByText('Arquivado')).toBeTruthy();
    expect(screen.getByText('Cliente arquivado em 04/10')).toBeTruthy();
    // The fixture carries a closingDate the API would have cleared on archiving; the badge must
    // still not appear (the mutation that ignores `active` dies here).
    expect(screen.queryByText(/encerra em/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ações do cliente' })).toBeNull();
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
    fireEvent.click(screen.getByRole('link', { name: /^Acessos/ }));
    expect(await screen.findByRole('heading', { name: 'Pessoas com acesso ao portal' })).toBeTruthy();
    expect(probe.pathname).toBe(clientUrl(CLIENT_ID, 'acessos'));
    cleanup();

    const manager = makeFetch({ permissions: MANAGER_PERMISSIONS });
    const managerRender = renderClientDetail(manager.impl, clientUrl(CLIENT_ID, 'acessos'));
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Acessos/ })).toBeNull();
    expect(managerRender.container.textContent).not.toContain('Padaria Central');
    cleanup();

    const reader = makeFetch({ permissions: READER_PERMISSIONS });
    renderClientDetail(reader.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('link', { name: /^Acessos/ })).toBeNull();
  });

  it('keeps the Portal block as text when the person cannot see the Acessos tab', async () => {
    const { impl } = makeFetch({ permissions: MANAGER_PERMISSIONS });
    renderClientDetail(impl);

    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByText('pessoas com acesso').closest('div')?.textContent).toContain('3pessoas com acesso');
    expect(screen.queryByRole('link', { name: /Portal/ })).toBeNull();
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

    await within(await screen.findByRole('navigation', { name: 'Você está em' })).findByRole('link', { name: 'Clientes' });
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
    expect(alert.classList.contains('ui-empty-state--failure')).toBe(true);
    const attemptsBeforeRetry = attempts;
    fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('heading', { name: 'Padaria Central' })).toBeTruthy();
    expect(attempts).toBeGreaterThan(attemptsBeforeRetry);
  });

  it('keeps the page and an open modal when a background refetch fails (review of #379)', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      client: () => {
        attempts += 1;
        return attempts === 1
          ? json(padaria)
          : json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500);
      }
    });
    const { container, queryClient } = renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    // A refetch triggered while the modal is open (e.g. after the save invalidation) fails;
    // the cached client keeps the page and the modal alive.
    act(() => { queryClient.invalidateQueries({ queryKey: ['agency', AGENCY_A, 'clients', 'detail', CLIENT_ID.toLowerCase()] }); });
    // With data present, the failed refetch keeps `status: success` on purpose; the failure lands
    // in `error` after its retry backoff (`isError` on the page), so the test waits for it.
    await waitFor(() => {
      const state = queryClient.getQueryState(['agency', AGENCY_A, 'clients', 'detail', CLIENT_ID.toLowerCase()]);
      expect(state?.error).not.toBeNull();
    }, { timeout: 5000 });
    expect(await screen.findByRole('heading', { name: 'Padaria Central' })).toBeTruthy();
    expect(screen.queryByText('Não foi possível carregar o cliente. Tente de novo.')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Editar cliente' })).toBe(dialog);
    expect(container.textContent).not.toContain('private diagnostic');
  });

  it.each([403, 404])('answers %i as the same not-found, without revealing the client', async (status) => {
    const { impl, calls } = makeFetch({
      client: () => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'sensitive detail' } }, status)
    });
    renderClientDetail(impl);

    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(screen.queryByText('Padaria Central')).toBeNull();
    expect(screen.queryByText('sensitive detail')).toBeNull();
    expect(calls.filter((call) => call.includes('/clients/'))).toHaveLength(1);
  });

  it.each(['not-a-uuid', '..%2Fme', 'x?tab=acessos'])('refuses the malformed client id %s without a request', async (id) => {
    const { impl, calls } = makeFetch();
    renderClientDetail(impl, `/agencia/${AGENCY_A}/clientes/${encodeURIComponent(id)}/geral`);

    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
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
    expect(rendered.container.querySelector('img:not([src^="/brand/"]):not([src^="/3d/"])')).toBeNull();
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

    await screen.findByRole('heading', { name: 'Página não encontrada' });
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

  it('stays disabled until something changes, sends only the changed fields, and closes on success', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({ patch: (body) => { bodies.push(body); return json(registrationOf(padaria)); } });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    let dialog = await openEditDialog();
    const submit = within(dialog).getByRole('button', { name: 'Salvar' });
    expect(submit.hasAttribute('disabled')).toBe(true);

    // Instagram was typed with the @: it travels without it (the column stores it without).
    fireEvent.change(editInstagramInput(dialog), { target: { value: '@novo_handle' } });
    expect(submit.hasAttribute('disabled')).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(bodies).toEqual([{ instagramHandle: 'novo_handle' }]));
    expect(bodies[0]).not.toHaveProperty('name');
    // A save that landed closes the modal over the updated detail (review of #379).
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar cliente' })).toBeNull());

    dialog = await openEditDialog();
    fireEvent.change(editNameInput(dialog), { target: { value: 'Padaria Renovada' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1]).toEqual({ name: 'Padaria Renovada' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar cliente' })).toBeNull());
  });

  it('asks before discarding a typed change on Esc and on the X, and closes at once when nothing changed', async () => {
    const { impl } = makeFetch();
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const escape = (target: HTMLElement): void => { fireEvent(target, new Event('cancel', { bubbles: true, cancelable: true })); };

    escape(await openEditDialog());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const dialog = await openEditDialog();
    fireEvent.change(editNameInput(dialog), { target: { value: 'Padaria Renovada' } });
    escape(dialog);
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Descartar o que você escreveu?' })).getByRole('button', { name: 'Continuar editando' }));
    expect(editNameInput(dialog).value).toBe('Padaria Renovada');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar edição do cliente' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Descartar o que você escreveu?' })).getByRole('button', { name: 'Descartar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('sends null when a field is cleared, and the CNPJ/CPF mask is stripped', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({ patch: (body) => { bodies.push(body); return json(registrationOf(padaria)); } });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    fireEvent.change(editInstagramInput(dialog), { target: { value: '' } });
    fireEvent.change(editLegalNameInput(dialog), { target: { value: '' } });
    fireEvent.change(editTaxIdInput(dialog), { target: { value: '98.765.432/0001-10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(bodies).toEqual([{ instagramHandle: null, legalName: null, taxId: '98765432000110' }]));
  });

  it('keeps letters in CNPJ/CPF for the API to refuse them on the field, never clearing the document', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({
      patch: (body) => {
        bodies.push(body);
        return json({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'validation failed',
            details: { issues: [{ path: 'taxId', code: 'custom', message: 'private issue message' }] }
          }
        }, 400);
      }
    });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    const taxId = editTaxIdInput(dialog);

    fireEvent.change(taxId, { target: { value: 'abc' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('CNPJ ou CPF deve ter 11 ou 14 dígitos.')).toBeTruthy();
    expect(bodies).toEqual([{ taxId: 'abc' }]);
    expect(taxId.getAttribute('aria-invalid')).toBe('true');
    expect(taxId.value).toBe('abc');
    expect(dialog.textContent).not.toContain('private');
    expect(screen.getByRole('dialog', { name: 'Editar cliente' })).toBe(dialog);
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

  // A zero-width space is refused today by the name rule; the name was saved before the rule (#446).
  const legacyName = 'Padaria\u200bCentral';
  const legacyClient = { ...padaria, name: legacyName };

  it('saves another field of a client whose stored name the current rule refuses (#446)', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({
      client: () => json(legacyClient),
      patch: (body) => { bodies.push(body); return json(registrationOf(legacyClient)); }
    });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: legacyName });
    const dialog = await openEditDialog();
    expect(editNameInput(dialog).value).toBe(legacyName);

    fireEvent.change(editTaxIdInput(dialog), { target: { value: '98.765.432/0001-10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(bodies).toEqual([{ taxId: '98765432000110' }]));
    expect(within(dialog).queryByText('O nome contém caracteres que não são aceitos.')).toBeNull();
  });

  it('still holds a changed name to the current rule, sending nothing (#446)', async () => {
    const { impl, calls } = makeFetch({ client: () => json(legacyClient) });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: legacyName });
    const dialog = await openEditDialog();
    const name = editNameInput(dialog);

    fireEvent.change(name, { target: { value: 'Outra\u200bPadaria' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('O nome contém caracteres que não são aceitos.')).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(calls.some((call) => call.startsWith('PATCH'))).toBe(false);
  });

  it('refuses an invalid new name for a client whose stored name is fine (#446)', async () => {
    const { impl, calls } = makeFetch();
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    fireEvent.change(editNameInput(dialog), { target: { value: 'Outra\u200bPadaria' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(await within(dialog).findByText('O nome contém caracteres que não são aceitos.')).toBeTruthy();
    expect(calls.some((call) => call.startsWith('PATCH'))).toBe(false);
  });

  it('lets a legacy client rename to a valid name (#446)', async () => {
    const bodies: unknown[] = [];
    const { impl } = makeFetch({
      client: () => json(legacyClient),
      patch: (body) => { bodies.push(body); return json(registrationOf({ ...legacyClient, name: 'Padaria Central' })); }
    });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: legacyName });
    const dialog = await openEditDialog();

    fireEvent.change(editNameInput(dialog), { target: { value: 'Padaria Central' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(bodies).toEqual([{ name: 'Padaria Central' }]));
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

  it('says every refused field with the error icon, puts the focus on the first one and gives one alert naming both', async () => {
    const { impl } = makeFetch({
      patch: () => json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'validation failed',
          details: { issues: [{ path: 'contactEmail', code: 'custom', message: 'x' }, { path: 'taxId', code: 'custom', message: 'x' }] }
        }
      }, 400)
    });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    fireEvent.change(editTaxIdInput(dialog), { target: { value: '123' } });
    fireEvent.change(editContactEmailInput(dialog), { target: { value: 'sem-arroba' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    for (const [input, text] of [[editTaxIdInput(dialog), 'CNPJ ou CPF deve ter 11 ou 14 dígitos.'], [editContactEmailInput(dialog), 'O e-mail de contato é inválido.']] as const) {
      const message = await within(dialog).findByText(text);
      expect(message.querySelector('.ui-icon svg'), text).not.toBeNull();
      expect(message.getAttribute('role'), text).toBeNull();
      expect(input.getAttribute('aria-describedby'), text).toBe(message.id);
    }
    expect(document.activeElement).toBe(editTaxIdInput(dialog));
    const alerts = within(dialog).getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe('Corrija 2 campos: CNPJ ou CPF, E-mail.');
  });

  it('puts the focus back on the name when it is empty, and Salvar belongs to the form from the foot of the dialog', async () => {
    const { impl, calls } = makeFetch();
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    const submit = within(dialog).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    expect(submit.closest('.ui-modal__actions')).not.toBeNull();
    expect(submit.form).toBe(dialog.querySelector('form'));

    fireEvent.change(editInstagramInput(dialog), { target: { value: 'outro' } });
    editNameInput(dialog).blur();
    fireEvent.change(editNameInput(dialog), { target: { value: '   ' } });
    fireEvent.click(submit);

    const message = await within(dialog).findByText('Informe o nome do cliente.');
    expect(message.querySelector('.ui-icon svg')).not.toBeNull();
    expect(document.activeElement).toBe(editNameInput(dialog));
    expect(calls.some((call) => call.startsWith('PATCH'))).toBe(false);
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
    // The retry that lands closes the modal and clears the error from the screen.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar cliente' })).toBeNull());
    expect(screen.queryByText('Não foi possível salvar o cliente. Tente de novo.')).toBeNull();
  });

  it('shows the save busy state on the button, without closing the modal (review of #379)', async () => {
    let resolvePatch: ((response: Response) => void) | undefined;
    const pendingPatch = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    const { impl } = makeFetch({ patch: () => pendingPatch });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();
    fireEvent.change(editNameInput(dialog), { target: { value: 'Padaria Renovada' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    const submit = within(dialog).getByRole('button', { name: 'Salvar' });
    await waitFor(() => expect(submit.hasAttribute('aria-busy')).toBe(true));
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Editar cliente' })).toBe(dialog);

    await act(async () => { resolvePatch?.(json({ ...registrationOf(padaria), name: 'Padaria Renovada' })); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editar cliente' })).toBeNull());
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

    // The save closed the modal; the header behind reads the same cache: no reload needed.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Padaria Renovada' })).toBeTruthy();

    fireEvent.click(rosterLink());
    // The roster was invalidated; without it, the cached "Padaria Central" would stay.
    expect(await screen.findByText('Padaria Renovada')).toBeTruthy();
    expect(screen.queryByText('Padaria Central')).toBeNull();
  });

  it('keeps the typed draft when the photo upload answers (review of #379)', async () => {
    let current = padaria;
    const { impl } = makeFetch({
      client: () => json(current),
      putPhoto: () => {
        current = { ...current, photoUrl: 'https://storage.test/nova.png' };
        return json({ photoUrl: 'https://storage.test/nova.png' });
      }
    });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    fireEvent.change(editInstagramInput(dialog), { target: { value: '@digitado' } });
    fireEvent.change(modalFileInput(dialog), {
      target: { files: [new File([pngBytes], 'foto.png', { type: 'image/png' })] }
    });
    await waitFor(() => expect(dialog.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/nova.png'));
    expect(editInstagramInput(dialog).value).toBe('@digitado');
    expect(editNameInput(dialog).value).toBe('Padaria Central');
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

  it.each([
    [413, 'PAYLOAD_TOO_LARGE', 'A foto passa do tamanho máximo aceito.'],
    [415, 'UNSUPPORTED_MEDIA_TYPE', 'Formato não aceito. Envie uma foto PNG, JPEG, GIF ou WebP.']
  ])('maps the photo refusal %i (%s) to its message, decided by the API bytes', async (status, code, message) => {
    const { impl } = makeFetch({
      putPhoto: () => json({ error: { code, message: 'private diagnostic' } }, status)
    });
    renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openEditDialog();

    fireEvent.change(modalFileInput(dialog), {
      target: { files: [new File([pngBytes], 'foto.png', { type: 'image/png' })] }
    });
    expect(await within(dialog).findByText(message)).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
    expect(within(dialog).queryByText('PC')).toBeTruthy();
  });

  it('uploads a valid photo with its own state, independent of Salvar', async () => {
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

  it('shows the uploaded photo in the roster without a reload (SPEC §6, review of #379)', async () => {
    let current = padaria;
    const { impl } = makeFetch({
      client: () => json(current),
      clients: () => json({ data: [listItemOf(current)], meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 } }),
      putPhoto: () => {
        current = { ...current, photoUrl: 'https://storage.test/nova.png' };
        return json({ photoUrl: 'https://storage.test/nova.png' });
      }
    });
    const { container, probe } = renderClientDetail(impl, `/agencia/${AGENCY_A}/clientes`);
    await screen.findByText('Padaria Central');
    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
    const dialog = await openEditDialog();

    fireEvent.change(modalFileInput(dialog), {
      target: { files: [new File([pngBytes], 'foto.png', { type: 'image/png' })] }
    });
    await waitFor(() => expect(dialog.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/nova.png'));

    fireEvent.click(rosterLink());
    await waitFor(() => expect(container.querySelector('.clients__card img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/nova.png'));
  });

  it('shows the removed photo in the roster without a reload (SPEC §6, review of #379)', async () => {
    let current = withPhoto;
    const { impl } = makeFetch({
      client: () => json(current),
      clients: () => json({ data: [listItemOf(current)], meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 } }),
      deletePhoto: (): Response => { current = { ...current, photoUrl: null }; return noContent(); }
    });
    const { container, probe } = renderClientDetail(impl, `/agencia/${AGENCY_A}/clientes`);
    await screen.findByText('Padaria Central');
    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
    const dialog = await openEditDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remover' }));
    await waitFor(() => expect(within(dialog).getByText('PC')).toBeTruthy());

    fireEvent.click(rosterLink());
    await waitFor(() => expect(container.querySelector('.clients__card img')).toBeNull());
    expect(within(container.querySelector('.clients__card') as HTMLElement).getByText('PC')).toBeTruthy();
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

describe('formatArchivedDay (#379 review)', () => {
  it.each([
    // 01:00 UTC is 22h of the previous day in São Paulo (UTC-3, no DST since 2019).
    ['2026-10-08T01:00:00.000Z', '07/10'],
    ['2026-10-04T12:00:00.000Z', '04/10'],
    ['2026-10-04T02:59:59.000Z', '03/10'],
    ['not-a-date', 'not-a-date']
  ])('labels %s as %s, in the agency day', (value, expected) => {
    expect(formatArchivedDay(value)).toBe(expected);
  });
});

describe('client detail in the Pauta (#637)', () => {
  it('draws the section links as the Tabs component does, and marks only the open one', async () => {
    const { impl } = makeFetch();
    renderClientDetail(impl, clientUrl(CLIENT_ID, 'estudo-de-marca'));

    const nav = await screen.findByRole('navigation', { name: 'Seções do cliente' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => link.classList.contains('ui-tabs__tab'))).toEqual(links.map(() => true));
    expect(links.filter((link) => link.getAttribute('aria-current') === 'page').map((link) => link.textContent)).toEqual(['Marca']);
  });

  it('says the situation with an icon and a label, and leaves one primary action in the header: the calendar', async () => {
    const { impl } = makeFetch();
    renderClientDetail(impl);

    await screen.findByRole('heading', { name: 'Padaria Central' });
    for (const label of ['Ativo', 'encerra em 30/10']) {
      const pill = screen.getByText(label);
      expect(pill.classList.contains('ui-pill')).toBe(true);
      expect(pill.querySelector('svg')).not.toBeNull();
    }
    expect(screen.getByRole('button', { name: 'Editar' }).classList.contains('ui-button--ghost')).toBe(true);
    const primaries = document.querySelectorAll('.client-detail .ui-button--primary');
    expect(Array.from(primaries).map((button) => button.textContent)).toEqual(['Abrir no Calendário Editorial']);
  });

  it('writes the figure of the Conversas block from the threads waiting for the agency, a zero included', async () => {
    const { impl } = makeFetch();
    const { container } = renderClientDetail(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(within(container.querySelector<HTMLElement>('.client-general')!).getByRole('link', { name: /Conversas/ }).textContent).toBe('Conversas2aguardando a agênciaVer conversas');
    cleanup();

    const quiet = makeFetch({ client: () => json({ ...padaria, summary: { ...padaria.summary, threadsAwaitingAgency: 0 } }) });
    const second = renderClientDetail(quiet.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(within(second.container.querySelector<HTMLElement>('.client-general')!).getByRole('link', { name: /Conversas/ }).textContent).toBe('Conversas0aguardando a agênciaVer conversas');
  });
});
