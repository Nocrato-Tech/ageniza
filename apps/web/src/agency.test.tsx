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
/** The real guard answers 400 for a malformed id (`tenancy/guards.ts`), not 404. */
const invalidAgencyId = (): Response => json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' } }, 400);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    const match = /\/agencies\/([^/?#]+)\/me$/.exec(url);
    if (match !== null) {
      const agencyId = match[1]!;
      calls.push(`me:${agencyId}`);
      if (!uuidPattern.test(agencyId)) return invalidAgencyId();
      const handler = me[agencyId];
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
    expect(screen.getByText('Contexto ativo')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pessoa/ })).toBeTruthy();
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
    // The shell keeps the account menu: this is an authenticated screen with no other way out.
    expect(await screen.findByRole('button', { name: /Pessoa/ })).toBeTruthy();
  });

  it('keeps the account menu when the agency cannot be opened', async () => {
    const { impl } = makeFetch({ me: { [AGENCY_A]: () => json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) } });
    renderAgency(impl, `/agencia/${AGENCY_A}`);

    expect(await screen.findByRole('heading', { name: 'Não foi possível abrir a agência' }, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Pessoa/ })).toBeTruthy();
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

  it('treats a malformed :agenciaId as a bad address, without issuing any request', async () => {
    // The review's payload: the router decodes `%2F` and `%23`, so this used to become
    // `GET /me/contexts/resolve` with the victim's session.
    const traversal = makeFetch();
    renderAgency(traversal.impl, '/agencia/..%2Fme%2Fcontexts%2Fresolve%23');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(document.title).toBe('Page not found — Ageniza');
    expect(traversal.calls).toEqual([]);
    // A bad address still shows the authenticated shell, so the person can leave.
    expect(await screen.findByRole('button', { name: /Pessoa/ })).toBeTruthy();

    cleanup();
    const malformed = makeFetch();
    renderAgency(malformed.impl, '/agencia/nao-e-uuid');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /Pessoa/ })).toBeTruthy();
    // The fake would answer 400, like the API; no call proves the shell never asks.
    expect(malformed.calls).toEqual([]);
  });

  it('shows nothing of the previous agency while the new one loads', async () => {
    let releaseAgencyB: (() => void) | undefined;
    const agencyBGate = new Promise<void>((resolve) => { releaseAgencyB = resolve; });
    const impl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/session')) return json(sessionBody);
      if (url.endsWith(`/agencies/${AGENCY_A}/me`)) return json(agencyMe(AGENCY_A, 'Agência Um', ['colaborador.visualizar']));
      if (url.endsWith(`/agencies/${AGENCY_B}/me`)) {
        await agencyBGate;
        return json(agencyMe(AGENCY_B, 'Agência Dois', ['cliente.visualizar']));
      }
      throw new Error(`unexpected ${url}`);
    };
    const { probe, container } = renderAgency(impl, `/agencia/${AGENCY_A}`);
    await within(container).findByRole('link', { name: 'Agência Um' });

    await navigate(probe, `/agencia/${AGENCY_B}/colaboradores`);

    // While B is in flight: the shell skeleton, never A's name, menu or module, and never a false
    // "não encontrado" for an agency that is loading. A shared cache key or `placeholderData: prev`
    // brings A back here, and the mismatch check alone would turn that into a premature not-found.
    expect(container.querySelector('.agency-header__skeleton')).not.toBeNull();
    // The loading shell keeps the account menu too, so a slow or failing load never traps the person.
    expect(within(container).getByRole('button', { name: /Pessoa/ })).toBeTruthy();
    expect(within(container).queryByRole('link', { name: 'Agência Um' })).toBeNull();
    expect(within(container).queryByRole('link', { name: 'Colaboradores' })).toBeNull();
    expect(within(container).queryByRole('heading', { name: 'Colaboradores' })).toBeNull();
    expect(within(container).queryByRole('heading', { name: 'Page not found' })).toBeNull();
    expect(within(container).queryByRole('link', { name: 'Agência Dois' })).toBeNull();

    releaseAgencyB?.();
    await within(container).findByRole('link', { name: 'Agência Dois' });
    expect(within(container).queryByRole('link', { name: 'Agência Um' })).toBeNull();
  });

  it('refuses an answer that belongs to another agency', async () => {
    // Defense in depth: even if the API answered the wrong agency, nothing of it is shown.
    const { impl } = makeFetch({ me: { [AGENCY_A]: () => json(agencyMe(AGENCY_B, 'Agência Dois', ['cliente.visualizar'])) } });
    renderAgency(impl, `/agencia/${AGENCY_A}`);

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Agência Dois' })).toBeNull();
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

// Issue #193, from the re-review of #190: the corrections in `agency.tsx` and `routes.tsx` had no
// test, so `role="alert"` back on the `<main>` and a `<main>` nested inside the shell both passed.
// Every state of the shell must expose exactly one main landmark, never nested, and never with the
// alert role (which would announce the whole page to a screen reader).
describe('agency shell landmarks (#193)', () => {
  const expectSingleMain = (container: HTMLElement): void => {
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelectorAll('main main')).toHaveLength(0);
    expect(Array.from(container.querySelectorAll('main')).some((main) => main.getAttribute('role') === 'alert')).toBe(false);
  };

  it('exposes exactly one main in the loaded shell', async () => {
    const { impl } = makeFetch({ me: { [AGENCY_A]: () => json(agencyMe(AGENCY_A, 'Agência Um', ['colaborador.visualizar', 'cliente.visualizar'])) } });
    const { container } = renderAgency(impl, `/agencia/${AGENCY_A}`);

    await screen.findByRole('link', { name: 'Agência Um' });
    expectSingleMain(container);
  });

  it('keeps one main when a module is not permitted (not-found inside the shell)', async () => {
    const { impl } = makeFetch({ me: { [AGENCY_A]: () => json(agencyMe(AGENCY_A, 'Agência Um', ['cliente.visualizar'])) } });
    const { probe, container } = renderAgency(impl, `/agencia/${AGENCY_A}`);
    await screen.findByRole('link', { name: 'Agência Um' });

    await navigate(probe, `/agencia/${AGENCY_A}/colaboradores`);
    await screen.findByRole('heading', { name: 'Page not found' });
    expectSingleMain(container);
  });

  it('keeps one main for an unknown path inside the area (route `*`)', async () => {
    const { impl } = makeFetch({ me: { [AGENCY_A]: () => json(agencyMe(AGENCY_A, 'Agência Um', ['colaborador.visualizar'])) } });
    const { probe, container } = renderAgency(impl, `/agencia/${AGENCY_A}`);
    await screen.findByRole('link', { name: 'Agência Um' });

    await navigate(probe, `/agencia/${AGENCY_A}/caminho-inexistente`);
    await screen.findByRole('heading', { name: 'Page not found' });
    expectSingleMain(container);
  });

  it('keeps one main for an agency out of reach', async () => {
    const { impl } = makeFetch();
    const { container } = renderAgency(impl, `/agencia/${AGENCY_B}`);

    await screen.findByRole('heading', { name: 'Page not found' });
    expectSingleMain(container);
  });

  it('keeps one main for a malformed id, without any request', async () => {
    const { impl, calls } = makeFetch();
    const { container } = renderAgency(impl, '/agencia/nao-e-uuid');

    await screen.findByRole('heading', { name: 'Page not found' });
    expectSingleMain(container);
    expect(calls).toEqual([]);
  });

  it('keeps one main when the answer belongs to another agency', async () => {
    const { impl } = makeFetch({ me: { [AGENCY_A]: () => json(agencyMe(AGENCY_B, 'Agência Dois', ['cliente.visualizar'])) } });
    const { container } = renderAgency(impl, `/agencia/${AGENCY_A}`);

    await screen.findByRole('heading', { name: 'Page not found' });
    expectSingleMain(container);
  });

  it('keeps the alert role off the main when the agency cannot be opened', async () => {
    const { impl } = makeFetch({ me: { [AGENCY_A]: () => json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) } });
    const { container } = renderAgency(impl, `/agencia/${AGENCY_A}`);

    // A 500 is retried once before the error screen replaces the skeleton.
    await screen.findByRole('heading', { name: 'Não foi possível abrir a agência' }, { timeout: 5000 });
    expectSingleMain(container);
    // The alert lives on an inner element, so the landmark itself is not announced as the alert.
    expect(container.querySelector('main [role="alert"]')).not.toBeNull();
  });

  it('keeps one main for an unknown top-level address with a session', async () => {
    const { impl } = makeFetch();
    const { container } = renderAgency(impl, '/rota-inexistente');

    await screen.findByRole('heading', { name: 'Page not found' });
    await waitFor(() => expect(container.querySelectorAll('main')).toHaveLength(1));
    expectSingleMain(container);
  });
});
