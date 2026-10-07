// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { agencyToday } from './client-lifecycle.js';
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
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const ARCHIVED_AT = '2026-10-07T12:00:00.000Z';
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const agencyMe = (permissions: readonly string[]) => ({
  agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: false, role: { key: 'admin', name: 'Admin' }, permissions
});

const ADMIN_PERMISSIONS = ['cliente.visualizar', 'cliente.operar', 'cliente.cadastrar', 'cliente.arquivar', 'cliente.convidar_usuario', 'cliente.remover_usuario'];
const MANAGER_PERMISSIONS = ['cliente.visualizar', 'cliente.operar', 'cliente.cadastrar'];

const padaria = {
  id: CLIENT_ID,
  name: 'Padaria Central',
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
  closingDate: null as string | null,
  archivedAt: null as string | null,
  summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 0 }
};
const archivedClient = { ...padaria, status: 'archived', archivedAt: ARCHIVED_AT };

const registrationOf = (client: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(client).filter(([key]) => key !== 'summary'));

const listItemOf = (client: Record<string, unknown>): Record<string, unknown> => ({
  id: client.id,
  name: client.name,
  photoUrl: null,
  instagramHandle: null,
  status: client.status,
  closingDate: client.closingDate,
  threadsAwaitingAgency: 0,
  pendingInvitations: 0
});

const pageOf = (data: unknown[]) => ({ data, meta: { page: 1, pageSize: 20, totalItems: data.length, totalPages: data.length === 0 ? 0 : 1 } });

interface Scenario {
  readonly permissions?: readonly string[];
  readonly client?: () => Response | Promise<Response>;
  readonly clients?: () => Response | Promise<Response>;
  readonly members?: (status: string | null) => Response | Promise<Response>;
  readonly invitations?: () => Response | Promise<Response>;
  readonly putClosing?: (body: unknown) => Response | Promise<Response>;
  readonly deleteClosing?: () => Response | Promise<Response>;
  readonly archive?: () => Response | Promise<Response>;
  readonly reactivate?: () => Response | Promise<Response>;
}

const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const permissions = scenario.permissions ?? ADMIN_PERMISSIONS;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (path.endsWith('/auth/session')) return json(sessionBody);
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(permissions));
    const clients = /\/agencies\/([^/]+)\/clients$/.exec(path);
    if (clients !== null) return scenario.clients?.() ?? json(pageOf([listItemOf(padaria)]));
    const members = /\/agencies\/([^/]+)\/clients\/([^/]+)\/members$/.exec(path);
    if (members !== null) return scenario.members?.(url.searchParams.get('status')) ?? json(pageOf([]));
    const invitations = /\/agencies\/([^/]+)\/clients\/([^/]+)\/invitations$/.exec(path);
    if (invitations !== null) return scenario.invitations?.() ?? json(pageOf([]));
    const closing = /\/agencies\/([^/]+)\/clients\/([^/]+)\/closing$/.exec(path);
    if (closing !== null) {
      if (method === 'PUT') {
        if (scenario.putClosing === undefined) throw new Error(`unexpected PUT ${url}`);
        return scenario.putClosing(JSON.parse(String(init?.body)));
      }
      if (method === 'DELETE') {
        if (scenario.deleteClosing === undefined) throw new Error(`unexpected DELETE ${url}`);
        return scenario.deleteClosing();
      }
    }
    if (/\/clients\/([^/]+)\/archive$/.test(path) && method === 'POST') {
      if (scenario.archive === undefined) throw new Error(`unexpected POST ${url}`);
      return scenario.archive();
    }
    if (/\/clients\/([^/]+)\/reactivate$/.test(path) && method === 'POST') {
      if (scenario.reactivate === undefined) throw new Error(`unexpected POST ${url}`);
      return scenario.reactivate();
    }
    const detail = /\/agencies\/([^/]+)\/clients\/([^/]+)$/.exec(path);
    if (detail !== null) return scenario.client?.() ?? (detail[2] === CLIENT_ID ? json(padaria) : json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404));
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
const rosterUrl = `/agencia/${AGENCY_A}/clientes`;

const renderLifecycle = (impl: typeof fetch, entry = clientUrl()) => {
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

const openMenu = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Ações do cliente' }));
};

const openClosingDialog = async (): Promise<HTMLElement> => {
  await openMenu();
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Encerrar contrato…' }));
  return await screen.findByRole('dialog', { name: `Encerrar contrato de ${padaria.name}` });
};

const openArchiveDialog = async (): Promise<HTMLElement> => {
  await openMenu();
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Arquivar agora…' }));
  return await screen.findByRole('dialog', { name: `Arquivar ${padaria.name} agora?` });
};

const dayMonthOf = (date: string): string => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

describe('client lifecycle actions (#139)', () => {
  it('shows the ⋯ only for cliente.arquivar, and Reativar as the only action on an archived client', async () => {
    const manager = makeFetch({ permissions: MANAGER_PERMISSIONS });
    renderLifecycle(manager.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: 'Ações do cliente' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reativar' })).toBeNull();
    cleanup();

    const admin = makeFetch();
    renderLifecycle(admin.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByRole('button', { name: 'Ações do cliente' })).toBeTruthy();
    cleanup();

    const archivedAdmin = makeFetch({ client: () => json(archivedClient) });
    renderLifecycle(archivedAdmin.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ações do cliente' })).toBeNull();
    cleanup();

    const archivedManager = makeFetch({ permissions: MANAGER_PERMISSIONS, client: () => json(archivedClient) });
    renderLifecycle(archivedManager.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByRole('button', { name: 'Reativar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ações do cliente' })).toBeNull();
  });

  it('shows the lifecycle controls for cliente.arquivar without cliente.operar, and never Editar', async () => {
    const ARCHIVIST_PERMISSIONS = ['cliente.visualizar', 'cliente.arquivar'];
    const active = makeFetch({ permissions: ARCHIVIST_PERMISSIONS });
    renderLifecycle(active.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByRole('button', { name: 'Ações do cliente' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    cleanup();

    const archived = makeFetch({ permissions: ARCHIVIST_PERMISSIONS, client: () => json(archivedClient) });
    renderLifecycle(archived.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ações do cliente' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
  });

  it('opens the closing dialog with the date floor in the agency timezone, the hint and the exact labels', async () => {
    // 01:30 UTC is 22:30 of the previous day in São Paulo: with the clock pinned there, a UTC
    // slice would answer 2026-10-08 and the floor below goes red (the `new Date().toISOString()`
    // mutation). A test that read the real clock would only catch that after 21h in São Paulo.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-08T01:30:00Z'));
    try {
      const { impl } = makeFetch();
      renderLifecycle(impl);
      await screen.findByRole('heading', { name: 'Padaria Central' });
      await openMenu();
      // Without a scheduled closing there is nothing to clear, so the item does not exist.
      expect(screen.getByRole('menuitem', { name: 'Encerrar contrato…' })).toBeTruthy();
      expect(screen.queryByRole('menuitem', { name: 'Desmarcar encerramento' })).toBeNull();
      expect(screen.getByRole('menuitem', { name: 'Arquivar agora…' })).toBeTruthy();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Encerrar contrato…' }));
      const dialog = await screen.findByRole('dialog', { name: `Encerrar contrato de ${padaria.name}` });

      expect(within(dialog).getByLabelText('Último dia do contrato')).toBeTruthy();
      expect(within(dialog).getByText('Até essa data tudo continua funcionando, inclusive o portal do cliente. No dia seguinte o cliente é arquivado automaticamente. Você pode desmarcar até lá.')).toBeTruthy();
      expect(within(dialog).getByRole('button', { name: 'Agendar encerramento' })).toBeTruthy();
      expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toBeTruthy();
      // The selector cannot offer a day before the agency's today (the API refuses it too).
      expect((within(dialog).getByLabelText('Último dia do contrato') as HTMLInputElement).min).toBe('2026-10-07');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a date before today on the field, sending nothing', async () => {
    const { impl, calls } = makeFetch();
    renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openClosingDialog();

    fireEvent.change(within(dialog).getByLabelText('Último dia do contrato'), { target: { value: '2020-01-01' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));

    expect(await within(dialog).findByText('A data precisa ser hoje ou depois.')).toBeTruthy();
    expect(calls.some((call) => call.startsWith('PUT'))).toBe(false);
    expect((within(dialog).getByLabelText('Último dia do contrato') as HTMLInputElement).value).toBe('2020-01-01');
  });

  it('requires the last day on the field, sending nothing', async () => {
    const { impl, calls } = makeFetch();
    renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openClosingDialog();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));

    expect(await within(dialog).findByText('Informe o último dia do contrato.')).toBeTruthy();
    expect(calls.some((call) => call.startsWith('PUT'))).toBe(false);
    const input = within(dialog).getByLabelText('Último dia do contrato') as HTMLInputElement;
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('maps the server refusal of a past date to the field, keeping the typed value', async () => {
    const { impl, calls } = makeFetch({
      putClosing: () => json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: { issues: [{ path: 'closingDate', code: 'custom', message: 'private issue message' }] }
        }
      }, 400)
    });
    renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openClosingDialog();
    const input = within(dialog).getByLabelText('Último dia do contrato') as HTMLInputElement;

    // The client passes it (today) and the server refuses: the message lands on the field.
    fireEvent.change(input, { target: { value: agencyToday() } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));

    // The PUT left: the message below proves the server's answer, not the client's guard.
    await waitFor(() => expect(calls).toContain(`PUT /agencies/${AGENCY_A}/clients/${CLIENT_ID}/closing`));
    expect(await within(dialog).findByText('A data precisa ser hoje ou depois.')).toBeTruthy();
    expect(input.value).toBe(agencyToday());
    expect(dialog.textContent).not.toContain('private issue message');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('maps a 400 without the closingDate issue to the form message, keeping the dialog open', async () => {
    const { impl } = makeFetch({
      putClosing: () => json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: { issues: [{ path: 'other', code: 'custom', message: 'private issue message' }] }
        }
      }, 400)
    });
    renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openClosingDialog();
    fireEvent.change(within(dialog).getByLabelText('Último dia do contrato'), { target: { value: agencyToday() } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));

    expect(await within(dialog).findByText('Revise os dados informados.')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: `Encerrar contrato de ${padaria.name}` })).toBe(dialog);
    expect(dialog.textContent).not.toContain('private issue message');
  });

  it('maps the 403 of the closing and of the clearing to the permission message', async () => {
    const forbidden = { error: { code: 'FORBIDDEN', message: 'private diagnostic' } };
    const closing403 = makeFetch({ putClosing: () => json(forbidden, 403) });
    renderLifecycle(closing403.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openClosingDialog();
    fireEvent.change(within(dialog).getByLabelText('Último dia do contrato'), { target: { value: agencyToday() } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));
    expect(await within(dialog).findByText('Você não tem permissão para alterar este cliente.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
    cleanup();

    const clearing403 = makeFetch({
      client: () => json({ ...padaria, closingDate: '2026-10-30' }),
      deleteClosing: () => json(forbidden, 403)
    });
    renderLifecycle(clearing403.impl);
    await screen.findByText('encerra em 30/10');
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desmarcar encerramento' }));
    expect(await screen.findByText('Você não tem permissão para alterar este cliente.')).toBeTruthy();
    expect(screen.queryByText('private diagnostic')).toBeNull();
  });

  it('maps the generic failures of clearing and of reactivating to their retry messages', async () => {
    const internal = { error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } };
    const clearing500 = makeFetch({
      client: () => json({ ...padaria, closingDate: '2026-10-30' }),
      deleteClosing: () => json(internal, 500)
    });
    renderLifecycle(clearing500.impl);
    await screen.findByText('encerra em 30/10');
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desmarcar encerramento' }));
    expect(await screen.findByText('Não foi possível desmarcar o encerramento. Tente de novo.')).toBeTruthy();
    expect(screen.queryByText('private diagnostic')).toBeNull();
    cleanup();

    const reactivating500 = makeFetch({ client: () => json(archivedClient), reactivate: () => json(internal, 500) });
    renderLifecycle(reactivating500.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    fireEvent.click(await screen.findByRole('button', { name: 'Reativar' }));
    expect(await screen.findByText('Não foi possível reativar o cliente. Tente de novo.')).toBeTruthy();
    expect(screen.queryByText('private diagnostic')).toBeNull();
    expect(screen.getByText(/Cliente arquivado em/)).toBeTruthy();
  });

  it('says the client is already active on CLIENT_NOT_ARCHIVED, from the clearing and from the reactivating', async () => {
    const alreadyActive = { error: { code: 'CLIENT_NOT_ARCHIVED', message: 'private diagnostic' } };
    const clearing = makeFetch({
      client: () => json({ ...padaria, closingDate: '2026-10-30' }),
      deleteClosing: () => json(alreadyActive, 409)
    });
    renderLifecycle(clearing.impl);
    await screen.findByText('encerra em 30/10');
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desmarcar encerramento' }));
    expect(await screen.findByText('Este cliente já está ativo.')).toBeTruthy();
    expect(screen.queryByText('private diagnostic')).toBeNull();
    cleanup();

    const reactivating = makeFetch({ client: () => json(archivedClient), reactivate: () => json(alreadyActive, 409) });
    renderLifecycle(reactivating.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    fireEvent.click(await screen.findByRole('button', { name: 'Reativar' }));
    expect(await screen.findByText('Este cliente já está ativo.')).toBeTruthy();
    expect(screen.queryByText('private diagnostic')).toBeNull();
  });

  it('shows the API message when reactivating hits a name conflict, changing nothing', async () => {
    const { impl } = makeFetch({
      client: () => json(archivedClient),
      reactivate: () => json({
        error: {
          code: 'CLIENT_NAME_IN_USE',
          message: 'Já existe um cliente ativo com este nome. Renomeie um dos dois antes de reativar.'
        }
      }, 409)
    });
    renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });

    fireEvent.click(screen.getByRole('button', { name: 'Reativar' }));
    expect(await screen.findByText('Já existe um cliente ativo com este nome. Renomeie um dos dois antes de reativar.')).toBeTruthy();
    // The client stays archived: the banner and the read-only header do not move.
    expect(screen.getByText(`Cliente arquivado em ${dayMonthOf(ARCHIVED_AT.slice(0, 10))}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeTruthy();
  });

  it('schedules the closing and shows both badges without a reload', async () => {
    const target = agencyToday();
    let current: typeof padaria = { ...padaria };
    let detailGets = 0;
    const { impl, calls } = makeFetch({
      clients: () => json(pageOf([listItemOf(current)])),
      client: () => { detailGets += 1; return json(current); },
      putClosing: (body) => {
        current = { ...current, closingDate: (body as { closingDate: string }).closingDate };
        return json(registrationOf(current));
      }
    });
    const { probe } = renderLifecycle(impl, rosterUrl);
    await screen.findByText('Padaria Central');
    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.queryByText(/encerra em/)).toBeNull();
    expect(detailGets).toBe(1);

    const dialog = await openClosingDialog();
    fireEvent.change(within(dialog).getByLabelText('Último dia do contrato'), { target: { value: target } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));

    // The dialog closes over the updated header: the exact badge appears without a reload.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(`encerra em ${dayMonthOf(target)}`)).toBeTruthy();
    expect(calls).toContain(`PUT /agencies/${AGENCY_A}/clients/${CLIENT_ID}/closing`);
    // The detail itself was invalidated and read back from the server, not only patched in cache.
    await waitFor(() => expect(detailGets).toBe(2));
    // The roster behind carries the badge too, from the invalidated list.
    fireEvent.click(screen.getByRole('link', { name: '← Clientes' }));
    const card = await screen.findByRole('link', { name: 'Padaria Central' });
    await waitFor(() => expect(within(card).getByText(`encerra em ${dayMonthOf(target)}`)).toBeTruthy());
  });

  it('clears the scheduled closing from the menu, removing both badges', async () => {
    let current: typeof padaria = { ...padaria, closingDate: '2026-10-30' };
    let detailGets = 0;
    const { impl } = makeFetch({
      clients: () => json(pageOf([listItemOf(current)])),
      client: () => { detailGets += 1; return json(current); },
      deleteClosing: () => { current = { ...current, closingDate: null }; return json(registrationOf(current)); }
    });
    const { probe } = renderLifecycle(impl, rosterUrl);
    await screen.findByText('Padaria Central');
    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
    expect(await screen.findByText('encerra em 30/10')).toBeTruthy();
    expect(detailGets).toBe(1);

    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desmarcar encerramento' }));

    // No extra confirmation: the badge leaves the header as the menu closes.
    await waitFor(() => expect(screen.queryByText('encerra em 30/10')).toBeNull());
    expect(screen.queryByRole('menu')).toBeNull();
    // The detail was invalidated and read back from the server.
    await waitFor(() => expect(detailGets).toBe(2));
    fireEvent.click(screen.getByRole('link', { name: '← Clientes' }));
    const card = await screen.findByRole('link', { name: 'Padaria Central' });
    await waitFor(() => expect(within(card).queryByText(/encerra em/)).toBeNull());
  });

  it('archives with the three effects spelled out, leaving the detail read-only with Reativar', async () => {
    let current: typeof padaria = { ...padaria };
    let membersGets = 0;
    let invitationsGets = 0;
    let detailGets = 0;
    const { impl, calls } = makeFetch({
      clients: () => json(pageOf(current.status === 'active' ? [listItemOf(current)] : [])),
      client: () => { detailGets += 1; return json(current); },
      members: (status) => { if (status !== 'removed') membersGets += 1; return json(pageOf([])); },
      invitations: () => { invitationsGets += 1; return json(pageOf([])); },
      archive: () => {
        current = { ...current, status: 'archived', archivedAt: ARCHIVED_AT, closingDate: null };
        return json(registrationOf(current));
      }
    });
    const { probe } = renderLifecycle(impl, rosterUrl);
    await screen.findByText('Padaria Central');
    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(detailGets).toBe(1);

    // Visiting Acessos once proves the archive invalidates its lists too.
    fireEvent.click(screen.getByRole('link', { name: 'Acessos' }));
    await screen.findByRole('heading', { name: 'Pessoas com acesso ao portal' });
    expect(membersGets).toBe(1);
    expect(invitationsGets).toBe(1);
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    await screen.findByRole('heading', { name: 'Padaria Central' });

    const dialog = await openArchiveDialog();
    expect(within(dialog).getByText('O portal deixa de funcionar para as pessoas do cliente imediatamente.')).toBeTruthy();
    expect(within(dialog).getByText('Convites de portal pendentes são cancelados.')).toBeTruthy();
    expect(within(dialog).getByText('Nada é apagado. Reativar devolve o acesso a quem já tinha.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arquivar' }));

    // Read-only header: the banner, no Editar, no ⋯, and Reativar as the only action.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Cliente arquivado em 07/10')).toBeTruthy();
    expect(screen.getByText('Arquivado')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ações do cliente' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reativar' })).toBeTruthy();
    expect(calls).toContain(`POST /agencies/${AGENCY_A}/clients/${CLIENT_ID}/archive`);
    // The detail was invalidated and read back from the server.
    await waitFor(() => expect(detailGets).toBe(2));

    // Acessos and Convites were invalidated: revisiting refetches both (the cache would be fresh).
    fireEvent.click(screen.getByRole('link', { name: 'Acessos' }));
    await screen.findByRole('heading', { name: 'Pessoas com acesso ao portal' });
    expect(membersGets).toBe(2);
    await waitFor(() => expect(invitationsGets).toBe(2));

    // The roster behind lost the client from the default list.
    fireEvent.click(screen.getByRole('link', { name: '← Clientes' }));
    await screen.findByText('Nenhum cliente ainda');
    expect(screen.queryByText('Padaria Central')).toBeNull();
  });

  it('reactivates an archived client, bringing it back to the roster', async () => {
    let current: typeof padaria = { ...archivedClient };
    let detailGets = 0;
    const { impl, calls } = makeFetch({
      clients: () => json(pageOf(current.status === 'active' ? [listItemOf(current)] : [])),
      client: () => { detailGets += 1; return json(current); },
      reactivate: () => { current = { ...current, status: 'active', archivedAt: null }; return json(registrationOf(current)); }
    });
    const { probe } = renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(screen.getByText(/Cliente arquivado em/)).toBeTruthy();
    expect(detailGets).toBe(1);

    fireEvent.click(await screen.findByRole('button', { name: 'Reativar' }));
    await waitFor(() => expect(screen.queryByText(/Cliente arquivado/)).toBeNull());
    expect(await screen.findByRole('button', { name: 'Editar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ações do cliente' })).toBeTruthy();
    expect(calls).toContain(`POST /agencies/${AGENCY_A}/clients/${CLIENT_ID}/reactivate`);
    // The detail was invalidated and read back from the server.
    await waitFor(() => expect(detailGets).toBe(2));

    fireEvent.click(screen.getByRole('link', { name: '← Clientes' }));
    const card = await screen.findByRole('link', { name: 'Padaria Central' });
    expect(within(card).getByText('Padaria Central')).toBeTruthy();
    expect(probe.pathname).toBe(rosterUrl);
  });

  it('keeps the roster query of the address after archiving from a filtered page', async () => {
    const filteredRoster = `/agencia/${AGENCY_A}/clientes?status=active&page=2`;
    let current: typeof padaria = { ...padaria };
    const { impl } = makeFetch({
      clients: () => json({ data: [listItemOf(current)], meta: { page: 2, pageSize: 20, totalItems: 21, totalPages: 2 } }),
      client: () => json(current),
      archive: () => {
        current = { ...current, status: 'archived', archivedAt: ARCHIVED_AT, closingDate: null };
        return json(registrationOf(current));
      }
    });
    const { probe } = renderLifecycle(impl, filteredRoster);
    await screen.findByText('Padaria Central');
    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));
    await screen.findByRole('heading', { name: 'Padaria Central' });

    const dialog = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arquivar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // The way back is the address the roster handed over, query included.
    const back = screen.getByRole('link', { name: '← Clientes' });
    expect(back.getAttribute('href')).toBe(filteredRoster);
    fireEvent.click(back);
    await waitFor(() => expect(probe.search).toBe('?status=active&page=2'));
  });

  it('keeps the roster query of the address after reactivating from a filtered page', async () => {
    const filteredRoster = `/agencia/${AGENCY_A}/clientes?status=archived&page=2`;
    let current: typeof padaria = { ...archivedClient };
    const { impl } = makeFetch({
      clients: () => json({ data: [listItemOf(current)], meta: { page: 2, pageSize: 20, totalItems: 21, totalPages: 2 } }),
      client: () => json(current),
      reactivate: () => { current = { ...current, status: 'active', archivedAt: null }; return json(registrationOf(current)); }
    });
    const { probe } = renderLifecycle(impl, filteredRoster);
    await screen.findByText('Padaria Central');
    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(clientUrl()));

    fireEvent.click(await screen.findByRole('button', { name: 'Reativar' }));
    await waitFor(() => expect(screen.queryByText(/Cliente arquivado/)).toBeNull());

    const back = screen.getByRole('link', { name: '← Clientes' });
    expect(back.getAttribute('href')).toBe(filteredRoster);
    fireEvent.click(back);
    await waitFor(() => expect(probe.search).toBe('?status=archived&page=2'));
  });

  it('keeps the archive dialog open on a server error and lets the same click retry', async () => {
    let attempts = 0;
    let current: typeof padaria = { ...padaria };
    const { impl } = makeFetch({
      clients: () => json(pageOf(current.status === 'active' ? [listItemOf(current)] : [])),
      client: () => json(current),
      archive: () => {
        attempts += 1;
        if (attempts === 1) return json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500);
        current = { ...current, status: 'archived', archivedAt: ARCHIVED_AT, closingDate: null };
        return json(registrationOf(current));
      }
    });
    renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arquivar' }));

    expect(await within(dialog).findByText('Não foi possível arquivar o cliente. Tente de novo.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
    expect(screen.getByRole('dialog', { name: `Arquivar ${padaria.name} agora?` })).toBe(dialog);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Arquivar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(attempts).toBe(2);
    expect(await screen.findByText('Cliente arquivado em 07/10')).toBeTruthy();
  });

  it('refreshes the stale detail when the server refuses the closing for an archived client', async () => {
    let current: typeof padaria = { ...padaria };
    let detailGets = 0;
    const { impl } = makeFetch({
      client: () => { detailGets += 1; return json(current); },
      putClosing: () => {
        current = { ...current, status: 'archived', archivedAt: ARCHIVED_AT, closingDate: null };
        return json({ error: { code: 'CLIENT_ARCHIVED', message: 'private diagnostic' } }, 409);
      }
    });
    renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openClosingDialog();
    fireEvent.change(within(dialog).getByLabelText('Último dia do contrato'), { target: { value: agencyToday() } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));

    expect(await within(dialog).findByText('Cliente arquivado: a única ação possível é reativar.')).toBeTruthy();
    // The detail was refetched: the header now offers exactly what the message points to.
    await waitFor(() => expect(detailGets).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reativar' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Ações do cliente' })).toBeNull();
  });

  it('refreshes the stale detail when the server says the client is already active', async () => {
    let current: typeof padaria = { ...archivedClient };
    let detailGets = 0;
    const { impl } = makeFetch({
      client: () => { detailGets += 1; return json(current); },
      reactivate: () => {
        current = { ...current, status: 'active', archivedAt: null };
        return json({ error: { code: 'CLIENT_NOT_ARCHIVED', message: 'private diagnostic' } }, 409);
      }
    });
    renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    fireEvent.click(await screen.findByRole('button', { name: 'Reativar' }));

    expect(await screen.findByText('Este cliente já está ativo.')).toBeTruthy();
    await waitFor(() => expect(detailGets).toBe(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Editar' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Reativar' })).toBeNull();
  });

  it('refreshes the stale detail when the closing to clear is already gone', async () => {
    let current: typeof padaria = { ...padaria, closingDate: '2026-10-30' };
    let detailGets = 0;
    const { impl } = makeFetch({
      client: () => { detailGets += 1; return json(current); },
      deleteClosing: () => {
        current = { ...current, closingDate: null };
        return json({ error: { code: 'CLOSING_DATE_NOT_SET', message: 'private diagnostic' } }, 409);
      }
    });
    renderLifecycle(impl);
    await screen.findByText('encerra em 30/10');
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desmarcar encerramento' }));

    expect(await screen.findByText('Este cliente não tem encerramento agendado.')).toBeTruthy();
    await waitFor(() => expect(detailGets).toBe(2));
    await waitFor(() => expect(screen.queryByText('encerra em 30/10')).toBeNull());
  });

  it('keeps the closing dialog open on a server error, preserving the date for the retry', async () => {
    const target = agencyToday();
    let attempts = 0;
    let current: typeof padaria = { ...padaria };
    const { impl } = makeFetch({
      client: () => json(current),
      putClosing: (body) => {
        attempts += 1;
        if (attempts === 1) return json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500);
        current = { ...current, closingDate: (body as { closingDate: string }).closingDate };
        return json(registrationOf(current));
      }
    });
    renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openClosingDialog();
    const input = within(dialog).getByLabelText('Último dia do contrato') as HTMLInputElement;

    fireEvent.change(input, { target: { value: target } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));
    expect(await within(dialog).findByText('Não foi possível agendar o encerramento. Tente de novo.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
    expect(input.value).toBe(target);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(attempts).toBe(2);
    expect(await screen.findByText(`encerra em ${dayMonthOf(target)}`)).toBeTruthy();
  });

  it('maps the closing refusal of an archived client and a missing closing on the field', async () => {
    const archived409 = makeFetch({ putClosing: () => json({ error: { code: 'CLIENT_ARCHIVED', message: 'private diagnostic' } }, 409) });
    renderLifecycle(archived409.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openClosingDialog();
    fireEvent.change(within(dialog).getByLabelText('Último dia do contrato'), { target: { value: agencyToday() } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));
    expect(await within(dialog).findByText('Cliente arquivado: a única ação possível é reativar.')).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
    cleanup();

    const notSet = makeFetch({
      client: () => json({ ...padaria, closingDate: '2026-10-30' }),
      deleteClosing: () => json({ error: { code: 'CLOSING_DATE_NOT_SET', message: 'private diagnostic' } }, 409)
    });
    renderLifecycle(notSet.impl);
    await screen.findByText('encerra em 30/10');
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Desmarcar encerramento' }));
    expect(await screen.findByText('Este cliente não tem encerramento agendado.')).toBeTruthy();
    expect(screen.queryByText('private diagnostic')).toBeNull();
  });

  it('shows the busy state on the archive confirmation while the request is in flight', async () => {
    let resolveArchive: ((response: Response) => void) | undefined;
    const pendingArchive = new Promise<Response>((resolve) => { resolveArchive = resolve; });
    const { impl } = makeFetch({ archive: () => pendingArchive });
    renderLifecycle(impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openArchiveDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arquivar' }));

    const busy = within(dialog).getByRole('button', { name: 'Arquivar' });
    await waitFor(() => expect(busy.hasAttribute('aria-busy')).toBe(true));
    expect(busy.hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'Cancelar' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('dialog', { name: `Arquivar ${padaria.name} agora?` })).toBe(dialog);

    await act(async () => { resolveArchive?.(json({ ...registrationOf(padaria), status: 'archived', archivedAt: ARCHIVED_AT })); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the busy state on the closing confirmation and on Reativar', async () => {
    let resolveClosing: ((response: Response) => void) | undefined;
    const pendingClosing = new Promise<Response>((resolve) => { resolveClosing = resolve; });
    const closing = makeFetch({ putClosing: () => pendingClosing });
    renderLifecycle(closing.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    const dialog = await openClosingDialog();
    fireEvent.change(within(dialog).getByLabelText('Último dia do contrato'), { target: { value: agencyToday() } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agendar encerramento' }));

    const schedule = within(dialog).getByRole('button', { name: 'Agendar encerramento' });
    await waitFor(() => expect(schedule.hasAttribute('aria-busy')).toBe(true));
    expect(schedule.hasAttribute('disabled')).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'Cancelar' }).hasAttribute('disabled')).toBe(true);
    await act(async () => { resolveClosing?.(json({ ...registrationOf(padaria), closingDate: agencyToday() })); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    cleanup();

    let resolveReactivate: ((response: Response) => void) | undefined;
    const pendingReactivate = new Promise<Response>((resolve) => { resolveReactivate = resolve; });
    let reactivated: typeof padaria = { ...archivedClient };
    const reactivating = makeFetch({ client: () => json(reactivated), reactivate: () => pendingReactivate });
    renderLifecycle(reactivating.impl);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    fireEvent.click(screen.getByRole('button', { name: 'Reativar' }));

    const reactivateButton = screen.getByRole('button', { name: 'Reativar' });
    await waitFor(() => expect(reactivateButton.hasAttribute('aria-busy')).toBe(true));
    expect(reactivateButton.hasAttribute('disabled')).toBe(true);
    await act(async () => {
      reactivated = { ...reactivated, status: 'active', archivedAt: null };
      resolveReactivate?.(json(registrationOf(reactivated)));
    });
    await waitFor(() => expect(screen.queryByText(/Cliente arquivado/)).toBeNull());
  });
});

describe('agencyToday (#139)', () => {
  it.each([
    // 01:30 UTC is 22:30 of the previous day in São Paulo: the agency's day, not the UTC slice.
    ['2026-10-08T01:30:00.000Z', '2026-10-07'],
    ['2026-10-07T12:00:00.000Z', '2026-10-07'],
    ['2026-10-07T02:59:59.000Z', '2026-10-06']
  ])('reads %s as %s in São Paulo', (instant, expected) => {
    expect(agencyToday(new Date(instant))).toBe(expected);
  });
});
