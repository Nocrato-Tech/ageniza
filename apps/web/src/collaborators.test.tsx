// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

afterEach(cleanup);

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

const agencyMe = (permissions: readonly string[]) => ({
  agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: false, role: { key: 'admin', name: 'Admin' }, permissions
});

const anaPrado = { membershipId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Ana Prado', email: 'ana@example.test', photoUrl: null, jobTitle: 'Editora', role: { key: 'production', name: 'Produção' }, isOwner: false, status: 'active', joinedAt: '2026-03-12T12:00:00.000Z' };
const marioCosta = { membershipId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Mário Costa', email: 'mario@example.test', photoUrl: null, jobTitle: 'Copywriter', role: { key: 'production', name: 'Produção' }, isOwner: false, status: 'active', joinedAt: '2026-03-13T12:00:00.000Z' };
const juliaReis = { membershipId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Júlia Reis', email: 'julia@example.test', photoUrl: 'https://storage.test/julia.png', jobTitle: 'Social Media', role: { key: 'account_manager', name: 'Gestor de conta' }, isOwner: false, status: 'active', joinedAt: '2026-03-14T12:00:00.000Z' };

const meta = (page: number, totalItems: number, totalPages: number) => ({ page, pageSize: 24, totalItems, totalPages });
const listResponse = (data: readonly unknown[], page = 1) => json({ data, meta: meta(page, data.length, data.length === 0 ? 0 : 1) });

interface Scenario {
  readonly authenticated?: boolean;
  readonly permissions?: readonly string[];
  readonly collaborators?: (query: URLSearchParams) => Response | Promise<Response>;
  readonly jobTitles?: () => Response | Promise<Response>;
}

/** Behaves like the real API: 401 without a session, the listing and the job-titles contract shapes. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const authenticated = scenario.authenticated ?? true;
  const permissions = scenario.permissions ?? ['colaborador.visualizar', 'colaborador.convidar'];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}${url.search}`);
    if (path.endsWith('/auth/session')) return authenticated ? json(sessionBody) : unauthenticated();
    if (/\/agencies\/[^/]+\/me$/.test(path)) return json(agencyMe(permissions));
    if (path.endsWith('/collaborators/job-titles')) return scenario.jobTitles?.() ?? json({ data: ['Editora', 'Copywriter'] });
    if (/\/agencies\/[^/]+\/collaborators$/.test(path)) {
      return scenario.collaborators?.(url.searchParams) ?? listResponse([anaPrado, marioCosta, juliaReis]);
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
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
}

function SearchProbe({ probe }: { probe: SearchProbeTarget }) {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.search = location.search;
  return null;
}

const renderCollaborators = (impl: typeof fetch, entry = `/agencia/${AGENCY_A}/colaboradores`) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: SearchProbeTarget = { pathname: '', search: '' };
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
      collaborators: (query) => { queries.push(query.toString()); return listResponse([anaPrado]); }
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
});
