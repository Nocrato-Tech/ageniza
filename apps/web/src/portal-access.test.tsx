// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
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
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const DAY_MS = 24 * 60 * 60 * 1000;
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });

const agencyMe = (permissions: readonly string[], readOnly = false) => ({
  agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'admin', name: 'Admin' },
  plan: readOnly ? { kind: 'trial', trialEndsAt: '2026-10-01T12:00:00.000Z', readOnly: true } : { kind: 'isenta', trialEndsAt: null, readOnly: false },
  permissions
});

const ADMIN_PERMISSIONS = ['cliente.visualizar', 'cliente.operar', 'cliente.cadastrar', 'cliente.arquivar', 'cliente.convidar_usuario', 'cliente.remover_usuario', 'convite.reenviar', 'convite.cancelar'];
const GATE_ONLY_PERMISSIONS = ['cliente.visualizar', 'cliente.convidar_usuario'];

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
  accessId: string;
  name: string | null;
  email: string;
  status: 'active' | 'removed';
  entered: boolean;
  since: string;
}

const maria: MemberFixture = {
  accessId: 'aaaa1111-1111-4111-8111-111111111111',
  name: 'Maria Souza',
  email: 'maria@padaria.test',
  status: 'active',
  entered: true,
  // 01:30 UTC of the 3rd is 22:30 of the 2nd in São Paulo: the label must read 02/09.
  since: '2026-09-03T01:30:00.000Z'
};
const joao: MemberFixture = {
  accessId: 'eeee5555-5555-4555-8555-555555555555',
  name: 'João Lima',
  email: 'joao@padaria.test',
  status: 'active',
  entered: true,
  since: '2026-09-10T12:00:00.000Z'
};
const ines: MemberFixture = {
  accessId: 'a1a1a1a1-1111-4111-8111-111111111111',
  name: null,
  email: 'ines@padaria.test',
  status: 'active',
  entered: false,
  since: '2026-09-12T12:00:00.000Z'
};
const pedro: MemberFixture = {
  accessId: 'bbbb2222-2222-4222-8222-222222222222',
  name: 'Pedro Alves',
  email: 'pedro@padaria.test',
  status: 'removed',
  entered: true,
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
const rita: InvitationFixture = {
  invitationId: 'dddd4444-4444-4444-8444-444444444444',
  email: 'rita@padaria.test',
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
  readonly memberStatus?: (accessId: string, action: string) => Response | Promise<Response>;
  readonly add?: (body: unknown) => Response | Promise<Response>;
  readonly cancel?: (invitationId: string) => Response | Promise<Response>;
  readonly clients?: () => Response | Promise<Response>;
  /** The trial of the agency ended (issue #714). */
  readonly readOnly?: boolean;
}

/** Behaves like the real API (#711): the access routes by access id, plus what is left of the portal invitations (list and cancel). */
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
    if (me !== null) return json(agencyMe(permissions, scenario.readOnly));
    const clients = /\/agencies\/([^/]+)\/clients$/.exec(path);
    if (clients !== null) return scenario.clients?.() ?? json(pageOf([]));
    const members = /\/agencies\/([^/]+)\/clients\/([^/]+)\/members$/.exec(path);
    if (members !== null && method === 'POST') {
      if (scenario.add === undefined) throw new Error(`unexpected POST ${url}`);
      return scenario.add(JSON.parse(String(init?.body)));
    }
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
      if (method === 'POST') throw new Error(`the route that creates a portal invitation no longer exists: ${method} ${url}`);
      return scenario.clientInvitations?.(Number(url.searchParams.get('page') ?? '1')) ?? json(pageOf([]));
    }
    if (/\/agencies\/([^/]+)\/invitations\/([^/]+)\/resend$/.test(path)) throw new Error(`a portal invitation is never resent: ${method} ${url}`);
    const cancel = /\/agencies\/([^/]+)\/invitations\/([^/]+)$/.exec(path);
    if (cancel !== null && method === 'DELETE') {
      if (scenario.cancel === undefined) throw new Error(`unexpected DELETE ${url}`);
      return scenario.cancel(cancel[2]!);
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
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.navigate = navigate;
  });
  return null;
}

const accessUrl = `/agencia/${AGENCY_A}/clientes/${CLIENT_ID}/acessos`;

type Entry = string | { pathname: string; search?: string; state?: unknown };

const renderAccess = (impl: typeof fetch, entry: Entry = accessUrl) => {
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

const openAddDialog = async (): Promise<HTMLElement> => {
  const header = screen.getByRole('heading', { name: 'Pessoas com acesso ao portal' }).closest('.portal-access__header');
  if (header === null) throw new Error('The access header was not rendered.');
  fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Adicionar pessoa' }));
  return await screen.findByRole('dialog', { name: 'Adicionar pessoa' });
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
    expect(screen.getByText('maria@padaria.test')).toBeTruthy();
    // The link's creation day is read in the agency's timezone: 01:30Z of the 3rd is 02/09 in SP.
    expect(screen.getByText('desde 02/09')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Convites aguardando aceite' })).toBeTruthy();
    expect(screen.getByText('carla@padaria.test')).toBeTruthy();
    expect(screen.getByText('expira em 7 dias')).toBeTruthy();
    // The client tab reads the client's invitations, never the collaborator listing.
    expect(calls.some((call) => call.startsWith(`GET /agencies/${AGENCY_A}/invitations`))).toBe(false);
  });

  it('keeps the roster address when paginating, through every page parameter', async () => {
    const rosterUrl = `/agencia/${AGENCY_A}/clientes?search=padaria&status=archived&page=2`;
    const manyInvites = Array.from({ length: 20 }, (_value, index) => ({ ...carla, invitationId: `cccc3333-3333-4333-8333-${String(index).padStart(12, '0')}`, email: `convidado-${index}@padaria.test` }));
    const { impl, calls } = makeFetch({
      members: (status, page) => (status === 'removed'
        ? json({ data: [pedro], meta: { page, pageSize: 20, totalItems: 21, totalPages: 2 } })
        : json({ data: [page === 2 ? joao : maria], meta: { page, pageSize: 20, totalItems: 21, totalPages: 2 } })),
      clientInvitations: (page) => json({ data: page === 2 ? [rita] : manyInvites, meta: { page, pageSize: 20, totalItems: 21, totalPages: 2 } })
    });
    const { container, probe } = renderAccess(impl, { pathname: accessUrl, state: { clientListUrl: rosterUrl } });
    await screen.findByText('Maria Souza');
    const back = (): HTMLElement => screen.getByRole('link', { name: 'Voltar para Clientes' });
    expect(back().getAttribute('href')).toBe(rosterUrl);
    // The members pagination is the first on the page; the invitations one comes after it.
    const membersNext = (): HTMLElement => {
      const pagination = container.querySelectorAll<HTMLElement>('.portal-access .ui-pagination')[0];
      if (pagination === undefined) throw new Error('The members pagination was not rendered.');
      return pagination;
    };

    fireEvent.click(within(membersNext()).getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(probe.search).toContain('membros=2'));
    expect(await screen.findByText('João Lima')).toBeTruthy();
    // The page write carried the roster address forward (review of #388).
    expect(back().getAttribute('href')).toBe(rosterUrl);
    expect(calls.some((call) => call.includes('/members?page=2'))).toBe(true);

    // Opening the removed list and paginating it also keeps the address.
    fireEvent.click(screen.getByRole('button', { name: 'Removidas (21)' }));
    await screen.findByText('Pedro Alves');
    const removedNext = within(screen.getByRole('region', { name: 'Pessoas removidas' })).getByRole('button', { name: 'Próxima página' });
    fireEvent.click(removedNext);
    await waitFor(() => expect(probe.search).toContain('removidas=2'));
    expect(back().getAttribute('href')).toBe(rosterUrl);

    // The invitations page carries it too (review of #390 r2).
    const invites = screen.getByRole('region', { name: 'Convites aguardando aceite' });
    fireEvent.click(within(invites).getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(probe.search).toContain('convites=2'));
    expect(await screen.findByText('rita@padaria.test')).toBeTruthy();
    expect(back().getAttribute('href')).toBe(rosterUrl);
    expect(calls.some((call) => call.includes('/invitations?page=2'))).toBe(true);
  });

  it('keeps the roster address when the clamp moves an out-of-range page back, on every list', async () => {
    const rosterUrl = `/agencia/${AGENCY_A}/clientes?search=padaria&status=archived&page=2`;
    // The URL asks for page 2 of lists that shrank to a single page: every clamp writes the
    // address back and must carry the roster address with it (review of #390 r2).
    const { impl } = makeFetch({
      members: (status) => (status === 'removed' ? json(pageOf([pedro])) : json(pageOf([maria]))),
      clientInvitations: () => json(pageOf([carla]))
    });
    const { probe } = renderAccess(impl, {
      pathname: accessUrl,
      search: '?membros=2&convites=2&removidas=2',
      state: { clientListUrl: rosterUrl }
    });
    const back = (): HTMLElement => screen.getByRole('link', { name: 'Voltar para Clientes' });

    await screen.findByText('Maria Souza');
    await waitFor(() => expect(probe.search).not.toContain('membros=2'));
    expect(back().getAttribute('href')).toBe(rosterUrl);
    await waitFor(() => expect(probe.search).not.toContain('convites=2'));
    expect(back().getAttribute('href')).toBe(rosterUrl);
    await waitFor(() => expect(probe.search).not.toContain('removidas=2'));
    expect(back().getAttribute('href')).toBe(rosterUrl);
  });

  it('adds a person with only the e-mail, validates it first, closes on success and refreshes the list and the General counter', async () => {
    let detailData = padaria;
    let active: MemberFixture[] = [];
    const added: unknown[] = [];
    const { impl, calls } = makeFetch({
      client: () => json(detailData),
      members: (status) => json(pageOf(status === 'removed' ? [] : active)),
      add: (body) => {
        added.push(body);
        active = [{ ...ines, email: 'ines@padaria.test' }];
        detailData = { ...detailData, summary: { ...detailData.summary, activePortalMembers: 1 } };
        return json(ines, 201);
      }
    });
    renderAccess(impl);
    await screen.findByText('Ninguém deste cliente acessa o portal ainda');

    const dialog = await openAddDialog();
    expect(within(dialog).getByText('A pessoa passa a ter acesso ao portal deste cliente na hora e recebe um e-mail de boas-vindas.')).toBeTruthy();
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'E-mail' }), { target: { value: 'nao-e-email' } });
    within(dialog).getByRole('button', { name: 'Adicionar' }).focus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar' }));
    expect(await within(dialog).findByText('Informe um e-mail válido.')).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'E-mail' }));
    expect(added).toEqual([]);

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'E-mail' }), { target: { value: '  Ines@Padaria.test ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar' }));

    // The body carries the address and nothing else, and the modal closes on success.
    await waitFor(() => expect(added).toEqual([{ email: 'ines@padaria.test' }]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('ines@padaria.test agora tem acesso ao portal deste cliente.')).toBeTruthy();
    expect(await screen.findByText('ainda não entrou')).toBeTruthy();
    expect(calls.some((call) => call.startsWith(`POST /agencies/${AGENCY_A}/clients/${CLIENT_ID}/members`))).toBe(true);
    expect(calls.some((call) => call.includes('/invitations') && call.startsWith('POST'))).toBe(false);

    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('1 pessoa com acesso')).toBeTruthy();
  });

  it('maps every server refusal of an addition to its own message and keeps the typed e-mail', async () => {
    const refusals: Array<{ response: () => Response; expected: string }> = [
      {
        response: () => json({ error: { code: 'ACCESS_EXISTS', message: 'private diagnostic' } }, 409),
        expected: 'Esta pessoa já tem acesso ao portal deste cliente.'
      },
      {
        response: () => json({ error: { code: 'CLIENT_ARCHIVED', message: 'private diagnostic' } }, 409),
        expected: 'Cliente arquivado: não é possível adicionar pessoas ao portal.'
      },
      {
        response: () => json({ error: { code: 'FORBIDDEN', message: 'private diagnostic' } }, 403),
        expected: 'Você não tem permissão para adicionar pessoas a este cliente.'
      },
      {
        response: () => json({ error: { code: 'AGENCY_READ_ONLY', message: 'private diagnostic' } }, 409),
        expected: 'O plano desta agência precisa ser renovado para usar esta opção.'
      },
      {
        response: () => json({ error: { code: 'DAILY_EMAIL_LIMIT', message: 'private diagnostic' } }, 429),
        expected: 'Limite diário de e-mails da agência atingido. Tente amanhã.'
      },
      {
        response: () => json({ error: { code: 'EMAIL_DELIVERY_FAILED', message: 'private diagnostic' } }, 502),
        expected: 'O acesso foi dado, mas o e-mail de boas-vindas não foi entregue. Para mandar de novo, remova o acesso e adicione o e-mail outra vez.'
      },
      {
        response: () => json({ error: { code: 'VALIDATION_ERROR', message: 'private diagnostic', details: { issues: [{ path: 'email', code: 'custom' }] } } }, 400),
        expected: 'Informe um e-mail válido.'
      },
      {
        response: () => json({ error: { code: 'VALIDATION_ERROR', message: 'private diagnostic', details: { issues: [] } } }, 400),
        expected: 'Revise os dados.'
      },
      {
        response: () => json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500),
        expected: 'Não foi possível adicionar a pessoa. Tente de novo.'
      }
    ];
    for (const item of refusals) {
      const { impl } = makeFetch({
        members: (status) => json(pageOf(status === 'removed' ? [] : [maria])),
        add: item.response
      });
      renderAccess(impl);
      await screen.findByText('Maria Souza');
      const dialog = await openAddDialog();
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'E-mail' }), { target: { value: 'novo@padaria.test' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar' }));
      expect(await within(dialog).findByText(item.expected)).toBeTruthy();
      expect(dialog.textContent).not.toContain('private diagnostic');
      // The refusal is not a reason to type it all again, and the modal stays open.
      expect((within(dialog).getByRole('textbox', { name: 'E-mail' }) as HTMLInputElement).value).toBe('novo@padaria.test');
      expect(screen.getByRole('dialog', { name: 'Adicionar pessoa' })).toBeTruthy();
      cleanup();
    }
  });

  it('refetches the list after the e-mail failed, because the access was kept', async () => {
    let active: MemberFixture[] = [];
    const { impl } = makeFetch({
      members: (status) => json(pageOf(status === 'removed' ? [] : active)),
      add: () => {
        active = [ines];
        return json({ error: { code: 'EMAIL_DELIVERY_FAILED', message: 'private diagnostic' } }, 502);
      }
    });
    renderAccess(impl);
    await screen.findByText('Ninguém deste cliente acessa o portal ainda');
    const dialog = await openAddDialog();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'E-mail' }), { target: { value: 'ines@padaria.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar' }));

    expect(await within(dialog).findByText(/O acesso foi dado/)).toBeTruthy();
    expect(await screen.findByText('ines@padaria.test', { selector: '.portal-access__email' })).toBeTruthy();
  });

  it('never says whether an address has an account: the confirmation is the same whatever the server answers about it', async () => {
    const answers = [json({ ...maria, email: 'qualquer@padaria.test' }, 201), json({ ...ines, email: 'qualquer@padaria.test' }, 201)];
    const texts: string[] = [];
    for (const answer of answers) {
      const { impl } = makeFetch({ members: (status) => json(pageOf(status === 'removed' ? [] : [joao])), add: () => answer });
      const { container } = renderAccess(impl);
      await screen.findByText('João Lima');
      const dialog = await openAddDialog();
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'E-mail' }), { target: { value: 'qualquer@padaria.test' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Adicionar' }));
      const status = await screen.findByText(/agora tem acesso ao portal/);
      texts.push(status.textContent ?? '');
      expect(container.textContent).not.toContain('Maria Souza');
      expect(container.textContent?.toLowerCase()).not.toContain('conta');
      cleanup();
    }
    expect(texts[0]).toBe(texts[1]);
  });

  it('shows the name once the person entered and "ainda não entrou" before, in both lists', async () => {
    const { impl } = makeFetch({
      members: (status) => json(pageOf(status === 'removed' ? [{ ...ines, accessId: 'a2a2a2a2-2222-4222-8222-222222222222', email: 'bia@padaria.test', status: 'removed' }, pedro] : [maria, ines])),
      clientInvitations: () => json(pageOf([]))
    });
    const { container } = renderAccess(impl);

    await screen.findByText('Maria Souza');
    const rowOf = (email: string): HTMLElement => {
      const row = screen.getByText(email, { selector: '.portal-access__email' }).closest('li');
      if (row === null) throw new Error('The person row was not rendered.');
      return row;
    };
    expect(within(rowOf('maria@padaria.test')).queryByText('ainda não entrou')).toBeNull();
    expect(within(rowOf('ines@padaria.test')).getByText('ainda não entrou')).toBeTruthy();
    expect(within(rowOf('ines@padaria.test')).queryByText('Maria Souza')).toBeNull();
    expect(within(rowOf('ines@padaria.test')).getByText('desde 12/09')).toBeTruthy();
    expect(rowOf('ines@padaria.test').querySelector('.ui-avatar')?.textContent).toBe('I');

    fireEvent.click(screen.getByRole('button', { name: 'Removidas (2)' }));
    expect(within(rowOf('bia@padaria.test')).getByText('ainda não entrou')).toBeTruthy();
    expect(within(rowOf('pedro@padaria.test')).getByText('Pedro Alves')).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain('conta');
  });

  it('cancels an old invitation, the section goes away with the last one and the roster badge follows', async () => {
    let invitations = [carla];
    let pending = 1;
    const { impl, calls } = makeFetch({
      clients: () => json(pageOf([listItemOf(padaria, pending)])),
      members: (status) => (status === 'removed' ? json(pageOf([])) : json(pageOf([maria]))),
      clientInvitations: () => json(pageOf(invitations)),
      cancel: () => { invitations = []; pending = 0; return noContent(); }
    });
    const { probe } = renderAccess(impl, `/agencia/${AGENCY_A}/clientes`);
    await screen.findByText('Padaria Central');
    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await screen.findByRole('link', { name: 'Acessos' });
    fireEvent.click(screen.getByRole('link', { name: 'Acessos' }));
    await screen.findByText('expira em 7 dias');

    // A portal invitation is never resent (decision 2026-10-27): only Cancelar is left on the row.
    expect(screen.queryByRole('button', { name: /Reenviar/ })).toBeNull();

    // The roster badge is on the screen before the cancellation, and the cancel invalidates it.
    fireEvent.click(screen.getByRole('link', { name: 'Voltar para Clientes' }));
    expect(await screen.findByText('convite pendente')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Padaria Central' }));
    await screen.findByRole('link', { name: 'Acessos' });
    fireEvent.click(screen.getByRole('link', { name: 'Acessos' }));
    await screen.findByText('carla@padaria.test');

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar convite de carla@padaria.test' }));
    const confirm = await confirmDialogOf('O link enviado para carla@padaria.test deixa de valer imediatamente. Para dar acesso de novo, use Adicionar pessoa.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancelar convite' }));

    await waitFor(() => expect(calls.some((call) => call.startsWith('DELETE /agencies'))).toBe(true));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Convites aguardando aceite' })).toBeNull());
    fireEvent.click(screen.getByRole('link', { name: 'Voltar para Clientes' }));
    await waitFor(() => expect(screen.queryByText('convite pendente')).toBeNull());
    expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes`);
  });

  it('cancels the invitation that was clicked, not the first one', async () => {
    let invitations = [carla, rita];
    const cancelled: string[] = [];
    const { impl } = makeFetch({
      members: (status) => (status === 'removed' ? json(pageOf([])) : json(pageOf([maria]))),
      clientInvitations: () => json(pageOf(invitations)),
      cancel: (invitationId) => {
        cancelled.push(invitationId);
        invitations = invitations.filter((invitation) => invitation.invitationId !== invitationId);
        return noContent();
      }
    });
    renderAccess(impl);
    await screen.findByText('rita@padaria.test');

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar convite de rita@padaria.test' }));
    const confirm = await confirmDialogOf('O link enviado para rita@padaria.test deixa de valer imediatamente. Para dar acesso de novo, use Adicionar pessoa.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancelar convite' }));

    await waitFor(() => expect(cancelled).toEqual([rita.invitationId]));
    expect(await screen.findByText('carla@padaria.test')).toBeTruthy();
    expect(screen.queryByText('rita@padaria.test')).toBeNull();
  });

  it('removes the person that was clicked, moves her into Removidas and updates the General counter', async () => {
    let detailData = padaria;
    let active = [maria, joao];
    let removed: MemberFixture[] = [];
    const removedIds: string[] = [];
    const { impl } = makeFetch({
      client: () => json(detailData),
      members: (status) => (status === 'removed' ? json(pageOf(removed)) : json(pageOf(active))),
      clientInvitations: () => json(pageOf([])),
      memberStatus: (accessId, action) => {
        if (action !== 'remove') throw new Error(`unexpected ${action}`);
        removedIds.push(accessId);
        const person = active.find((member) => member.accessId === accessId);
        if (person === undefined) throw new Error('unknown member');
        active = active.filter((member) => member.accessId !== accessId);
        removed = [...removed, { ...person, status: 'removed' }];
        detailData = { ...detailData, summary: { ...detailData.summary, activePortalMembers: active.length + 0 } };
        return json({ ...person, status: 'removed' });
      }
    });
    renderAccess(impl);
    await screen.findByText('João Lima');

    fireEvent.click(screen.getByRole('button', { name: 'Remover o acesso de João Lima' }));
    const confirm = await confirmDialogOf('A pessoa perde o acesso ao portal deste cliente. As outras pessoas não são afetadas.');
    expect(within(confirm).getByText('Remover o acesso de João Lima?')).toBeTruthy();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remover acesso' }));

    // The right id travelled, and only that person moved.
    await waitFor(() => expect(removedIds).toEqual([joao.accessId]));
    await waitFor(() => expect(screen.queryByText('João Lima')).toBeNull());
    expect(screen.getByText('Maria Souza')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Removidas (1)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Removidas (1)' }));
    expect(screen.getByText('João Lima')).toBeTruthy();
    expect(screen.getByText('removido')).toBeTruthy();

    // The General tab counter follows the invalidated detail summary, without a reload.
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('1 pessoa com acesso')).toBeTruthy();
  });

  it('reactivates the removed person that was clicked and updates the General counter', async () => {
    const ana = { ...maria, accessId: 'ffff6666-6666-4666-8666-666666666666', name: 'Ana Prado', email: 'ana@padaria.test' };
    let detailData = padaria;
    let active: MemberFixture[] = [maria];
    let removed: MemberFixture[] = [pedro, { ...ana, status: 'removed' }];
    const reactivated: string[] = [];
    const { impl } = makeFetch({
      client: () => json(detailData),
      members: (status) => (status === 'removed' ? json(pageOf(removed)) : json(pageOf(active))),
      clientInvitations: () => json(pageOf([])),
      memberStatus: (accessId, action) => {
        if (action !== 'reactivate') throw new Error(`unexpected ${action}`);
        reactivated.push(accessId);
        removed = removed.filter((member) => member.accessId !== accessId);
        active = [...active, { ...ana, status: 'active' }];
        detailData = { ...detailData, summary: { ...detailData.summary, activePortalMembers: active.length } };
        return json({ ...ana, status: 'active' });
      }
    });
    renderAccess(impl);
    await screen.findByText('Maria Souza');

    fireEvent.click(screen.getByRole('button', { name: 'Removidas (2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reativar o acesso de Ana Prado' }));

    // The right id travelled, and only that person moved: Pedro stays in the removed list.
    await waitFor(() => expect(reactivated).toEqual([ana.accessId]));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Removidas (1)' })).toBeTruthy());
    expect(screen.getByText('Pedro Alves')).toBeTruthy();
    // The General tab counter follows the invalidated detail summary, without a reload.
    fireEvent.click(screen.getByRole('link', { name: 'Geral' }));
    expect(await screen.findByText('2 pessoas com acesso')).toBeTruthy();
  });

  it.each([
    { code: 'AGENCY_READ_ONLY', expected: 'O plano desta agência precisa ser renovado para usar esta opção.' },
    { code: 'CLIENT_ARCHIVED', expected: 'Cliente arquivado: o acesso ao portal não pode ser alterado.' },
    { code: 'FORBIDDEN', expected: 'Você não tem permissão para alterar o acesso deste cliente.' }
  ])('tells a refused reactivation apart: $code', async ({ code, expected }) => {
    const { impl } = makeFetch({
      members: (status) => json(pageOf(status === 'removed' ? [pedro] : [maria])),
      memberStatus: () => json({ error: { code, message: 'private diagnostic' } }, code === 'FORBIDDEN' ? 403 : 409)
    });
    const { container } = renderAccess(impl);
    await screen.findByText('Maria Souza');
    fireEvent.click(screen.getByRole('button', { name: 'Removidas (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reativar o acesso de Pedro Alves' }));
    expect((await screen.findByRole('alert')).textContent).toBe(expected);
    expect(container.textContent).not.toContain('private diagnostic');
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
    expect(screen.queryByRole('button', { name: 'Adicionar pessoa' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remover o acesso de/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reenviar convite/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancelar convite/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Removidas (1)' }));
    expect(screen.getByText('Pedro Alves')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Reativar o acesso de/ })).toBeNull();
  });

  it('draws the distinct empty states: no people with Adicionar pessoa, no invitations, no removed list', async () => {
    const { impl } = makeFetch({
      members: () => json(pageOf([])),
      clientInvitations: () => json(pageOf([]))
    });
    renderAccess(impl);

    await screen.findByText('Ninguém deste cliente acessa o portal ainda');
    expect(screen.getAllByRole('button', { name: 'Adicionar pessoa' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Convites aguardando aceite' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Removidas/ })).toBeNull();
  });

  it.each([
    { label: 'convite.cancelar', cansee: [/Cancelar convite/], cannotsee: [/Remover o acesso de/] },
    { label: 'cliente.remover_usuario', cansee: [/Remover o acesso de/], cannotsee: [/Cancelar convite/] }
  ])('shows exactly the action $label grants, one permission at a time', async ({ label, cansee, cannotsee }) => {
    const { impl } = makeFetch({
      permissions: [...GATE_ONLY_PERMISSIONS, label],
      members: (status) => (status === 'removed' ? json(pageOf([pedro])) : json(pageOf([maria]))),
      clientInvitations: () => json(pageOf([carla]))
    });
    renderAccess(impl);

    await screen.findByText('Maria Souza');
    expect(screen.getByRole('button', { name: 'Adicionar pessoa' })).toBeTruthy();
    for (const pattern of cansee) expect(screen.queryByRole('button', { name: pattern })).toBeTruthy();
    for (const pattern of cannotsee) expect(screen.queryByRole('button', { name: pattern })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reenviar/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Removidas (1)' }));
    // Reading the removed list stays; only the reactivation needs `cliente.remover_usuario`.
    expect(screen.getByText('Pedro Alves')).toBeTruthy();
    const reactivate = screen.queryByRole('button', { name: /Reativar o acesso de/ });
    if (label === 'cliente.remover_usuario') expect(reactivate).toBeTruthy();
    else expect(reactivate).toBeNull();
  });

  it('keeps adding apart from removing: the role that only reads and adds can remove and reactivate nothing', async () => {
    const { impl } = makeFetch({
      permissions: GATE_ONLY_PERMISSIONS,
      members: (status) => json(pageOf(status === 'removed' ? [pedro] : [maria])),
      clientInvitations: () => json(pageOf([]))
    });
    renderAccess(impl);
    await screen.findByText('Maria Souza');
    expect(screen.getByRole('button', { name: 'Adicionar pessoa' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remover o acesso de/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Removidas (1)' }));
    expect(screen.queryByRole('button', { name: /Reativar o acesso de/ })).toBeNull();
  });

  it('answers a hidden tab with the ordinary not-found, never a blank panel', async () => {
    const { impl } = makeFetch({
      members: () => json({ error: { code: 'FORBIDDEN', message: 'sensitive detail' } }, 403)
    });
    const { container } = renderAccess(impl);

    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    expect(container.textContent).not.toContain('sensitive detail');
    expect(screen.queryByRole('heading', { name: 'Pessoas com acesso ao portal' })).toBeNull();
  });

  it('draws row skeletons while the lists load', async () => {
    const { impl } = makeFetch({
      members: () => new Promise<Response>(() => undefined),
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

describe('portal access in the Pauta (#637)', () => {
  const primaryInvites = (): HTMLElement[] =>
    screen.getAllByRole('button', { name: 'Adicionar pessoa' }).filter((button) => button.classList.contains('ui-button--primary'));

  it('keeps one primary action: Adicionar pessoa in the empty state with the owl while nobody has access, in the header otherwise', async () => {
    const empty = makeFetch({ members: () => json(pageOf([])), clientInvitations: () => json(pageOf([])) });
    renderAccess(empty.impl);
    await screen.findByText('Ninguém deste cliente acessa o portal ainda');

    expect(screen.getAllByRole('button', { name: 'Adicionar pessoa' })).toHaveLength(2);
    expect(primaryInvites()).toHaveLength(1);
    expect(primaryInvites()[0]!.closest('.ui-empty-state')).not.toBeNull();
    expect(document.querySelector('.ui-empty-state--mascot img')).not.toBeNull();

    cleanup();
    const filled = makeFetch({ members: () => json(pageOf([maria])), clientInvitations: () => json(pageOf([])) });
    renderAccess(filled.impl);
    await screen.findByText('Maria Souza');

    expect(primaryInvites()).toHaveLength(1);
    expect(primaryInvites()[0]!.closest('.ui-empty-state')).toBeNull();
    expect(document.querySelector('.ui-empty-state')).toBeNull();
  });

  it('draws the empty list of an archived client without the owl, the sentence about the invite or any action', async () => {
    const { impl } = makeFetch({
      client: () => json({ ...padaria, status: 'archived', archivedAt: '2026-10-04T12:00:00.000Z' }),
      members: () => json(pageOf([])),
      clientInvitations: () => json(pageOf([]))
    });
    renderAccess(impl);
    await screen.findByText('Ninguém deste cliente acessa o portal ainda');

    expect(document.querySelector('.ui-empty-state--mascot')).toBeNull();
    expect(document.querySelector('.ui-empty-state img')).toBeNull();
    expect(screen.queryByText('A pessoa passa a ter acesso ao portal deste cliente na hora e recebe um e-mail de boas-vindas.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Adicionar pessoa' })).toBeNull();
  });

  it('names each person with an avatar, and tells the expiry of an invitation in a pill with an icon', async () => {
    const { impl } = makeFetch({ members: () => json(pageOf([maria])), clientInvitations: () => json(pageOf([carla])) });
    renderAccess(impl);

    const row = (await screen.findByText('Maria Souza')).closest('li');
    if (row === null) throw new Error('The person row was not rendered.');
    expect(row.querySelector('.ui-avatar')?.textContent).toBe('MS');
    const invitation = screen.getByText('carla@padaria.test').closest('li');
    if (invitation === null) throw new Error('The invitation row was not rendered.');
    const expiry = invitation.querySelector('.ui-pill');
    expect(expiry?.querySelector('svg')).not.toBeNull();
    expect(expiry?.textContent).toMatch(/expira/);
  });
});

describe('portal access of a read-only agency (issue #714, decision 2026-10-27)', () => {
  const REASON = 'O plano precisa ser renovado para usar esta opção.';
  const describedBy = (button: HTMLElement) => (button.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent).join(' ');

  it('keeps Adicionar pessoa and Reativar disabled with the reason, and removing an access and cancelling an invitation enabled', async () => {
    const changed: string[] = [];
    const added: unknown[] = [];
    const { impl, calls } = makeFetch({
      readOnly: true,
      members: (status) => json(pageOf(status === 'removed' ? [pedro] : [maria, joao])),
      clientInvitations: () => json(pageOf([carla])),
      memberStatus: (accessId, action) => { changed.push(`${action}:${accessId}`); return json({ ...joao, status: 'removed' }); },
      add: (body) => { added.push(body); return json(joao, 201); },
      cancel: () => noContent()
    });
    renderAccess(impl);
    await screen.findByText('João Lima');

    const add = screen.getByRole('button', { name: 'Adicionar pessoa' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(describedBy(add)).toBe(REASON);
    fireEvent.click(add);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(added).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Removidas (1)' }));
    const reactivate = screen.getByRole('button', { name: 'Reativar o acesso de Pedro Alves' });
    expect(reactivate.getAttribute('aria-disabled')).toBe('true');
    expect(describedBy(reactivate)).toBe(REASON);
    fireEvent.click(reactivate);
    expect(changed).toEqual([]);
    expect(calls.some((call) => call.includes('/reactivate'))).toBe(false);

    const remove = screen.getByRole('button', { name: 'Remover o acesso de João Lima' });
    expect(remove.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(remove);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remover acesso' }));
    await waitFor(() => expect(changed).toEqual([`remove:${joao.accessId}`]));

    const cancel = screen.getByRole('button', { name: 'Cancelar convite de carla@padaria.test' });
    expect(cancel.getAttribute('aria-disabled')).toBeNull();
  });
});
