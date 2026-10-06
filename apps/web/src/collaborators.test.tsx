// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { pendingInviteExpiryLabel } from './pending-invitations.js';
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
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

const agencyMe = (agencyId: string, agencyName: string, permissions: readonly string[]) => ({
  agencyId, agencyName, isOwner: false, role: { key: 'admin', name: 'Admin' }, permissions
});
const agencyDisplayName = (agencyId: string): string => agencyId === AGENCY_B ? 'Agência Dois' : 'Agência Um';

const anaPrado = { membershipId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Ana Prado', email: 'ana@example.test', photoUrl: null, jobTitle: 'Editora', role: { key: 'production', name: 'Produção' }, isOwner: false, status: 'active', joinedAt: '2026-03-12T12:00:00.000Z' };
const marioCosta = { membershipId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Mário Costa', email: 'mario@example.test', photoUrl: null, jobTitle: 'Copywriter', role: { key: 'production', name: 'Produção' }, isOwner: false, status: 'active', joinedAt: '2026-03-13T12:00:00.000Z' };
const juliaReis = { membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Júlia Reis', email: 'julia@example.test', photoUrl: 'https://storage.test/julia.png', jobTitle: 'Social Media', role: { key: 'account_manager', name: 'Gestor de conta' }, isOwner: false, status: 'active', joinedAt: '2026-03-14T12:00:00.000Z' };
const biancaSouza = { membershipId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Bianca Souza', email: 'bianca@example.test', photoUrl: null, jobTitle: 'Redatora', role: { key: 'production', name: 'Produção' }, isOwner: false, status: 'active', joinedAt: '2026-03-15T12:00:00.000Z' };

const meta = (page: number, totalItems: number, totalPages: number) => ({ page, pageSize: 24, totalItems, totalPages });
const listResponse = (data: readonly unknown[], page = 1) => json({ data, meta: meta(page, data.length, data.length === 0 ? 0 : 1) });

const DAY_MS = 24 * 60 * 60 * 1000;

// Deadlines are built relative to the moment the module loads; the labels the screen shows are
// relative too, and the fractions keep every expected label away from a boundary.
const pendingInvite = (id: string, email: string, roleKey: string, roleName: string, remainingMs: number) => ({
  id,
  email,
  purpose: 'collaborator_invite',
  role: { key: roleKey, name: roleName },
  client: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  expiresAt: new Date(Date.now() + remainingMs).toISOString()
});
const inviteAna = pendingInvite('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'ana@exemplo.com', 'production', 'Produção', 5.5 * DAY_MS);
const invitePaulo = pendingInvite('ffffffff-ffff-4fff-8fff-ffffffffffff', 'paulo@exemplo.com', 'admin', 'Admin', 1.5 * DAY_MS);
const inviteJulia = pendingInvite('99999999-9999-4999-8999-999999999999', 'julia@exemplo.com', 'account_manager', 'Gestor de conta', 6.5 * DAY_MS);
const defaultInvites = [inviteAna, invitePaulo, inviteJulia];

const noContent = (): Response => new Response(null, { status: 204 });
const invitationsResponse = (data: readonly unknown[], query?: URLSearchParams, totals?: { totalItems: number; totalPages: number }): Response => {
  const page = Number(query?.get('page') ?? '1');
  return json({ data, meta: meta(page, totals?.totalItems ?? data.length, totals?.totalPages ?? (data.length === 0 ? 0 : 1)) });
};

interface Scenario {
  readonly authenticated?: boolean;
  readonly permissions?: readonly string[];
  readonly collaborators?: (query: URLSearchParams, agencyId: string) => Response | Promise<Response>;
  readonly jobTitles?: () => Response | Promise<Response>;
  readonly detail?: (membershipId: string, agencyId: string) => Response | Promise<Response>;
  readonly invitations?: (query: URLSearchParams, agencyId: string) => Response | Promise<Response>;
  readonly resend?: (invitationId: string, agencyId: string) => Response | Promise<Response>;
  readonly cancel?: (invitationId: string, agencyId: string) => Response | Promise<Response>;
}

/** Behaves like the real API: 401 without a session, the listing and the job-titles contract shapes. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const requests: string[] = [];
  const authenticated = scenario.authenticated ?? true;
  const permissions = scenario.permissions ?? ['colaborador.visualizar', 'colaborador.convidar', 'convite.reenviar', 'convite.cancelar'];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}${url.search}`);
    requests.push(String(input));
    if (path.endsWith('/auth/session')) return authenticated ? json(sessionBody) : unauthenticated();
    if (!authenticated) return unauthenticated();
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(me[1]!, agencyDisplayName(me[1]!), permissions));
    const resend = /\/agencies\/([^/]+)\/invitations\/([^/]+)\/resend$/.exec(path);
    if (resend !== null && method === 'POST') {
      if (!permissions.includes('convite.reenviar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      return scenario.resend?.(resend[2]!, resend[1]!) ?? json({ invitationId: inviteJulia.id, expiresAt: inviteJulia.expiresAt });
    }
    const cancel = /\/agencies\/([^/]+)\/invitations\/([^/]+)$/.exec(path);
    if (cancel !== null && method === 'DELETE') {
      if (!permissions.includes('convite.cancelar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      return scenario.cancel?.(cancel[2]!, cancel[1]!) ?? noContent();
    }
    const invitations = /\/agencies\/([^/]+)\/invitations$/.exec(path);
    if (invitations !== null && method === 'GET') {
      if (!permissions.includes('colaborador.convidar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      return scenario.invitations?.(url.searchParams, invitations[1]!) ?? invitationsResponse(defaultInvites, url.searchParams);
    }
    if (path.endsWith('/collaborators/job-titles')) return scenario.jobTitles?.() ?? json({ data: ['Editora', 'Copywriter'] });
    const detail = /\/agencies\/([^/]+)\/collaborators\/([^/]+)$/.exec(path);
    if (detail !== null) {
      if (!permissions.includes('colaborador.visualizar')) return json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
      const person = [anaPrado, marioCosta, juliaReis].find((item) => item.membershipId === detail[2]);
      return scenario.detail?.(detail[2]!, detail[1]!) ?? (person === undefined
        ? json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
        : json(person));
    }
    const list = /\/agencies\/([^/]+)\/collaborators$/.exec(path);
    if (list !== null) return scenario.collaborators?.(url.searchParams, list[1]!) ?? listResponse([anaPrado, marioCosta, juliaReis]);
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
  };
  return { impl, calls, requests };
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

const renderCollaborators = (impl: typeof fetch, entry = `/agencia/${AGENCY_A}/colaboradores`) => {
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

const badgeNames = (container: HTMLElement): (string | null)[] =>
  Array.from(container.querySelectorAll('.ui-badge-card__name')).map((element) => element.textContent);

describe('CollaboratorsPage (/agencia/:agenciaId/colaboradores)', () => {
  it('renders the badges in the order the server returned, without reordering', async () => {
    const { impl } = makeFetch();
    const { container } = renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    // The server order is Ana, Mário, Júlia — deliberately not alphabetical.
    expect(badgeNames(container)).toEqual(['Ana Prado', 'Mário Costa', 'Júlia Reis']);
  });

  it('asks for the first page with the fixed page size', async () => {
    const { impl, calls } = makeFetch();
    renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    expect(calls.some((call) => call === `GET /agencies/${AGENCY_A}/collaborators?page=1&pageSize=24`)).toBe(true);
  });

  it('shows the invite button only with colaborador.convidar', async () => {
    const without = makeFetch({ permissions: ['colaborador.visualizar'] });
    renderCollaborators(without.impl);
    await screen.findByText('Ana Prado');
    expect(screen.queryByRole('button', { name: /Convidar/ })).toBeNull();

    cleanup();
    const withPermission = makeFetch({ permissions: ['colaborador.visualizar', 'colaborador.convidar'] });
    renderCollaborators(withPermission.impl);
    expect(await screen.findByRole('button', { name: /Convidar/ })).toBeTruthy();
  });

  it('keeps the search term when there is no result and offers to clear it', async () => {
    const { impl } = makeFetch({
      collaborators: (query) => query.get('q') === 'mariana' ? listResponse([]) : listResponse([anaPrado, marioCosta, juliaReis])
    });
    const { probe } = renderCollaborators(impl);
    await screen.findByText('Ana Prado');

    const search = screen.getByRole('searchbox', { name: 'Buscar por nome ou e-mail' }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'mariana' } });

    expect(await screen.findByText('Nenhuma pessoa encontrada para "mariana"')).toBeTruthy();
    expect(search.value).toBe('mariana');
    expect(probe.search).toContain('q=mariana');

    fireEvent.click(screen.getByRole('button', { name: 'Limpar busca' }));
    expect(await screen.findByText('Ana Prado')).toBeTruthy();
    expect(probe.search).not.toContain('q=');
    expect((screen.getByRole('searchbox', { name: 'Buscar por nome ou e-mail' }) as HTMLInputElement).value).toBe('');
  });

  it('reads the filters from the URL, sends them to the server, and writes them back', async () => {
    const queries: string[] = [];
    const { impl } = makeFetch({
      collaborators: (query) => {
        queries.push(query.toString());
        // Three pages, so the requested page 2 is valid and the #229 redirect does not interfere.
        return json({ data: [anaPrado], meta: meta(Number(query.get('page') ?? '1'), 60, 3) });
      }
    });
    const { probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?q=ana&role=production&jobTitle=Editora&page=2`);

    await screen.findByText('Ana Prado');
    expect(queries.some((query) => query.includes('q=ana') && query.includes('role=production') && query.includes('jobTitle=Editora') && query.includes('page=2') && query.includes('pageSize=24'))).toBe(true);
    expect((screen.getByRole('searchbox', { name: 'Buscar por nome ou e-mail' }) as HTMLInputElement).value).toBe('ana');
    expect((screen.getByRole('combobox', { name: 'Papel' }) as HTMLSelectElement).value).toBe('production');

    fireEvent.change(screen.getByRole('combobox', { name: 'Papel' }), { target: { value: 'sales' } });
    await waitFor(() => expect(probe.search).toContain('role=sales'));
    // A filter change returns to the first page.
    expect(probe.search).not.toContain('page=');
  });

  it('shows the initials when the person has no photo, and the photo when they do', async () => {
    const { impl } = makeFetch();
    const { container } = renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    expect(screen.getByText('AP')).toBeTruthy();
    expect(screen.getByText('MC')).toBeTruthy();
    expect(screen.queryByText('JR')).toBeNull();
    expect(container.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe('https://storage.test/julia.png');
  });

  it('renders a hostile collaborator name as literal text, never as HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { impl } = makeFetch({ collaborators: () => listResponse([{ ...anaPrado, name: hostile }]) });
    const { container } = renderCollaborators(impl);

    await screen.findByText(hostile);
    expect(container.querySelector('img')).toBeNull();
  });

  it('draws a badge-shaped skeleton on the first load', async () => {
    const { impl } = makeFetch({ collaborators: () => new Promise<Response>(() => undefined) });
    const { container } = renderCollaborators(impl);

    await screen.findByRole('link', { name: 'Agência Um' });
    expect(container.querySelectorAll('.ui-badge-card__skeleton')).toHaveLength(24);
  });

  it('offers a retry when the listing fails', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      collaborators: () => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500)
          : listResponse([anaPrado]);
      }
    });
    renderCollaborators(impl);

    const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível carregar a equipe.');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await screen.findByText('Ana Prado');
  });

  it('disables the job-title filter when the job-titles route fails, without breaking the grid', async () => {
    const { impl } = makeFetch({ jobTitles: () => json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) });
    renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    const cargo = screen.getByRole('combobox', { name: 'Cargo' }) as HTMLSelectElement;
    await waitFor(() => expect(cargo.disabled).toBe(true), { timeout: 5000 });
  });

  it('draws no empty state for the team list', async () => {
    const { impl } = makeFetch({ collaborators: () => listResponse([]) });
    const { container } = renderCollaborators(impl);

    await waitFor(() => expect(container.querySelector('.collaborators__grid')).not.toBeNull());
    expect(screen.queryByText(/Nenhuma pessoa encontrada/)).toBeNull();
    expect(screen.queryByText(/Nenhum colaborador/)).toBeNull();
  });

  it('returns to the last valid page when the URL points past the end (#229)', async () => {
    const { impl } = makeFetch({
      collaborators: (query) => {
        const page = Number(query.get('page') ?? '1');
        // "Vendas" has seven people: one page. Page 2 exists in the URL but not on the server.
        return page > 1 ? json({ data: [], meta: meta(2, 7, 1) }) : json({ data: [anaPrado], meta: meta(1, 7, 1) });
      }
    });
    const { probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?role=sales&page=2`);

    // The out-of-range page must not read as "nobody found": it goes back to page 1 and shows them.
    await screen.findByText('Ana Prado');
    await waitFor(() => expect(probe.search).not.toContain('page='));
    expect(screen.queryByText(/Nenhuma pessoa encontrada/)).toBeNull();
  });

  // Review of #223, M1: without encoding, a `q` with `&role=admin`, `#` or `/` would smuggle or cut
  // parameters. The value must travel as one encoded segment.
  it('encodes the search value so it cannot smuggle another parameter (#223 review M1)', async () => {
    const hostile = 'a&role=admin#x/../';
    const { impl, requests } = makeFetch({ collaborators: () => listResponse([anaPrado]) });
    renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?q=${encodeURIComponent(hostile)}`);

    await screen.findByText('Ana Prado');
    const listRequest = requests.find((url) => url.includes('/collaborators?'));
    expect(listRequest).toBeDefined();
    const requested = new URL(listRequest!);
    expect(requested.searchParams.get('q')).toBe(hostile);
    expect(requested.searchParams.get('role')).toBeNull();
    expect(requested.searchParams.get('pageSize')).toBe('24');
  });

  // Review of #223, M2: the same QueryClient serves both agencies. The cache key carries the agency
  // id, so navigating directly to B never renders A's cached people.
  it('never shows one agency\'s people under another with the same cache (#223 review M2)', async () => {
    const { impl } = makeFetch({
      collaborators: (_query, agencyId) => listResponse(agencyId === AGENCY_B ? [biancaSouza] : [anaPrado])
    });
    const { container, probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores`);

    await within(container).findByText('Ana Prado');
    await act(async () => { probe.navigate(`/agencia/${AGENCY_B}/colaboradores`); });

    await within(container).findByText('Bianca Souza');
    expect(within(container).queryByText('Ana Prado')).toBeNull();
  });
});

describe('collaborator detail (#103)', () => {
  const listUrl = `/agencia/${AGENCY_A}/colaboradores`;
  const detailUrl = (id = anaPrado.membershipId) => `${listUrl}?colaborador=${encodeURIComponent(id)}`;
  const detailCalls = (calls: string[]) => calls.filter((call) => /\/collaborators\/(?!job-titles)/.test(call));

  it('opens the selected badge with its own API detail and disabled future tabs', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = renderCollaborators(impl);
    fireEvent.click(await screen.findByRole('link', { name: 'Ver detalhes de Mário Costa' }));

    const modal = await screen.findByRole('dialog', { name: 'Mário Costa' });
    expect(probe.search).toContain(`colaborador=${marioCosta.membershipId}`);
    expect(detailCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/collaborators/${marioCosta.membershipId}`]);
    expect(within(modal).getAllByText('mario@example.test')).toHaveLength(2);
    expect(within(modal).getByText('13/03/2026')).toBeTruthy();
    expect(within(modal).getByText('A troca de e-mail é feita pela operação.')).toBeTruthy();
    expect(within(modal).getByRole('tab', { name: 'Detalhes' }).getAttribute('aria-selected')).toBe('true');
    for (const name of ['Performance', 'Entregas']) expect(within(modal).getByRole('tab', { name }).hasAttribute('disabled')).toBe(true);
    expect(within(modal).getAllByText('Disponível quando o módulo de Tarefas existir.')).toHaveLength(2);
    expect(within(modal).queryByRole('textbox')).toBeNull();
    expect(modal.textContent).not.toMatch(/salário|remuneração|salvar|remover/i);
  });

  it('preserves page and all filters when closing, going back, and going forward', async () => {
    const { impl } = makeFetch({ collaborators: () => json({ data: [anaPrado], meta: meta(2, 60, 3) }) });
    const original = '?q=ana&role=production&jobTitle=Editora&page=2';
    const { probe } = renderCollaborators(impl, listUrl + original);
    const badge = await screen.findByRole('link', { name: 'Ver detalhes de Ana Prado' });
    badge.focus();
    fireEvent.click(badge);
    await screen.findByRole('dialog', { name: 'Ana Prado' });
    await act(async () => { await probe.navigate(-1); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(probe.search).toBe(original);
    expect(document.activeElement).toBe(badge);
    await act(async () => { await probe.navigate(1); });
    await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.click(screen.getByRole('button', { name: 'Fechar detalhe do colaborador' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(probe.search).toBe(original);
  });

  it('opens a copied URL without list history and closes into that filtered list', async () => {
    const { impl } = makeFetch();
    const { probe } = renderCollaborators(impl, detailUrl() + '&role=production');
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent(modal, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(probe.pathname).toBe(listUrl);
    expect(probe.search).toBe('?role=production');
  });

  it('only closes on a gesture that both starts and ends outside the modal', async () => {
    const { impl } = makeFetch();
    renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    vi.spyOn(modal, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 400, 400));
    const pointerDown = (x: number) => fireEvent(modal, new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: x }));
    pointerDown(150);
    fireEvent.click(modal, { clientX: 150, clientY: 150 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    pointerDown(150);
    fireEvent.click(modal, { clientX: 5, clientY: 5 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    pointerDown(5);
    fireEvent.click(modal, { clientX: 5, clientY: 5 });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows skeletons inside the modal while its request is pending', async () => {
    let finish: (value: Response) => void = () => undefined;
    const response = new Promise<Response>((resolve) => { finish = resolve; });
    const { impl } = makeFetch({ detail: () => response });
    renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog');
    expect(await within(modal).findByText('Carregando colaborador…')).toBeTruthy();
    expect(modal.querySelectorAll('.ui-skeleton')).toHaveLength(2);
    await act(async () => { finish(json(anaPrado)); });
    await screen.findByRole('dialog', { name: 'Ana Prado' });
  });

  it('keeps an error inside the modal and retries without closing it', async () => {
    let attempts = 0;
    const { impl } = makeFetch({ detail: () => ++attempts <= 2
      ? json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500)
      : json(anaPrado) });
    renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog');
    await within(modal).findByRole('alert', undefined, { timeout: 5000 });
    expect(modal.textContent).not.toContain('private diagnostic');
    fireEvent.click(within(modal).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('dialog', { name: 'Ana Prado' })).toBe(modal);
  });

  it.each([403, 404])('renders %i as the same not-found state, with a return to the list', async (status) => {
    const { impl } = makeFetch({ detail: () => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'sensitive detail' } }, status) });
    const { probe } = renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog');
    await within(modal).findByText('Colaborador não encontrado.');
    expect(within(modal).queryByRole('tablist')).toBeNull();
    expect(modal.textContent).not.toContain('sensitive detail');
    fireEvent.click(within(modal).getByRole('button', { name: 'Voltar à lista' }));
    expect(probe.search).toBe('');
  });

  it.each(['', '../me', '..%2Fme', 'not-a-uuid', 'x?role=admin#fragment'])('refuses a malformed membership id (%s) without a detail request', async (id) => {
    const { impl, calls } = makeFetch();
    renderCollaborators(impl, detailUrl(id));
    await screen.findByText('Colaborador não encontrado.');
    expect(detailCalls(calls)).toEqual([]);
  });

  it('does not load or reveal a detail without permission or an authenticated session', async () => {
    for (const scenario of [{ permissions: [] }, { authenticated: false }]) {
      const { impl, calls } = makeFetch(scenario);
      renderCollaborators(impl, detailUrl());
      if (scenario.authenticated === false) await screen.findByRole('heading', { name: 'Workspace unavailable' });
      else await screen.findByRole('heading', { name: 'Page not found' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(detailCalls(calls)).toEqual([]);
      cleanup();
    }
  });

  it('does not render another membership returned by a mismatched response', async () => {
    const { impl } = makeFetch({ detail: () => json(marioCosta) });
    renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog');
    await within(modal).findByRole('alert');
    expect(modal.textContent).not.toContain('Mário');
  });

  it('never reuses a cached detail across agencies, even with the same membership id in the URL', async () => {
    let finish: (value: Response) => void = () => undefined;
    const delayed = new Promise<Response>((resolve) => { finish = resolve; });
    const { impl, calls } = makeFetch({ detail: (_id, agencyId) => agencyId === AGENCY_A ? json(anaPrado) : delayed });
    const { probe } = renderCollaborators(impl, detailUrl());
    await screen.findByRole('dialog', { name: 'Ana Prado' });
    await act(async () => { await probe.navigate(`/agencia/${AGENCY_B}/colaboradores?colaborador=${anaPrado.membershipId}`); });
    const modal = await screen.findByRole('dialog', { name: 'Detalhe do colaborador' });
    expect(modal.textContent).not.toContain(anaPrado.email);
    await act(async () => { finish(json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)); });
    await within(modal).findByText('Colaborador não encontrado.');
    expect(detailCalls(calls)).toContain(`GET /agencies/${AGENCY_B}/collaborators/${anaPrado.membershipId}`);
  });

  it('keeps loaded details during revalidation, but hides them when access is refused', async () => {
    let finish: (value: Response) => void = () => undefined;
    const delayed = new Promise<Response>((resolve) => { finish = resolve; });
    let requests = 0;
    const { impl } = makeFetch({ detail: () => ++requests === 1 ? json(anaPrado) : delayed });
    const { queryClient } = renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    act(() => { void queryClient.invalidateQueries({ queryKey: ['agency', AGENCY_A, 'collaborators', 'detail'] }); });
    await waitFor(() => expect(requests).toBe(2));
    expect(modal.querySelector('.ui-skeleton')).toBeNull();
    expect(within(modal).getByRole('tab', { name: 'Detalhes' })).toBeTruthy();
    await act(async () => { finish(json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403)); });
    await within(modal).findByText('Colaborador não encontrado.');
    expect(modal.textContent).not.toContain(anaPrado.email);
    expect(within(modal).queryByRole('tablist')).toBeNull();
  });

  it('renders untrusted identity fields as text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { impl } = makeFetch({ detail: () => json({ ...anaPrado, name: hostile, jobTitle: hostile }) });
    renderCollaborators(impl, detailUrl());
    const modal = await screen.findByRole('dialog', { name: hostile });
    expect(modal.querySelector('img')).toBeNull();
    expect(modal.querySelector('[onerror]')).toBeNull();
  });
});

describe('pending invitations (#106)', () => {
  const invitesRegion = () => screen.findByRole('region', { name: 'Convites aguardando aceite' });
  const invitationsCalls = (calls: string[]) => calls.filter((call) => call.includes('/invitations'));

  it.each(['account_manager', 'production', 'sales', 'finance'])('does not exist for %s', async () => {
    const { impl, calls } = makeFetch({ permissions: ['colaborador.visualizar'] });
    renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    expect(screen.queryByText('Convites aguardando aceite')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Convites aguardando aceite' })).toBeNull();
    expect(invitationsCalls(calls)).toEqual([]);
  });

  it('lists e-mail, role and relative deadline, with the count in its own header', async () => {
    const { impl } = makeFetch();
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(await within(region).findByText('ana@exemplo.com')).toBeTruthy();
    expect(within(region).getByText('Produção')).toBeTruthy();
    expect(within(region).getByText('expira em 5 dias')).toBeTruthy();
    expect(within(region).getByText('paulo@exemplo.com')).toBeTruthy();
    expect(within(region).getByText('expira amanhã')).toBeTruthy();
    expect(region.querySelector('.invites__count')?.textContent).toBe('3');
    expect(within(region).getByRole('button', { name: 'Reenviar convite de ana@exemplo.com' })).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Cancelar convite de ana@exemplo.com' })).toBeTruthy();
  });

  it('draws a list-shaped skeleton on its first load', async () => {
    const { impl } = makeFetch({ invitations: () => new Promise<Response>(() => undefined) });
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(region.querySelectorAll('.ui-skeleton')).toHaveLength(3);
    expect(region.querySelector('.invites__count')).toBeNull();
    expect(await screen.findByText('Ana Prado')).toBeTruthy();
  });

  it('offers the invite action when no invitation is pending', async () => {
    const { impl } = makeFetch({ invitations: (query) => invitationsResponse([], query) });
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(await within(region).findByText('Nenhum convite aguardando aceite')).toBeTruthy();
    const invite = within(region).getByRole('button', { name: 'Convidar' });
    expect(invite.hasAttribute('disabled')).toBe(true);
    expect(invite.getAttribute('title')).toBe('O convite chega na próxima entrega.');
    expect(region.querySelector('.invites__count')?.textContent).toBe('0');
  });

  it('offers a retry when the invitations listing fails, without echoing the API message', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      invitations: (query) => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'private diagnostic' } }, 500)
          : invitationsResponse(defaultInvites, query);
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    const alert = await within(region).findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível carregar os convites.');
    expect(region.textContent).not.toContain('private diagnostic');

    fireEvent.click(within(region).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(region).findByText('ana@exemplo.com')).toBeTruthy();
  });

  it.each([403, 404])('stays out of the screen when the API answers %i', async (status) => {
    const { impl } = makeFetch({
      invitations: () => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'sensitive detail' } }, status)
    });
    renderCollaborators(impl);

    await screen.findByText('Ana Prado');
    await waitFor(() => expect(screen.queryByText('Convites aguardando aceite')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Convites aguardando aceite' })).toBeNull();
    expect(screen.queryByText('sensitive detail')).toBeNull();
  });

  it('ends the session when the API answers 401, never showing the invited e-mail', async () => {
    const { impl } = makeFetch({ invitations: () => unauthenticated() });
    renderCollaborators(impl);

    await screen.findByLabelText('E-mail');
    expect(screen.queryByText('ana@exemplo.com')).toBeNull();
  });

  it('keeps the section but hides the actions the role cannot perform', async () => {
    const { impl } = makeFetch({ permissions: ['colaborador.visualizar', 'colaborador.convidar'] });
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(await within(region).findByText('ana@exemplo.com')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: /Reenviar/ })).toBeNull();
    expect(within(region).queryByRole('button', { name: /Cancelar/ })).toBeNull();
  });

  it('resends, renews the deadline in place and says the previous link stopped working', async () => {
    let pending = [inviteAna];
    const renewedId = 'abababab-abab-4bab-8bab-abababababab';
    const renewedExpiry = new Date(Date.now() + 6.9 * DAY_MS).toISOString();
    const { impl, calls } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      resend: (invitationId) => {
        pending = pending.map((item) => item.id === invitationId ? { ...item, id: renewedId, expiresAt: renewedExpiry } : item);
        return json({ invitationId: renewedId, expiresAt: renewedExpiry });
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(await within(region).findByText('expira em 5 dias')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Reenviar convite de ana@exemplo.com' }));

    expect(await within(region).findByText('Convite reenviado para ana@exemplo.com. O link anterior deixou de valer.')).toBeTruthy();
    expect(await within(region).findByText('expira em 6 dias')).toBeTruthy();
    expect(calls).toContain(`POST /agencies/${AGENCY_A}/invitations/${inviteAna.id}/resend`);
  });

  it('keeps the row and allows repeating when resending fails', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      resend: () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: 'EMAIL_DELIVERY_FAILED', message: 'private diagnostic' } }, 502)
          : json({ invitationId: inviteJulia.id, expiresAt: inviteJulia.expiresAt });
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    const resend = await within(region).findByRole('button', { name: 'Reenviar convite de ana@exemplo.com' });
    fireEvent.click(resend);

    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível reenviar o convite.');
    expect(region.textContent).not.toContain('private diagnostic');
    expect(within(region).getByText('ana@exemplo.com')).toBeTruthy();

    fireEvent.click(resend);
    expect(await within(region).findByText('Convite reenviado para ana@exemplo.com. O link anterior deixou de valer.')).toBeTruthy();
  });

  it.each([403, 404])('shows an error and keeps the row when resend answers %i', async (status) => {
    const { impl } = makeFetch({
      resend: () => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'sensitive detail' } }, status)
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    fireEvent.click(await within(region).findByRole('button', { name: 'Reenviar convite de ana@exemplo.com' }));

    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível reenviar o convite.');
    expect(region.textContent).not.toContain('sensitive detail');
    expect(within(region).getByText('ana@exemplo.com')).toBeTruthy();
  });

  it('asks for confirmation before cancelling, and only removes after confirming', async () => {
    let pending = [inviteAna, invitePaulo];
    const { impl, calls } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      cancel: (invitationId) => {
        pending = pending.filter((item) => item.id !== invitationId);
        return noContent();
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    fireEvent.click(await within(region).findByRole('button', { name: 'Cancelar convite de ana@exemplo.com' }));

    const dialog = await screen.findByRole('dialog', { name: 'Cancelar este convite?' });
    expect(dialog.textContent).toContain('O link enviado para ana@exemplo.com deixa de valer imediatamente.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Voltar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((call) => call.startsWith(`DELETE /agencies/${AGENCY_A}/invitations/`))).toBe(false);
    expect(within(region).getByText('ana@exemplo.com')).toBeTruthy();

    fireEvent.click(within(region).getByRole('button', { name: 'Cancelar convite de ana@exemplo.com' }));
    const reopened = await screen.findByRole('dialog', { name: 'Cancelar este convite?' });
    fireEvent.click(within(reopened).getByRole('button', { name: 'Cancelar convite' }));

    await waitFor(() => expect(within(region).queryByText('ana@exemplo.com')).toBeNull());
    expect(region.querySelector('.invites__count')?.textContent).toBe('1');
    expect(calls).toContain(`DELETE /agencies/${AGENCY_A}/invitations/${inviteAna.id}`);
  });

  it('keeps the invitation when cancelling fails and allows repeating', async () => {
    let pending = [inviteAna];
    let attempts = 0;
    const { impl } = makeFetch({
      invitations: (query) => invitationsResponse(pending, query),
      cancel: () => {
        attempts += 1;
        if (attempts === 1) return json({ error: { code: 'INVITATION_NOT_PENDING', message: 'private diagnostic' } }, 409);
        pending = [];
        return noContent();
      }
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    const cancel = async (): Promise<void> => {
      fireEvent.click(await within(region).findByRole('button', { name: 'Cancelar convite de ana@exemplo.com' }));
      const dialog = await screen.findByRole('dialog', { name: 'Cancelar este convite?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar convite' }));
    };

    await cancel();
    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível cancelar o convite.');
    expect(region.textContent).not.toContain('private diagnostic');
    expect(within(region).getByText('ana@exemplo.com')).toBeTruthy();

    await cancel();
    await waitFor(() => expect(within(region).queryByText('ana@exemplo.com')).toBeNull());
  });

  it.each([403, 404])('shows an error and keeps the row when the cancellation answers %i', async (status) => {
    const { impl } = makeFetch({
      cancel: () => json({ error: { code: status === 403 ? 'FORBIDDEN' : 'NOT_FOUND', message: 'sensitive detail' } }, status)
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    fireEvent.click(await within(region).findByRole('button', { name: 'Cancelar convite de ana@exemplo.com' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar este convite?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar convite' }));

    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível cancelar o convite.');
    expect(region.textContent).not.toContain('sensitive detail');
    expect(within(region).getByText('ana@exemplo.com')).toBeTruthy();
  });

  it('reads its own page from the URL and writes it back, next to the team list', async () => {
    const pageInvites = (from: number, count: number) => Array.from({ length: count }, (_value, index) => {
      const position = from + index;
      return pendingInvite(`10000000-0000-4000-8000-${String(position).padStart(12, '0')}`, `p${position}@exemplo.com`, 'production', 'Produção', 5.5 * DAY_MS);
    });
    const { impl } = makeFetch({
      invitations: (query) => {
        const page = Number(query.get('page') ?? '1');
        return invitationsResponse(page === 2 ? pageInvites(24, 6) : pageInvites(0, 24), query, { totalItems: 30, totalPages: 2 });
      }
    });
    const { probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?convites=2`);

    const region = await invitesRegion();
    expect(await within(region).findByText('p24@exemplo.com')).toBeTruthy();
    expect(region.querySelector('.invites__count')?.textContent).toBe('30');
    // The team page has its own pagination; the invitations page never touches it.
    expect(probe.search).toContain('convites=2');

    fireEvent.click(within(region).getByRole('button', { name: 'Página anterior' }));
    await waitFor(() => expect(probe.search).not.toContain('convites='));
    expect(await within(region).findByText('p0@exemplo.com')).toBeTruthy();
  });

  it('returns to the last valid page instead of showing pending invitations as empty (#229)', async () => {
    const { impl } = makeFetch({
      invitations: (query) => {
        const page = Number(query.get('page') ?? '1');
        return page > 1
          ? invitationsResponse([], query, { totalItems: 3, totalPages: 1 })
          : invitationsResponse(defaultInvites, query, { totalItems: 3, totalPages: 1 });
      }
    });
    const { probe } = renderCollaborators(impl, `/agencia/${AGENCY_A}/colaboradores?convites=2`);

    const region = await invitesRegion();
    expect(await within(region).findByText('ana@exemplo.com')).toBeTruthy();
    await waitFor(() => expect(probe.search).not.toContain('convites='));
    expect(within(region).queryByText('Nenhum convite aguardando aceite')).toBeNull();
  });

  it('never shows one agency\'s invitations under another with the same cache', async () => {
    const { impl } = makeFetch({
      invitations: (_query, agencyId) => invitationsResponse(agencyId === AGENCY_B ? [invitePaulo] : [inviteAna])
    });
    const { probe } = renderCollaborators(impl);

    await screen.findByText('ana@exemplo.com');
    await act(async () => { probe.navigate(`/agencia/${AGENCY_B}/colaboradores`); });

    await screen.findByText('paulo@exemplo.com');
    expect(screen.queryByText('ana@exemplo.com')).toBeNull();
  });

  it('renders an untrusted role name as literal text', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { impl } = makeFetch({ invitations: (query) => invitationsResponse([{ ...inviteAna, role: { key: 'production', name: hostile } }], query) });
    renderCollaborators(impl);

    const region = await invitesRegion();
    expect(await within(region).findByText(hostile)).toBeTruthy();
    expect(region.querySelector('img')).toBeNull();
  });

  // Aceite: "Nenhum token de convite aparece na tela, em nenhum estado." A response carrying one
  // fails the strict contract instead of rendering it, in the listing and in the resend alike.
  it('never renders an invitation token, even if a response carries one', async () => {
    const { impl } = makeFetch({
      invitations: (query) => json({ data: [{ ...inviteAna, token: 'live-credential' }], meta: meta(Number(query.get('page') ?? 1), 1, 1) })
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    await within(region).findByRole('alert');
    expect(screen.queryByText('live-credential')).toBeNull();
  });

  it('does not render a token from the resend response either', async () => {
    const { impl } = makeFetch({
      resend: () => json({ invitationId: inviteJulia.id, expiresAt: inviteJulia.expiresAt, token: 'live-credential' })
    });
    renderCollaborators(impl);

    const region = await invitesRegion();
    fireEvent.click(await within(region).findByRole('button', { name: 'Reenviar convite de ana@exemplo.com' }));

    const alert = await within(region).findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível reenviar o convite.');
    expect(screen.queryByText('live-credential')).toBeNull();
  });
});

describe('pendingInviteExpiryLabel (#106)', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const at = (remainingMs: number) => new Date(now.getTime() + remainingMs).toISOString();

  it.each([
    [0.5 * DAY_MS, 'expira hoje'],
    [DAY_MS - 1, 'expira hoje'],
    [DAY_MS, 'expira amanhã'],
    [2 * DAY_MS - 1, 'expira amanhã'],
    [2 * DAY_MS, 'expira em 2 dias'],
    [5.5 * DAY_MS, 'expira em 5 dias'],
    [7 * DAY_MS, 'expira em 7 dias']
  ])('labels %d ms of remaining time as "%s"', (remainingMs, expected) => {
    expect(pendingInviteExpiryLabel(at(remainingMs), now)).toBe(expected);
  });

  it('does not claim an already-passed deadline expires today', () => {
    expect(pendingInviteExpiryLabel(at(-DAY_MS), now)).toBe('expirado');
    expect(pendingInviteExpiryLabel(at(0), now)).toBe('expirado');
  });
});

// Issue #228: the grid must close in 3 and 4 columns. The shell's `.agency-content` is 840px at its
// widest (72rem minus the 16rem nav, the gap and the padding), so the badge minimum has to let four
// columns fit. jsdom has no layout, so the test reads the real CSS value and applies the same math
// `repeat(auto-fill, minmax(..., 1fr))` does.
describe('collaborators grid columns (#228)', () => {
  const globalsCss = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');

  const gridMinRem = (): number => {
    const match = /\.collaborators__grid\s*\{[^}]*minmax\(([\d.]+)rem,\s*1fr\)/.exec(globalsCss);
    if (match === null) throw new Error('The collaborators grid min width was not found in globals.css.');
    return Number(match[1]);
  };

  const columnsFor = (availableWidthPx: number, minRem: number, gapRem = 1, rootFontSizePx = 16): number => {
    const minPx = minRem * rootFontSizePx;
    const gapPx = gapRem * rootFontSizePx;
    return Math.max(1, Math.floor((availableWidthPx + gapPx) / (minPx + gapPx)));
  };

  it('fits four columns in the 840px content area and three in a narrower one', () => {
    const minRem = gridMinRem();
    expect(columnsFor(840, minRem)).toBe(4);
    expect(columnsFor(700, minRem)).toBe(3);
  });

  it('keeps the gap on the spacing scale', () => {
    expect(globalsCss).toMatch(/\.collaborators__grid\s*\{[^}]*gap:\s*var\(--space-4\)/);
  });
});
