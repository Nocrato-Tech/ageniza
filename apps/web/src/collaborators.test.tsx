// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { PROFILE_PHOTO_MAX_BYTES } from '@ageniza/contracts';
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

interface Scenario {
  readonly authenticated?: boolean;
  readonly permissions?: readonly string[];
  readonly session?: () => Response | Promise<Response>;
  readonly collaborators?: (query: URLSearchParams, agencyId: string) => Response | Promise<Response>;
  readonly jobTitles?: () => Response | Promise<Response>;
  readonly detail?: (membershipId: string, agencyId: string) => Response | Promise<Response>;
  readonly updateProfile?: (body: unknown) => Response | Promise<Response>;
  readonly uploadPhoto?: (body: unknown) => Response | Promise<Response>;
}

/** Behaves like the real API: 401 without a session, the listing and the job-titles contract shapes. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const requests: string[] = [];
  const authenticated = scenario.authenticated ?? true;
  const permissions = scenario.permissions ?? ['colaborador.visualizar', 'colaborador.convidar'];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}${url.search}`);
    requests.push(String(input));
    if (path.endsWith('/auth/session')) return scenario.session?.() ?? (authenticated ? json(sessionBody) : unauthenticated());
    if (!authenticated) return unauthenticated();
    if (init?.method === 'PATCH' && path === '/me/profile') {
      if (scenario.updateProfile === undefined) throw new Error(`unexpected PATCH ${url}`);
      return scenario.updateProfile(JSON.parse(String(init.body)));
    }
    if (init?.method === 'POST' && path === '/me/photo') {
      if (scenario.uploadPhoto === undefined) throw new Error(`unexpected POST ${url}`);
      return scenario.uploadPhoto(JSON.parse(String(init.body)));
    }
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(me[1]!, agencyDisplayName(me[1]!), permissions));
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

interface SelfFetchOptions {
  readonly uploadImageUrl?: string;
  /** Returns a response the caller controls (a deferred promise, an error status, ...). */
  readonly uploadResponse?: (body: unknown) => Response | Promise<Response>;
}

/**
 * The session for this scenario is Ana herself: `/auth/session` answers her name, the listing and
 * the detail carry her as `agency_memberships` does in the real API, `PATCH /me/profile` changes
 * her name (and the session's, since both come from `auth."user"`), and `POST /me/photo` returns a
 * signed URL after recording her new photo -- exactly what the real routes do.
 */
const makeSelfFetch = (options: SelfFetchOptions = {}) => {
  // `photoUrl` starts null and becomes a signed URL after the upload, like the real person row.
  type SelfPerson = Omit<typeof anaPrado, 'photoUrl'> & { photoUrl: string | null };
  let person: SelfPerson = { ...anaPrado, photoUrl: null };
  let sessionName = person.name;
  const profileBodies: unknown[] = [];
  const photoBodies: unknown[] = [];
  const uploadSuccessUrl = options.uploadImageUrl ?? 'https://storage.test/ana-nova.png';
  const fetch = makeFetch({
    session: () => json({ user: { id: sessionBody.user.id, name: sessionName, email: anaPrado.email }, session: sessionBody.session }),
    collaborators: () => json({ data: [person, marioCosta, juliaReis], meta: meta(1, 3, 1) }),
    detail: (membershipId) => membershipId === person.membershipId
      ? json(person)
      : json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404),
    updateProfile: (body) => {
      profileBodies.push(body);
      const name = (body as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') {
        return json({ error: { code: 'VALIDATION_ERROR', message: 'invalid name' } }, 400);
      }
      person = { ...person, name: name.trim() };
      sessionName = person.name;
      return json({ id: sessionBody.user.id, name: person.name });
    },
    uploadPhoto: (body) => {
      photoBodies.push(body);
      if (options.uploadResponse !== undefined) return options.uploadResponse(body);
      person = { ...person, photoUrl: uploadSuccessUrl };
      return json({ imageUrl: person.photoUrl! });
    }
  });
  return { ...fetch, person: () => person, profileBodies, photoBodies };
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

describe('self profile editing (#108)', () => {
  const selfUrl = (id = anaPrado.membershipId) => `/agencia/${AGENCY_A}/colaboradores?colaborador=${id}`;
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const modalFileInput = (modal: HTMLElement): HTMLInputElement =>
    modal.querySelector('input[type="file"]') as HTMLInputElement;

  it('renders the own profile editable, with role fields read-only and their notes', async () => {
    const { impl } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    expect(name.value).toBe('Ana Prado');
    expect(within(modal).getByRole('button', { name: 'Trocar foto' })).toBeTruthy();
    expect(within(modal).getByRole('button', { name: 'Salvar' })).toBeTruthy();
    expect(within(modal).getByText('Editora')).toBeTruthy();
    expect(within(modal).getByText('Produção')).toBeTruthy();
    expect(within(modal).getByText('ana@example.test')).toBeTruthy();
    expect(within(modal).getByText('Quem administra a agência define o cargo.')).toBeTruthy();
    expect(within(modal).getByText('A troca de e-mail é feita pela operação.')).toBeTruthy();
    expect(within(modal).getByText('Esta foto aparece nos seus crachás em todas as agências.')).toBeTruthy();
    expect(within(modal).queryByRole('combobox')).toBeNull();
    // No photo yet: initials, never a generic icon.
    expect(within(modal).getByText('AP')).toBeTruthy();
    expect(modal.querySelector('img')).toBeNull();
  });

  it('does not send a blank or oversized name and shows the field error', async () => {
    const { impl, profileBodies } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    expect(await within(modal).findByText('Informe o seu nome.')).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(profileBodies).toEqual([]);

    fireEvent.change(name, { target: { value: 'x'.repeat(121) } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    expect(await within(modal).findByText('O nome pode ter no máximo 120 caracteres.')).toBeTruthy();
    expect(profileBodies).toEqual([]);
  });

  it('saves a new name that shows in the modal, the badge and the account menu at once', async () => {
    const { impl, profileBodies } = makeSelfFetch();
    const { container } = renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Ana Prado Silva' } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByRole('dialog', { name: 'Ana Prado Silva' })).toBe(modal);
    await waitFor(() => expect(profileBodies).toContainEqual({ name: 'Ana Prado Silva' }));
    expect(modal.querySelector('.collaborator-detail__self-name')?.textContent).toBe('Ana Prado Silva');
    const badgeName = (): string | null | undefined =>
      container.querySelector('.collaborators__grid .ui-badge-card__name')?.textContent;
    await waitFor(() => expect(badgeName()).toBe('Ana Prado Silva'));
    // The app header reads the name from the session, so it must be fresh too.
    expect(await screen.findByRole('button', { name: 'Ana Prado Silva' })).toBeTruthy();
  });

  it('refuses a file outside the image allowlist without sending anything', async () => {
    const { impl, photoBodies } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.change(modalFileInput(modal), {
      target: { files: [new File(['<html>'], 'pagina.html', { type: 'text/html' })] }
    });
    expect(await within(modal).findByText('Formato não aceito. Envie uma foto PNG, JPEG, GIF ou WebP.')).toBeTruthy();
    expect(photoBodies).toEqual([]);
  });

  it('refuses a file above the accepted size without sending anything', async () => {
    const { impl, photoBodies } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.change(modalFileInput(modal), {
      target: { files: [new File([new Uint8Array(PROFILE_PHOTO_MAX_BYTES + 1)], 'grande.png', { type: 'image/png' })] }
    });
    expect(await within(modal).findByText('A foto passa do tamanho máximo aceito.')).toBeTruthy();
    expect(photoBodies).toEqual([]);
  });

  it('uploads with local progress without blocking the modal, and refreshes the badge', async () => {
    let finish: (value: Response) => void = () => undefined;
    const deferred = new Promise<Response>((resolve) => { finish = resolve; });
    const newPhoto = 'https://storage.test/ana-2026.png';
    const { impl, calls, photoBodies, person } = makeSelfFetch({ uploadResponse: () => deferred });
    const { probe } = renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.change(modalFileInput(modal), {
      target: { files: [new File([pngBytes], 'foto.png', { type: 'image/png' })] }
    });
    await waitFor(() => expect(photoBodies).toEqual([{ imageBase64: Buffer.from(pngBytes).toString('base64') }]), { timeout: 5000 });
    expect(modal.querySelector('progress')).toBeTruthy();
    expect(within(modal).getByText('Enviando foto…')).toBeTruthy();
    // Only the photo control is busy; the modal itself stays interactive.
    expect(within(modal).getByRole('button', { name: 'Trocar foto' }).hasAttribute('disabled')).toBe(true);
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    expect(name.disabled).toBe(false);
    await act(async () => {
      finish(json({ imageUrl: newPhoto }));
      person().photoUrl = newPhoto;
    });
    await waitFor(() => expect(modal.querySelector('img.ui-avatar__photo')?.getAttribute('src')).toBe(newPhoto));
    await waitFor(() => expect(document.querySelector('.collaborators__grid img.ui-avatar__photo')?.getAttribute('src')).toBe(newPhoto));
    // The photo travelled only the global route, never an agency-scoped one, and nothing reloaded.
    expect(calls.filter((call) => call.startsWith('POST /'))).toEqual(['POST /me/photo']);
    expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/colaboradores`);
    expect(screen.queryByText(/nesta agência/i)).toBeNull();
  });

  it.each([
    [415, 'UNSUPPORTED_MEDIA_TYPE', 'Formato não aceito. Envie uma foto PNG, JPEG, GIF ou WebP.'],
    [413, 'PAYLOAD_TOO_LARGE', 'A foto passa do tamanho máximo aceito.']
  ] as const)('shows the API\'s %i rejection as its own message', async (status, code, expected) => {
    const { impl, photoBodies } = makeSelfFetch({
      uploadResponse: () => json({ error: { code, message: 'the api private message' } }, status)
    });
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    fireEvent.change(modalFileInput(modal), {
      target: { files: [new File([pngBytes], 'foto.png', { type: 'image/png' })] }
    });
    expect(await within(modal).findByText(expected)).toBeTruthy();
    expect(photoBodies).toHaveLength(1);
    expect(modal.textContent).not.toContain('the api private message');
    expect(modal.querySelector('progress')).toBeNull();
  });

  it('keeps another person\'s name and photo read-only', async () => {
    const { impl } = makeFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    expect(within(modal).queryByRole('textbox')).toBeNull();
    expect(within(modal).queryByRole('button', { name: 'Trocar foto' })).toBeNull();
    expect(within(modal).queryByRole('button', { name: 'Salvar' })).toBeNull();
    expect(modal.querySelector('input[type="file"]')).toBeNull();
  });

  it('renders the typed name as literal text, never as HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { impl } = makeSelfFetch();
    renderCollaborators(impl, selfUrl());
    const modal = await screen.findByRole('dialog', { name: 'Ana Prado' });
    const name = within(modal).getByRole('textbox', { name: 'Nome' }) as HTMLInputElement;
    fireEvent.change(name, { target: { value: hostile } });
    fireEvent.click(within(modal).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(modal.querySelector('.collaborator-detail__self-name')?.textContent).toBe(hostile));
    expect(modal.querySelector('img')).toBeNull();
    expect(modal.querySelector('[onerror]')).toBeNull();
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
