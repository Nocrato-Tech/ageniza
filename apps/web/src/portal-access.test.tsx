// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const DAY_MS = 24 * 60 * 60 * 1000;
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });

const agencyMe = (permissions: readonly string[]) => ({
  agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: false, role: { key: 'admin', name: 'Admin' }, permissions
});

const ADMIN_PERMISSIONS = ['cliente.visualizar', 'cliente.operar', 'cliente.cadastrar', 'cliente.arquivar', 'cliente.convidar_usuario', 'cliente.remover_usuario', 'convite.reenviar', 'convite.cancelar'];
const INVITE_ONLY_PERMISSIONS = ['cliente.visualizar', 'cliente.convidar_usuario'];

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
  closingDate: null,
  archivedAt: null,
  summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 3 }
};

interface MemberFixture {
  membershipId: string;
  name: string;
  email: string;
  status: 'active' | 'removed';
  since: string;
}

const maria: MemberFixture = {
  membershipId: 'aaaa1111-1111-4111-8111-111111111111',
  name: 'Maria Souza',
  email: 'maria@padaria.test',
  status: 'active',
  since: '2026-09-02T12:00:00.000Z'
};
const pedro: MemberFixture = {
  membershipId: 'bbbb2222-2222-4222-8222-222222222222',
  name: 'Pedro Alves',
  email: 'pedro@padaria.test',
  status: 'removed',
  since: '2026-09-01T12:00:00.000Z'
};

interface InvitationFixture {
  invitationId: string;
  email: string;
  expiresAt: string;
}

const carla: InvitationFixture = {
  invitationId: 'cccc3333-3333-4333-8333-333333333333',
  email: 'carla@padaria.test',
  expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString()
};

const pageOf = (data: unknown[], totalItems = data.length, totalPages = data.length === 0 ? 0 : 1) =>
  ({ data, meta: { page: 1, pageSize: 20, totalItems, totalPages } });

const listItemOf = (client: Record<string, unknown>, pendingInvitations: number) => ({
  id: client.id,
  name: client.name,
  photoUrl: null,
  instagramHandle: null,
  status: client.status,
  closingDate: null,
  threadsAwaitingAgency: 0,
  pendingInvitations
});

interface Scenario {
  readonly permissions?: readonly string[];
  readonly client?: () => Response | Promise<Response>;
  readonly members?: (status: string | null, page: number) => Response | Promise<Response>;
  readonly clientInvitations?: (page: number) => Response | Promise<Response>;
  readonly memberStatus?: (membershipId: string, action: string) => Response | Promise<Response>;
  readonly invite?: (body: unknown) => Response | Promise<Response>;
  readonly resend?: () => Response | Promise<Response>;
  readonly cancel?: () => Response | Promise<Response>;
  readonly clients?: () => Response | Promise<Response>;
}

/** Behaves like the real API: the #132 access routes plus the invitation routes that already exist. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const permissions = scenario.permissions ?? ADMIN_PERMISSIONS;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}${url.search}`);
    if (path.endsWith('/auth/session')) return json(sessionBody);
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(permissions));
    const clients = /\/agencies\/([^/]+)\/clients$/.exec(path);
    if (clients !== null) return scenario.clients?.() ?? json(pageOf([]));
    const members = /\/agencies\/([^/]+)\/clients\/([^/]+)\/members$/.exec(path);
    if (members !== null) {
      if (scenario.members === undefined) return json(pageOf([]));
      return scenario.members(url.searchParams.get('status'), Number(url.searchParams.get('page') ?? '1'));
    }
    const memberStatus = /\/agencies\/([^/]+)\/clients\/([^/]+)\/members\/([^/]+)\/(remove|reactivate)$/.exec(path);
    if (memberStatus !== null && method === 'POST') {
      if (scenario.memberStatus === undefined) throw new Error(`unexpected ${method} ${url}`);
      return scenario.memberStatus(memberStatus[3]!, memberStatus[4]!);
    }
    const clientInvitations = /\/agencies\/([^/]+)\/clients\/([^/]+)\/invitations$/.exec(path);
    if (clientInvitations !== null) {
      if (method === 'POST') {
        if (scenario.invite === undefined) throw new Error(`unexpected POST ${url}`);
        return scenario.invite(JSON.parse(String(init?.body)));
      }
      return scenario.clientInvitations?.(Number(url.searchParams.get('page') ?? '1')) ?? json(pageOf([]));
    }
    const resend = /\/agencies\/([^/]+)\/invitations\/([^/]+)\/resend$/.exec(path);
    if (resend !== null && method === 'POST') {
      if (scenario.resend === undefined) throw new Error(`unexpected POST ${url}`);
      return scenario.resend();
    }
    const cancel = /\/agencies\/([^/]+)\/invitations\/([^/]+)$/.exec(path);
    if (cancel !== null && method === 'DELETE') {
      if (scenario.cancel === undefined) throw new Error(`unexpected DELETE ${url}`);
      return scenario.cancel();
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

const accessUrl = `/agencia/${AGENCY_A}/clientes/${CLIENT_ID}/acessos`;

const renderAccess = (impl: typeof fetch, entry = accessUrl) => {
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

const openInviteDialog = async (): Promise<HTMLElement> => {
  const header = screen.getByRole('heading', { name: 'Pessoas com acesso ao portal' }).closest('.portal-access__header');
  if (header === null) throw new Error('The access header was not rendered.');
  fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Convidar' }));
  return await screen.findByRole('dialog', { name: 'Convidar para o portal' });
};

const confirmDialogOf = async (text: string): Promise<HTMLElement> => {
  const description = await screen.findByText(text);
  const dialog = description.closest('.ui-dialog');
  if (dialog === null) throw new Error('The confirmation was not rendered.');
  return dialog as HTMLElement;
};

describe('portal access tab (#140)', () => {
  it('lists the people, their e-mail and since day, and only the client invitations', async () => {
    const { impl, calls } = makeFetch({
      members: (status) => (status === 'removed' ? json(pageOf([])) : json(pageOf([maria]))),
      clientInvitations: () => json(pageOf([carla]))
    });
    renderAccess(impl);

    await screen.findByRole('heading', { name: 'Pessoas com acesso ao portal' });
    await screen.findByText('Maria Souza');
    expect(screen.getByText('Maria Souza')).toBeTruthy();
    expect(screen.getByText('maria@padaria.test')).toBeTruthy();
    // The link's creation day is read in the agency's timezone: 12:00Z of 02/09 is 02/09 in SP.
    expect(screen.getByText('desde 02/09')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Convites aguardando aceite' })).toBeTruthy();
    expect(screen.getByText('carla@padaria.test')).toBeTruthy();
    expect(screen.getByText('expira em 7 dias')).toBeTruthy();
    // The client tab reads the client's invitations, never the collaborator listing.
    expect(calls.some((call) => call.startsWith(`GET /agencies/${AGENCY_A}/invitations`))).toBe(false);
  });

  it('invites with only the e-mail, keeping the failure on the field and updating the roster badge', async () => {
    let pending = 0;
    const { impl, calls } = makeFetch({
      clients: () => json(pageOf([listItemOf(padaria, pending)])),
      members: (status) => (status === 'removed' ? json(pageOf([])) : json(pageOf([]))),
      invite: () => {
        pending = 1;
        return json({ invitationId: carla.invitationId, expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString() }, 201);
      },
      clientInvitations: () => json(pageOf([carla]))
    });
    const { probe } = renderAccess(impl, `/agencia/${AGENCY_A}/clientes`);
    await screen.findByText('Padaria Central');
    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await screen.findByRole('link', { name: 'Acessos' });
    fireEvent.click(screen.getByRole('link', { name: 'Acessos' }));
    await screen.findByText('Ninguém deste cliente acessa o portal ainda');

    const dialog = await openInviteDialog();
    expect(within(dialog).getByText('A pessoa recebe um link para criar a conta e entrar no portal deste cliente.')).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'E-mail' })).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'E-mail' }), { target: { value: 'nao-e-email' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));
    expect(await within(dialog).findByText('Informe um e-mail válido.')).toBeTruthy();
    expect(calls.some((call) => call.startsWith('POST /agencies') && call.includes('/invitations'))).toBe(false);

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'E-mail' }), { target: { value: 'carla@padaria.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));
    expect(await within(dialog).findByText('Convite enviado para carla@padaria.test. O link vale por 7 dias.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));

    // The invitation list shows the new invite; the roster badge follows the invalidated list.
    await screen.findByText('carla@padaria.test');
    fireEvent.click(screen.getByRole('link', { name: '← Clientes' }));
    expect(await screen.findByText('convite pendente')).toBeTruthy();
    void probe;
  });

  it('keeps an already-member e-mail on the field, without creating an invitation', async () => {
    const { impl } = makeFetch({
      members: (status) => (status === 'removed' ? json(pageOf([])) : json(pageOf([maria]))),
      invite: () => json({ error: { code: 'MEMBERSHIP_EXISTS', message: 'private diagnostic' } }, 409)
    });
    renderAccess(impl);
    await screen.findByRole('heading', { name: 'Pessoas com acesso ao portal' });

    const dialog = await openInviteDialog();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'E-mail' }), { target: { value: 'maria@padaria.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar convite' }));

    const error = await within(dialog).findByText('Esta pessoa já tem acesso ao portal deste cliente.');
    expect(error).toBeTruthy();
    expect(dialog.textContent).not.toContain('private diagnostic');
  });

  it('resends and cancels an invitation, removing the section when the list empties', async () => {
    let invitations = [carla];
    const { impl, calls } = makeFetch({
      members: (status) => (status === 'removed' ? json(pageOf([])) : json(pageOf([maria]))),
      clientInvitations: () => json(pageOf(invitations)),
      resend: () => json({ invitationId: carla.invitationId, expiresAt: new Date(Date.now() + 7 * DAY_MS).toISOString() }),
      cancel: () => { invitations = []; return noContent(); }
    });
    renderAccess(impl);
    await screen.findByText('carla@padaria.test');

    fireEvent.click(screen.getByRole('button', { name: 'Reenviar convite de carla@padaria.test' }));
    expect(await screen.findByText('Convite reenviado para carla@padaria.test. O link anterior deixou de valer.')).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.startsWith(`POST /agencies/${AGENCY_A}/invitations/`))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar convite de carla@padaria.test' }));
    const confirm = await confirmDialogOf('O link enviado para carla@padaria.test deixa de valer imediatamente. Para dar acesso de novo, será preciso convidar a pessoa outra vez.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancelar convite' }));

    await waitFor(() => expect(calls.some((call) => call.startsWith('DELETE /agencies'))).toBe(true));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Convites aguardando aceite' })).toBeNull());
  });

  it('removes a person into Removidas and updates the General counter without a reload', async () => {
    let detailData = padaria;
    let active = [maria];
    let removed: MemberFixture[] = [];
    const { impl } = makeFetch({
      client: () => json(detailData),
      members: (status) => (status === 'removed' ? json(pageOf(removed)) : json(pageOf(active))),
      clientInvitations: () => json(pageOf([])),
      memberStatus: (membershipId, action) => {
        const person = maria;
        if (action === 'remove') {
          active = active.filter((member) => member.membershipId !== membershipId);
          removed = [...removed, { ...person, status: 'removed' }];
          detailData = { ...detailData, summary: { ...detailData.summary, activePortalMembers: 2 } };
          return json({ ...person, status: 'removed' });
        }
        throw new Error(`unexpected ${action}`);
      }
    });
    renderAccess(impl);
    await screen.findByText('Maria Souza');

    fireEvent.click(screen.getByRole('button', { name: 'Remover o acesso de Maria Souza' }));
    const confirm = await confirmDialogOf('A pessoa perde o acesso ao portal deste cliente. As outras pessoas não são afetadas.');
    expect(within(confirm).getByText('Remover o acesso de Maria Souza?')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remover acesso' }));

    // The active list empties; the removed person sits behind the collapsed affordance.
    await waitFor(() => expect(screen.getByText('Ninguém deste cliente acessa o portal ainda')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Removidas (1)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Removidas (1)' }));
    expect(screen.getByText('Maria Souza')).toBeTruthy();
    expect(screen.getByText('removido')).toBeTruthy();

    // The General tab counter follows the invalidated detail summary, without a reload.
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('2 pessoas com acesso')).toBeTruthy();
  });

  it('reactivates a removed person, bringing her back to the main list', async () => {
    let active: MemberFixture[] = [];
    let removed: MemberFixture[] = [pedro];
    const { impl } = makeFetch({
      members: (status) => (status === 'removed' ? json(pageOf(removed)) : json(pageOf(active))),
      clientInvitations: () => json(pageOf([])),
      memberStatus: (membershipId, action) => {
        if (action !== 'reactivate') throw new Error(`unexpected ${action}`);
        removed = removed.filter((member) => member.membershipId !== membershipId);
        active = [{ ...pedro, status: 'active' }];
        return json({ ...pedro, status: 'active' });
      }
    });
    renderAccess(impl);
    await screen.findByRole('heading', { name: 'Pessoas com acesso ao portal' });
    await screen.findByText('Ninguém deste cliente acessa o portal ainda');

    fireEvent.click(screen.getByRole('button', { name: 'Removidas (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reativar o acesso de Pedro Alves' }));

    // Back in the main list; the collapsed affordance disappears with the empty removed list.
    expect(await screen.findByText('Pedro Alves')).toBeTruthy();
    expect(screen.getByText('desde 01/09')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Removidas (1)' })).toBeNull());
  });

  it('offers no action at all on an archived client, and keeps the lists readable', async () => {
    const { impl } = makeFetch({
      client: () => json({ ...padaria, status: 'archived', archivedAt: '2026-10-04T12:00:00.000Z' }),
      members: (status) => (status === 'removed' ? json(pageOf([pedro])) : json(pageOf([maria]))),
      clientInvitations: () => json(pageOf([carla]))
    });
    renderAccess(impl);

    await screen.findByRole('heading', { name: 'Pessoas com acesso ao portal' });
    expect(screen.getByText('Cliente arquivado em 04/10')).toBeTruthy();
    await screen.findByText('Maria Souza');
    expect(screen.getByText('carla@padaria.test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Convidar' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remover o acesso de/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reenviar convite/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancelar convite/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Removidas (1)' }));
    expect(screen.getByText('Pedro Alves')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Reativar o acesso de/ })).toBeNull();
  });

  it('draws the distinct empty states: no people with Convidar, no invitations, no removed list', async () => {
    const { impl } = makeFetch({
      members: (status) => (status === 'removed' ? json(pageOf([])) : json(pageOf([]))),
      clientInvitations: () => json(pageOf([]))
    });
    renderAccess(impl);

    await screen.findByText('Ninguém deste cliente acessa o portal ainda');
    expect(screen.getAllByRole('button', { name: 'Convidar' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Convites aguardando aceite' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Removidas/ })).toBeNull();
  });

  it('hides every action a role cannot perform (invite-only role)', async () => {
    const { impl } = makeFetch({
      permissions: INVITE_ONLY_PERMISSIONS,
      members: (status) => (status === 'removed' ? json(pageOf([pedro])) : json(pageOf([maria]))),
      clientInvitations: () => json(pageOf([carla]))
    });
    renderAccess(impl);

    await screen.findByText('Maria Souza');
    // Seeing the tab and inviting are `cliente.convidar_usuario`; the rest is absent, not disabled.
    expect(screen.getByRole('button', { name: 'Convidar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remover o acesso de/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reenviar convite/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancelar convite/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Removidas (1)' }));
    expect(screen.queryByRole('button', { name: /Reativar o acesso de/ })).toBeNull();
  });

  it('paginates the people through the URL', async () => {
    const { impl, calls } = makeFetch({
      members: (status, page) => (status === 'removed'
        ? json(pageOf([]))
        : json({ data: [page === 2 ? { ...maria, membershipId: 'dddd4444-4444-4444-8444-444444444444', name: 'João Lima' } : maria], meta: { page, pageSize: 20, totalItems: 21, totalPages: 2 } })),
      clientInvitations: () => json(pageOf([]))
    });
    const { probe } = renderAccess(impl);
    await screen.findByText('Maria Souza');

    fireEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(probe.search).toContain('membros=2'));
    expect(await screen.findByText('João Lima')).toBeTruthy();
    expect(calls.some((call) => call.includes('/members?page=2'))).toBe(true);
  });

  it('draws row skeletons while the lists load', async () => {
    const { impl } = makeFetch({
      members: (status) => (status === 'removed' ? new Promise<Response>(() => undefined) : new Promise<Response>(() => undefined)),
      clientInvitations: () => new Promise<Response>(() => undefined)
    });
    const { container } = renderAccess(impl);

    await waitFor(() => expect(container.querySelectorAll('.portal-access__list .ui-skeleton').length).toBeGreaterThanOrEqual(4));
  });

  it('retries when the list fails, without echoing the API message', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      members: (status) => {
        if (status === 'removed') return json(pageOf([]));
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500)
          : json(pageOf([maria]));
      },
      clientInvitations: () => json(pageOf([]))
    });
    renderAccess(impl);

    const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível carregar as pessoas com acesso. Tente de novo.');
    expect(alert.textContent).not.toContain('private diagnostic');

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Maria Souza')).toBeTruthy();
  });
});
