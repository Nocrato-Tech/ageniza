// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
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
const sessionBody = { user: { id: '99999999-9999-4999-8999-999999999999', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

interface TestRole {
  readonly key: string;
  readonly name: string;
}

const ADMIN_ROLE: TestRole = { key: 'admin', name: 'Admin' };

const agencyMe = (agencyId: string, agencyName: string, permissions: readonly string[]) => ({
  agencyId, agencyName, isOwner: false, role: ADMIN_ROLE, permissions
});

/** The three permissions the client module declares (specs/clientes.md section 2). */
const CLIENT_PERMISSIONS = ['cliente.visualizar', 'cliente.cadastrar', 'cliente.convidar_usuario'] as const;

const padaria = {
  id: '1a1a1a1a-1111-4111-8111-111111111111',
  name: 'Padaria Central',
  photoUrl: null,
  instagramHandle: 'padariacentral',
  status: 'active',
  closingDate: null,
  threadsAwaitingAgency: 2,
  pendingInvitations: 1
};
const academia = {
  id: '2b2b2b2b-2222-4222-8222-222222222222',
  name: 'Academia Corpo',
  photoUrl: 'https://storage.test/academia.png',
  instagramHandle: 'academiacorpo',
  status: 'active',
  closingDate: '2026-10-30',
  threadsAwaitingAgency: 0
};
/** The API omits `pendingInvitations` for a caller without `cliente.convidar_usuario`. An archived
 * client still carries its open threads, so it is the fixture that proves badges are suppressed. */
const barbearia = {
  id: '3c3c3c3c-3333-4333-8333-333333333333',
  name: 'Barbearia Lima',
  photoUrl: null,
  instagramHandle: null,
  status: 'archived',
  closingDate: null,
  threadsAwaitingAgency: 1
};
/** Field present and zero: the screen must not render a "0" badge either. */
const confeitaria = {
  id: '4d4d4d4d-4444-4444-8444-444444444444',
  name: 'Confeitaria Doce',
  photoUrl: null,
  instagramHandle: null,
  status: 'active',
  closingDate: null,
  threadsAwaitingAgency: 0,
  pendingInvitations: 0
};
/** The full registration a `POST` answers with (specs/clientes.md section 3). */
const createdClient = {
  id: '5e5e5e5e-5555-4555-8555-555555555555',
  name: 'Padaria Nova',
  status: 'active',
  photoUrl: null,
  legalName: null,
  taxId: null,
  segment: null,
  website: null,
  instagramHandle: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  closingDate: null,
  archivedAt: null
};

const meta = (page: number, totalItems: number, totalPages: number) => ({ page, pageSize: 20, totalItems, totalPages });
const listResponse = (data: readonly unknown[], page = 1, totals?: { totalItems: number; totalPages: number }): Response =>
  json({ data, meta: meta(page, totals?.totalItems ?? data.length, totals?.totalPages ?? (data.length === 0 ? 0 : 1)) });

interface Scenario {
  readonly authenticated?: boolean;
  readonly permissions?: readonly string[];
  readonly clients?: (query: URLSearchParams, agencyId: string) => Response | Promise<Response>;
  readonly createClient?: (body: unknown, agencyId: string) => Response | Promise<Response>;
}

/** Behaves like the real API: 401 without a session, the guard's 403 and the listing contract. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const authenticated = scenario.authenticated ?? true;
  const permissions = scenario.permissions ?? CLIENT_PERMISSIONS;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}${url.search}`);
    if (path.endsWith('/auth/session')) return authenticated ? json(sessionBody) : unauthenticated();
    if (!authenticated) return unauthenticated();
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(me[1]!, me[1] === AGENCY_B ? 'Agência Dois' : 'Agência Um', permissions));
    const clients = /\/agencies\/([^/]+)\/clients$/.exec(path);
    if (clients !== null && method === 'GET') {
      if (!permissions.includes('cliente.visualizar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      return scenario.clients?.(url.searchParams, clients[1]!) ?? listResponse([padaria, academia]);
    }
    if (clients !== null && method === 'POST') {
      if (!permissions.includes('cliente.cadastrar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      if (scenario.createClient === undefined) throw new Error(`unexpected POST ${url}`);
      return scenario.createClient(JSON.parse(String(init?.body)), clients[1]!);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface SearchProbeTarget {
  pathname: string;
  search: string;
  navigate: NavigateFunction;
}

function SearchProbe({ probe }: { probe: SearchProbeTarget }) {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.search = location.search;
  probe.navigate = useNavigate();
  return null;
}

const renderClients = (impl: typeof fetch, entry = `/agencia/${AGENCY_A}/clientes`) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: SearchProbeTarget = { pathname: '', search: '', navigate: () => undefined };
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <SearchProbe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { container: rendered.container, probe, queryClient };
};

const cardNames = (container: HTMLElement): (string | null)[] =>
  Array.from(container.querySelectorAll('.clients__card-name')).map((element) => element.textContent);

const searchBox = (): HTMLInputElement => screen.getByRole('searchbox', { name: 'Buscar por nome, razão social ou @' }) as HTMLInputElement;
const statusFilter = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement;

describe('ClientsPage (/agencia/:agenciaId/clientes)', () => {
  it('renders the cards in the order the server returned, without reordering', async () => {
    // The server order is Padaria (with suggestions), Academia — deliberately not alphabetical,
    // because the default `sort=attention` puts the client that needs triage first.
    const { impl, calls } = makeFetch();
    const { container } = renderClients(impl);

    await screen.findByText('Padaria Central');
    expect(cardNames(container)).toEqual(['Padaria Central', 'Academia Corpo']);
    // The screen obeys the server order: it asks for its page and never sends an order of its own.
    expect(calls).toContain(`GET /agencies/${AGENCY_A}/clients?page=1&pageSize=20`);
  });

  it('reads search, status and page from the URL and sends them to the server', async () => {
    const queries: string[] = [];
    const { impl } = makeFetch({
      clients: (query) => {
        queries.push(query.toString());
        return listResponse([barbearia], 2, { totalItems: 21, totalPages: 2 });
      }
    });
    renderClients(impl, `/agencia/${AGENCY_A}/clientes?search=padaria&status=archived&page=2`);

    await screen.findByText('Barbearia Lima');
    expect(queries.at(-1)).toContain('search=padaria');
    expect(queries.at(-1)).toContain('status=archived');
    expect(queries.at(-1)).toContain('page=2');
    expect(queries.at(-1)).toContain('pageSize=20');
    expect(searchBox().value).toBe('padaria');
    expect(statusFilter().value).toBe('archived');
    expect(screen.getByText('1 de 21 clientes')).toBeTruthy();
  });

  it('writes filter changes back into the URL and returns to the first page', async () => {
    const { impl } = makeFetch({
      clients: (query) => json({ data: [padaria], meta: meta(Number(query.get('page') ?? '1'), 40, 2) })
    });
    const { probe } = renderClients(impl, `/agencia/${AGENCY_A}/clientes?page=2`);

    await screen.findByText('Padaria Central');
    fireEvent.change(statusFilter(), { target: { value: 'archived' } });
    await waitFor(() => expect(probe.search).toContain('status=archived'));
    expect(probe.search).not.toContain('page=');

    fireEvent.change(searchBox(), { target: { value: 'padaria' } });
    await waitFor(() => expect(probe.search).toContain('search=padaria'));
    expect(probe.search).toContain('status=archived');
  });

  it('shows the create button only with cliente.cadastrar', async () => {
    const without = makeFetch({ permissions: ['cliente.visualizar'] });
    renderClients(without.impl);
    await screen.findByText('Padaria Central');
    expect(screen.queryByRole('button', { name: 'Cadastrar cliente' })).toBeNull();
    cleanup();

    const withPermission = makeFetch();
    renderClients(withPermission.impl);
    expect(await screen.findByRole('button', { name: 'Cadastrar cliente' })).toBeTruthy();
  });

  it('does not exist without cliente.visualizar and never requests the listing', async () => {
    const { impl, calls } = makeFetch({ permissions: [] });
    renderClients(impl);

    await screen.findByRole('heading', { name: 'Page not found' });
    expect(calls.filter((call) => call.includes('/clients'))).toEqual([]);
  });

  it('shows the pending-invitation badge only with the permission and the field, and never a zero', async () => {
    const { impl } = makeFetch({ clients: () => listResponse([padaria, academia, confeitaria]) });
    const { container } = renderClients(impl);
    await screen.findByText('Padaria Central');

    const cardOf = (name: string): HTMLElement => {
      const link = screen.getByRole('link', { name: `Abrir cliente ${name}` });
      const item = link.closest('li');
      if (item === null) throw new Error(`The card of ${name} was not rendered.`);
      return item;
    };
    expect(within(cardOf('Padaria Central')).getByText('convite pendente')).toBeTruthy();
    // `academia` travels without the field (no `cliente.convidar_usuario`): no badge, not even "0".
    expect(within(cardOf('Academia Corpo')).queryByText('convite pendente')).toBeNull();
    // `confeitaria` travels with the field and zero pending: still no badge.
    expect(within(cardOf('Confeitaria Doce')).queryByText('convite pendente')).toBeNull();
    expect(container.textContent).not.toContain('0 convites');
    cleanup();

    // The API omits the field for who cannot invite; if a response ever leaks it, the screen still
    // refuses the badge -- authorization answers to the permission, not to the payload.
    const leaked = makeFetch({ permissions: ['cliente.visualizar'], clients: () => listResponse([padaria]) });
    renderClients(leaked.impl);
    await screen.findByText('Padaria Central');
    expect(screen.queryByText('convite pendente')).toBeNull();
  });

  it('draws the indicator strip with no number at all', async () => {
    const { impl } = makeFetch();
    const { container } = renderClients(impl);
    await screen.findByText('Padaria Central');

    const strips = Array.from(container.querySelectorAll('.clients__indicators'));
    expect(strips).toHaveLength(2);
    for (const strip of strips) {
      expect(strip.textContent).toContain('pendentes');
      expect(strip.textContent).toContain('em revisão');
      expect(strip.textContent).toContain('atrasos');
      expect(strip.textContent).not.toMatch(/\d/);
    }
  });

  it('keeps the search term when there is no result and offers to clear it', async () => {
    const { impl } = makeFetch({
      clients: (query) => query.get('search') === 'padaria' ? listResponse([]) : listResponse([padaria, academia])
    });
    const { probe } = renderClients(impl);
    await screen.findByText('Padaria Central');

    fireEvent.change(searchBox(), { target: { value: 'padaria' } });

    expect(await screen.findByText('Nenhum cliente encontrado para "padaria"')).toBeTruthy();
    expect(searchBox().value).toBe('padaria');
    expect(probe.search).toContain('search=padaria');

    fireEvent.click(screen.getByRole('button', { name: 'Limpar busca' }));
    expect(await screen.findByText('Padaria Central')).toBeTruthy();
    expect(probe.search).not.toContain('search=');
    expect(searchBox().value).toBe('');
  });

  it('shows the empty roster with the create action only for who can create', async () => {
    const without = makeFetch({ permissions: ['cliente.visualizar'], clients: () => listResponse([]) });
    const withoutRender = renderClients(without.impl);
    await screen.findByText('Nenhum cliente ainda');
    expect(withoutRender.container.querySelector('.clients__empty')?.querySelector('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cadastrar cliente' })).toBeNull();
    cleanup();

    const withPermission = makeFetch({ clients: () => listResponse([]) });
    const withRender = renderClients(withPermission.impl);
    await screen.findByText('Nenhum cliente ainda');
    const empty = withRender.container.querySelector('.clients__empty');
    if (empty === null) throw new Error('The empty state was not rendered.');
    fireEvent.click(within(empty as HTMLElement).getByRole('button', { name: 'Cadastrar cliente' }));
    expect(await screen.findByRole('dialog', { name: 'Cadastrar cliente' })).toBeTruthy();
  });

  it('shows the archived empty state, distinct from the active one', async () => {
    const { impl } = makeFetch({ permissions: ['cliente.visualizar'], clients: () => listResponse([]) });
    renderClients(impl, `/agencia/${AGENCY_A}/clientes?status=archived`);

    expect(await screen.findByText('Nenhum cliente arquivado')).toBeTruthy();
    expect(screen.queryByText('Nenhum cliente ainda')).toBeNull();
  });

  it('draws a card-shaped skeleton on the first load', async () => {
    const { impl } = makeFetch({ clients: () => new Promise<Response>(() => undefined) });
    const { container } = renderClients(impl);

    await screen.findByRole('heading', { name: 'Clientes' });
    expect(container.querySelectorAll('.clients__card-skeleton')).toHaveLength(20);
  });

  it('offers a retry when the listing fails', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      clients: () => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500)
          : listResponse([padaria]);
      }
    });
    renderClients(impl);

    const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível carregar os clientes.');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await screen.findByText('Padaria Central');
  });

  it('opens the client detail from its card', async () => {
    const { impl } = makeFetch();
    const { probe } = renderClients(impl);

    fireEvent.click(await screen.findByRole('link', { name: 'Abrir cliente Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes/${padaria.id}/geral`));
    expect(screen.getByRole('heading', { name: 'Cliente' })).toBeTruthy();
  });

  it('renders an archived card dimmed and without any badge or indicator strip', async () => {
    const { impl } = makeFetch({
      clients: (query) => query.get('status') === 'archived' ? listResponse([barbearia]) : listResponse([padaria])
    });
    const { container } = renderClients(impl, `/agencia/${AGENCY_A}/clientes?status=archived`);

    await screen.findByText('Barbearia Lima');
    const card = container.querySelector('.clients__card');
    expect(card?.classList.contains('clients__card--archived')).toBe(true);
    // The archived client carries an open thread; the card must not show the triage badge anyway.
    expect(within(card as HTMLElement).queryByText('1 sugestão aguardando')).toBeNull();
    expect(container.querySelector('.clients__badge')).toBeNull();
    expect(container.querySelector('.clients__indicators')).toBeNull();
  });

  it('shows the photo when there is one and the initials when there is not', async () => {
    const { impl } = makeFetch();
    const { container } = renderClients(impl);

    await screen.findByText('Padaria Central');
    expect(screen.getByText('PC')).toBeTruthy();
    expect(container.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/academia.png');
  });

  it('renders a hostile client name as literal text, never as HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { impl } = makeFetch({ clients: () => listResponse([{ ...padaria, name: hostile }]) });
    const { container } = renderClients(impl);

    await screen.findByText(hostile);
    expect(container.querySelector('img')).toBeNull();
  });

  it('encodes the search value so it cannot smuggle another parameter', async () => {
    const hostile = 'a&status=archived';
    const { impl, calls } = makeFetch({ clients: () => listResponse([padaria]) });
    renderClients(impl, `/agencia/${AGENCY_A}/clientes?search=${encodeURIComponent(hostile)}`);

    await screen.findByText('Padaria Central');
    const listCall = calls.find((call) => call.startsWith('GET /agencies') && call.includes('/clients?'));
    expect(listCall).toBeDefined();
    const requested = new URL(`http://localhost${listCall!.slice(4)}`);
    expect(requested.searchParams.get('search')).toBe(hostile);
    expect(requested.searchParams.get('status')).toBeNull();
    expect(requested.searchParams.get('pageSize')).toBe('20');
  });

  it('returns to the last valid page when the URL points past the end (#229)', async () => {
    const { impl } = makeFetch({
      clients: (query) => {
        const page = Number(query.get('page') ?? '1');
        return page > 1 ? listResponse([], 2, { totalItems: 1, totalPages: 1 }) : listResponse([padaria]);
      }
    });
    const { probe } = renderClients(impl, `/agencia/${AGENCY_A}/clientes?page=2`);

    await screen.findByText('Padaria Central');
    await waitFor(() => expect(probe.search).not.toContain('page='));
    expect(screen.queryByText('Nenhum cliente ainda')).toBeNull();
  });

  it('never shows one agency\'s clients under another with the same cache', async () => {
    const { impl } = makeFetch({
      clients: (_query, agencyId) => listResponse(agencyId === AGENCY_B ? [barbearia] : [padaria])
    });
    const { container, probe } = renderClients(impl);

    await within(container).findByText('Padaria Central');
    await act(async () => { probe.navigate(`/agencia/${AGENCY_B}/clientes`); });

    await within(container).findByText('Barbearia Lima');
    expect(within(container).queryByText('Padaria Central')).toBeNull();
  });
});

describe('create client modal (#135)', () => {
  const openCreate = async (container: HTMLElement): Promise<HTMLElement> => {
    const header = container.querySelector('.clients__header');
    if (header === null) throw new Error('The clients header was not rendered.');
    fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Cadastrar cliente' }));
    return await screen.findByRole('dialog', { name: 'Cadastrar cliente' });
  };

  it('opens with only the name field and the complete-later hint', async () => {
    const { impl } = makeFetch();
    const { container } = renderClients(impl);
    await screen.findByText('Padaria Central');

    const dialog = await openCreate(container);
    expect(within(dialog).getByRole('textbox', { name: 'Nome' })).toBeTruthy();
    expect(within(dialog).getByText('Os demais dados você completa depois.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cadastrar' }).hasAttribute('disabled')).toBe(true);
    expect(dialog.querySelectorAll('input, select')).toHaveLength(1);
  });

  it('keeps Cadastrar disabled while the name is empty, including whitespace-only', async () => {
    const { impl } = makeFetch();
    const { container } = renderClients(impl);
    await screen.findByText('Padaria Central');
    const dialog = await openCreate(container);
    const name = within(dialog).getByRole('textbox', { name: 'Nome' });
    const submit = within(dialog).getByRole('button', { name: 'Cadastrar' });

    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(name, { target: { value: '   ' } });
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.change(name, { target: { value: 'Padaria Nova' } });
    expect(submit.hasAttribute('disabled')).toBe(false);
  });

  it('refuses an empty name even if the disabled button is bypassed, sending nothing', async () => {
    const { impl, calls } = makeFetch();
    const { container } = renderClients(impl);
    await screen.findByText('Padaria Central');
    const dialog = await openCreate(container);
    const form = dialog.querySelector('form');
    if (form === null) throw new Error('The create form was not rendered.');

    fireEvent.submit(form);
    expect(await within(dialog).findByText('Informe o nome do cliente.')).toBeTruthy();
    expect(calls.some((call) => call.startsWith('POST /agencies/'))).toBe(false);
  });

  it('sends the name and, on 201, opens the new client\'s detail, closing the modal', async () => {
    const bodies: unknown[] = [];
    let clients: unknown[] = [padaria];
    const { impl, calls } = makeFetch({
      clients: () => listResponse(clients),
      createClient: (body) => {
        const name = (body as { name: string }).name;
        bodies.push(body);
        // The listing carries the eight list fields, not the full registration (SPEC section 6).
        clients = [...clients, {
          id: createdClient.id,
          name,
          photoUrl: null,
          instagramHandle: null,
          status: 'active',
          closingDate: null,
          threadsAwaitingAgency: 0
        }];
        return json({ ...createdClient, name }, 201);
      }
    });
    const { container, probe } = renderClients(impl);
    await screen.findByText('Padaria Central');
    const dialog = await openCreate(container);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nome' }), { target: { value: 'Padaria Nova' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cadastrar' }));

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes/${createdClient.id}/geral`));
    expect(bodies).toEqual([{ name: 'Padaria Nova' }]);
    expect(calls).toContain(`POST /agencies/${AGENCY_A}/clients`);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('refreshes the roster after the creation without a reload', async () => {
    let clients: unknown[] = [padaria];
    const { impl } = makeFetch({
      clients: () => listResponse(clients),
      createClient: (body) => {
        const name = (body as { name: string }).name;
        clients = [...clients, {
          id: createdClient.id,
          name,
          photoUrl: null,
          instagramHandle: null,
          status: 'active',
          closingDate: null,
          threadsAwaitingAgency: 0
        }];
        return json({ ...createdClient, name }, 201);
      }
    });
    const { container, probe } = renderClients(impl);
    await screen.findByText('Padaria Central');
    const dialog = await openCreate(container);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nome' }), { target: { value: 'Padaria Nova' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes/${createdClient.id}/geral`));

    // The creation invalidated the roster: going back shows the new client without a reload.
    fireEvent.click(screen.getByRole('link', { name: '← Clientes' }));
    expect(await screen.findByText('Padaria Nova')).toBeTruthy();
  });

  it('submits the form itself, so the browser\'s Enter in the field sends the name', async () => {
    // jsdom does not implement implicit form submission, so the test dispatches the very submit
    // event the browser fires when Enter is pressed in the single field.
    const bodies: unknown[] = [];
    const { impl } = makeFetch({
      createClient: (body) => {
        bodies.push(body);
        return json({ ...createdClient, name: (body as { name: string }).name }, 201);
      }
    });
    const { container } = renderClients(impl);
    await screen.findByText('Padaria Central');
    const dialog = await openCreate(container);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nome' }), { target: { value: 'Padaria Nova' } });
    const form = dialog.querySelector('form');
    if (form === null) throw new Error('The create form was not rendered.');

    fireEvent.submit(form);
    await waitFor(() => expect(bodies).toEqual([{ name: 'Padaria Nova' }]));
  });

  it('shows the name-in-use message on the field on a 409, preserving the typed value', async () => {
    const { impl } = makeFetch({
      createClient: () => json({ error: { code: 'CLIENT_NAME_IN_USE', message: 'private diagnostic' } }, 409)
    });
    const { container, probe } = renderClients(impl);
    await screen.findByText('Padaria Central');
    const dialog = await openCreate(container);
    const name = within(dialog).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Padaria Central' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cadastrar' }));

    const error = await within(dialog).findByText('Já existe um cliente ativo com este nome.');
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
    expect(name.value).toBe('Padaria Central');
    expect(dialog.textContent).not.toContain('private diagnostic');
    expect(screen.getByRole('dialog', { name: 'Cadastrar cliente' })).toBe(dialog);
    expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes`);
  });

  it('marks the name field when the API refuses the name on a 400', async () => {
    const { impl } = makeFetch({
      createClient: () => json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'private diagnostic',
          details: { issues: [{ path: 'name', code: 'custom', message: 'private issue message' }] }
        }
      }, 400)
    });
    const { container } = renderClients(impl);
    await screen.findByText('Padaria Central');
    const dialog = await openCreate(container);
    const name = within(dialog).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Padaria Nova' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cadastrar' }));

    expect(await within(dialog).findByText('O nome contém caracteres que não são aceitos.')).toBeTruthy();
    expect(name.value).toBe('Padaria Nova');
    expect(dialog.textContent).not.toContain('private');
  });

  it('keeps a server error inside the modal with the typed value, and allows trying again', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      createClient: (body) => {
        attempts += 1;
        if (attempts === 1) return json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500);
        return json({ ...createdClient, name: (body as { name: string }).name }, 201);
      }
    });
    const { container, probe } = renderClients(impl);
    await screen.findByText('Padaria Central');
    const dialog = await openCreate(container);
    const name = within(dialog).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Padaria Nova' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cadastrar' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível cadastrar o cliente. Tente de novo.');
    expect(dialog.textContent).not.toContain('private diagnostic');
    expect(name.value).toBe('Padaria Nova');
    expect(screen.getByRole('dialog', { name: 'Cadastrar cliente' })).toBe(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cadastrar' }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes/${createdClient.id}/geral`));
    expect(attempts).toBe(2);
  });
});
