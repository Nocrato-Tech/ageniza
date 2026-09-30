// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
const agencyNotFound = (): Response => json({ error: { code: 'NOT_FOUND', message: 'Agency not found.' } }, 404);

const agencyMe = (agencyId: string, agencyName: string, permissions: readonly string[]) => ({
  agencyId, agencyName, isOwner: true, role: { key: 'admin', name: 'Admin' }, permissions
});

interface Scenario {
  readonly authenticated?: boolean;
  /** Mutable per agency, so a test can change the answer between two navigations. */
  readonly me?: Record<string, () => Response>;
}

/** Behaves like the real API: 401 without a session, 404 indistinct for an agency out of reach. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const authenticated = scenario.authenticated ?? true;
  const me = scenario.me ?? {};
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/session')) return authenticated ? json(sessionBody) : unauthenticated();
    const match = /\/agencies\/([0-9a-f-]+)\/me$/.exec(url);
    if (match !== null) {
      calls.push(`me:${match[1]}`);
      const handler = me[match[1]!];
      return handler === undefined ? agencyNotFound() : handler();
    }
    if (url.endsWith('/me/last-context') && init?.method === 'PUT') return new Response(null, { status: 204 });
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
  };
  return { impl, calls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface NavigationProbeTarget {
  pathname: string;
  navigate: (to: string) => void;
}

function NavigationProbe({ probe }: { probe: NavigationProbeTarget }) {
  probe.pathname = useLocation().pathname;
  probe.navigate = useNavigate();
  return null;
}

/** Mounts the real routes with a real session, wired the way `app.tsx` does. */
const renderAgency = (impl: typeof fetch, entry: string) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: NavigationProbeTarget = { pathname: '', navigate: () => undefined };
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <NavigationProbe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, container: rendered.container };
};

const navigate = async (probe: NavigationProbeTarget, to: string): Promise<void> => {
  await act(async () => { probe.navigate(to); });
};

describe('agency area shell (/agencia/:agenciaId)', () => {
  it('renders the agency name in the header and the menu built from its permissions', async () => {
    const { impl } = makeFetch({ me: { [AGENCY_A]: () => json(agencyMe(AGENCY_A, 'Agência Um', ['colaborador.visualizar', 'cliente.visualizar'])) } });
    renderAgency(impl, `/agencia/${AGENCY_A}`);

    await screen.findByRole('link', { name: 'Agência Um' });
    const nav = screen.getByRole('navigation', { name: 'Navegação da agência' });
    expect(within(nav).getByRole('link', { name: 'Início' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Colaboradores' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Clientes' })).toBeTruthy();
    // The home offers the same modules as shortcuts.
    expect(screen.getByRole('heading', { name: 'Agência Um' })).toBeTruthy();
  });

  it('hides a module the person cannot see and sends the typed URL to the same not-found', async () => {
    const { impl } = makeFetch({ me: { [AGENCY_A]: () => json(agencyMe(AGENCY_A, 'Agência Um', ['cliente.visualizar'])) } });
    const { probe } = renderAgency(impl, `/agencia/${AGENCY_A}`);

    await screen.findByRole('link', { name: 'Agência Um' });
    const nav = screen.getByRole('navigation', { name: 'Navegação da agência' });
    expect(within(nav).queryByRole('link', { name: 'Colaboradores' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Clientes' })).toBeTruthy();

    await navigate(probe, `/agencia/${AGENCY_A}/colaboradores`);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    // "Sem permissão" is not a screen of its own (specs/autorizacao.md section 7).
    expect(screen.queryByText(/sem permiss/i)).toBeNull();
  });

  it('answers the same not-found for an agency out of reach, without revealing whether it exists', async () => {
    const { impl, calls } = makeFetch();
    renderAgency(impl, `/agencia/${AGENCY_B}`);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(calls).toContain(`me:${AGENCY_B}`);
    expect(screen.queryByRole('heading', { name: 'Workspace unavailable' })).toBeNull();
  });

  it('turns the next navigation into not-found when the agency is suspended mid-use', async () => {
    const responses: Record<string, () => Response> = { [AGENCY_A]: () => json(agencyMe(AGENCY_A, 'Agência Um', ['cliente.visualizar'])) };
    const { impl } = makeFetch({ me: responses });
    const { probe } = renderAgency(impl, `/agencia/${AGENCY_A}`);

    await screen.findByRole('link', { name: 'Agência Um' });

    // The agency is suspended on the server; the next navigation revalidates the context.
    responses[AGENCY_A] = agencyNotFound;
    await navigate(probe, `/agencia/${AGENCY_A}/clientes`);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Agência Um' })).toBeNull();
  });

  it('never renders the area without a session: 401 keeps the session gate', async () => {
    const { impl, calls } = makeFetch({ authenticated: false });
    renderAgency(impl, `/agencia/${AGENCY_A}`);

    expect(await screen.findByRole('heading', { name: 'Workspace unavailable' })).toBeTruthy();
    expect(calls.filter((call) => call.startsWith('me:'))).toEqual([]);
  });

  it('keeps two tabs with different agencies apart: menu and cache follow the id in the route', async () => {
    const first = makeFetch({
      me: {
        [AGENCY_A]: () => json(agencyMe(AGENCY_A, 'Agência Um', ['colaborador.visualizar'])),
        [AGENCY_B]: () => json(agencyMe(AGENCY_B, 'Agência Dois', ['cliente.visualizar']))
      }
    });
    const second = makeFetch({
      me: {
        [AGENCY_A]: () => json(agencyMe(AGENCY_A, 'Agência Um', ['colaborador.visualizar'])),
        [AGENCY_B]: () => json(agencyMe(AGENCY_B, 'Agência Dois', ['cliente.visualizar']))
      }
    });
    const tabA = renderAgency(first.impl, `/agencia/${AGENCY_A}`);
    const tabB = renderAgency(second.impl, `/agencia/${AGENCY_B}`);

    await waitFor(() => expect(within(tabA.container).getByRole('link', { name: 'Agência Um' })).toBeTruthy());
    await waitFor(() => expect(within(tabB.container).getByRole('link', { name: 'Agência Dois' })).toBeTruthy());
    const navA = within(tabA.container).getByRole('navigation', { name: 'Navegação da agência' });
    const navB = within(tabB.container).getByRole('navigation', { name: 'Navegação da agência' });
    expect(within(navA).getByRole('link', { name: 'Colaboradores' })).toBeTruthy();
    expect(within(navA).queryByRole('link', { name: 'Clientes' })).toBeNull();
    expect(within(navB).getByRole('link', { name: 'Clientes' })).toBeTruthy();
    expect(within(navB).queryByRole('link', { name: 'Colaboradores' })).toBeNull();

    // Switching the agency in the same tab switches the whole context: the other agency's cached
    // answer is not reused, and nothing of the previous one stays on screen.
    await navigate(tabA.probe, `/agencia/${AGENCY_B}`);
    await waitFor(() => expect(within(tabA.container).getByRole('link', { name: 'Agência Dois' })).toBeTruthy());
    expect(within(tabA.container).queryByRole('link', { name: 'Agência Um' })).toBeNull();
    expect(within(tabA.container).queryByRole('link', { name: 'Colaboradores' })).toBeNull();
    expect(within(tabA.container).getByRole('link', { name: 'Clientes' })).toBeTruthy();
  });
});
