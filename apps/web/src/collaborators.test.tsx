// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

afterEach(cleanup);

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
  readonly collaborators?: (query: URLSearchParams, agencyId: string) => Response | Promise<Response>;
  readonly jobTitles?: () => Response | Promise<Response>;
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
    if (path.endsWith('/auth/session')) return authenticated ? json(sessionBody) : unauthenticated();
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(me[1]!, agencyDisplayName(me[1]!), permissions));
    if (path.endsWith('/collaborators/job-titles')) return scenario.jobTitles?.() ?? json({ data: ['Editora', 'Copywriter'] });
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
  navigate: (to: string) => void;
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
