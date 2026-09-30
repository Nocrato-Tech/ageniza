// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

afterEach(cleanup);

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const AGENCY_B = '22222222-2222-4222-8222-222222222222';
const CLIENT_C = '33333333-3333-4333-8333-333333333333';

const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const agencyB = { type: 'agency', agencyId: AGENCY_B, agencyName: 'Agência Dois', roleKey: 'production', roleName: 'Produção', isOwner: false };
const clientC = { type: 'client', clientId: CLIENT_C, clientName: 'Cliente Um', agencyId: AGENCY_A, agencyName: 'Agência Um', onboardingPending: false };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

function LocationProbe({ probe }: { probe: { pathname: string } }) {
  probe.pathname = useLocation().pathname;
  return null;
}

const renderContexts = (
  fetchImpl: typeof fetch,
  options: { preferred?: string; store?: AuthSessionStore } = {}
) => {
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  const store = options.store ?? createAuthSessionStore(client);
  const path = options.preferred === undefined ? '/contextos' : `/contextos?preferred=${encodeURIComponent(options.preferred)}`;
  const probe = { pathname: '' };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <LocationProbe probe={probe} />
            <ApplicationRoutes session={{ status: 'ready', isAuthenticated: true, user: sessionBody.user }} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, store };
};

const selectResponse = { decision: 'select', contexts: [agencyA, agencyB, clientC], highlighted: agencyB };

const cardTexts = (): string[] => screen.getAllByRole('button')
  .filter((element) => element.classList.contains('ui-choice-card'))
  .map((element) => element.textContent ?? '');

describe('ContextSelectPage (/contextos)', () => {
  it('renders the resolve list in its own order, with kind, role and owning agency', async () => {
    renderContexts(async () => json(selectResponse));

    await screen.findByText('Área da agência · Admin');
    expect(screen.getByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy();
    expect(cardTexts()).toEqual([
      'Agência UmÁrea da agência · Admin',
      'SugeridoAgência DoisÁrea da agência · Produção',
      'Cliente UmPortal do cliente · Agência Um'
    ]);
  });

  it('communicates the highlighted context with visible text, not colour alone', async () => {
    renderContexts(async () => json(selectResponse));
    await screen.findByText('Área da agência · Admin');

    const highlighted = screen.getAllByRole('button').filter((element) => element.classList.contains('ui-choice-card--highlighted'));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]?.textContent).toContain('Sugerido');
    // Highlight is visual only: the workspace must not be entered by itself.
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('forwards the preferred context to resolve, which is what fills highlighted', async () => {
    const urls: string[] = [];
    renderContexts(async (input) => {
      urls.push(String(input));
      return json(selectResponse);
    }, { preferred: `agency:${AGENCY_B}` });

    await screen.findByText('Área da agência · Produção');
    expect(urls.some((url) => url.includes(`preferred=agency%3A${AGENCY_B}`))).toBe(true);
    expect(screen.getByRole('button', { name: /Agência Dois/ }).textContent).toContain('Sugerido');
  });

  it('normalizes an uppercase preferred UUID to lowercase before sending it', async () => {
    const withLetters = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const urls: string[] = [];
    renderContexts(async (input) => {
      urls.push(String(input));
      return json(selectResponse);
    }, { preferred: `agency:${withLetters.toUpperCase()}` });

    await screen.findByText('Área da agência · Produção');
    expect(urls.some((url) => url.includes(`preferred=agency%3A${withLetters}`))).toBe(true);
    expect(urls.some((url) => url.includes(withLetters.toUpperCase()))).toBe(false);
  });

  it('never calls /me/contexts, only resolve', async () => {
    const urls: string[] = [];
    renderContexts(async (input) => { urls.push(String(input)); return json(selectResponse); });

    await screen.findByText('Área da agência · Admin');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.endsWith('/me/contexts/resolve'))).toBe(true);
  });

  it('writes the chosen context to last-context and enters the workspace', async () => {
    const putBodies: unknown[] = [];
    renderContexts(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/me/contexts/resolve')) return json(selectResponse);
      if (url.endsWith('/me/last-context') && init?.method === 'PUT') {
        putBodies.push(JSON.parse(String(init.body)));
        return noContent();
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    });

    await screen.findByText('Área da agência · Admin');
    fireEvent.click(screen.getByRole('button', { name: /Cliente Um/ }));

    await waitFor(() => expect(putBodies).toEqual([{ type: 'client', clientId: CLIENT_C }]));
    // The client context enters the portal address, never `/app` (issue #181).
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Portal do cliente' })).toBeTruthy());
  });

  it('reloads the list on a 404 instead of resending the context that vanished', async () => {
    let resolveCalls = 0;
    let putCalls = 0;
    const withoutB = { decision: 'select', contexts: [agencyA, clientC], highlighted: null };
    renderContexts(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/me/contexts/resolve')) { resolveCalls += 1; return json(resolveCalls === 1 ? selectResponse : withoutB); }
      if (url.endsWith('/me/last-context') && init?.method === 'PUT') {
        putCalls += 1;
        return json({ error: { code: 'NOT_FOUND', message: 'Context not found.' } }, 404);
      }
      throw new Error(`unexpected ${url}`);
    });

    await screen.findByText('Área da agência · Admin');
    fireEvent.click(screen.getByRole('button', { name: /Agência Dois/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível entrar nesse contexto');
    await waitFor(() => expect(resolveCalls).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Agência Dois/ })).toBeNull());
    // The retry reloaded the list; it did not resend the context that no longer exists.
    expect(putCalls).toBe(1);
  });

  it('shows a repeatable error when signing out fails', async () => {
    let logoutCalls = 0;
    renderContexts(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/me/contexts/resolve')) return json(selectResponse);
      if (url.endsWith('/auth/logout') && init?.method === 'POST') {
        logoutCalls += 1;
        return logoutCalls === 1
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500)
          : noContent();
      }
      throw new Error(`unexpected ${url}`);
    });

    await screen.findByText('Área da agência · Admin');
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível sair');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    // The sign-out navigates away; the destination (login, or the workspace it redirects to) is not
    // this screen's contract, so assert the list is gone rather than a specific route.
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Onde você quer entrar?' })).toBeNull());
  });

  it('enters directly when resolve answers with a single context, at its own address', async () => {
    const putBodies: unknown[] = [];
    renderContexts(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/me/contexts/resolve')) return json({ decision: 'enter', context: agencyA });
      if (url.endsWith('/me/last-context') && init?.method === 'PUT') { putBodies.push(JSON.parse(String(init.body))); return noContent(); }
      if (url.endsWith(`/agencies/${AGENCY_A}/me`)) {
        return json({ agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: true, role: { key: 'admin', name: 'Admin' }, permissions: ['colaborador.visualizar', 'cliente.visualizar'] });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    });

    await waitFor(() => expect(screen.getByRole('link', { name: 'Agência Um' })).toBeTruthy());
    expect(putBodies).toEqual([{ type: 'agency', agencyId: AGENCY_A }]);
    expect(screen.queryByRole('heading', { name: 'Onde você quer entrar?' })).toBeNull();
  });

  it('ends the session and goes to /sem-acesso when resolve answers none', async () => {
    const client = new HttpClient('http://127.0.0.1:3001', async () => json({ decision: 'none' }));
    const store = createAuthSessionStore(client);
    const end = vi.spyOn(store, 'end');

    const { probe } = renderContexts(async () => json({ decision: 'none' }), { store });
    await waitFor(() => expect(end).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(probe.pathname).toBe('/sem-acesso'));
  });

  it('reaches /sem-acesso on none and never /entrar, with the real session and the session-ended redirect', async () => {
    const sessionEnd = createSessionEndSignal();
    let serverLoggedIn = true;
    const calls = { logout: 0 };
    // The real API answers 401 UNAUTHENTICATED on an authenticated route without a session.
    const client = new HttpClient('http://127.0.0.1:3001', async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/session')) return serverLoggedIn ? json(sessionBody) : unauthenticated();
      if (url.endsWith('/me/contexts/resolve')) { serverLoggedIn = false; return json({ decision: 'none' }); }
      if (url.endsWith('/auth/logout')) { calls.logout += 1; return unauthenticated(); }
      throw new Error(`unexpected ${url}`);
    }, { onSessionEnded: sessionEnd.notify });
    const queryClient = createQueryClient();
    const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
    const probe = { pathname: '' };
    function Harness() { const session = useAuthSession(store); return <ApplicationRoutes session={session} />; }
    render(
      <AuthSessionProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <ApiClientProvider client={client}>
            <MemoryRouter initialEntries={['/contextos']}>
              <SessionEndRedirect signal={sessionEnd} authStore={store} />
              <LocationProbe probe={probe} />
              <Harness />
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </AuthSessionProvider>
    );

    await waitFor(() => expect(probe.pathname).toBe('/sem-acesso'));
    // The none path never calls logout, so nothing 401s into the /entrar redirect.
    expect(calls.logout).toBe(0);
  });

  it('shows skeletons on the first load', () => {
    renderContexts(() => new Promise<Response>(() => undefined));
    expect(document.querySelectorAll('.ui-skeleton')).toHaveLength(2);
  });

  it('offers a retry when the resolve request fails', async () => {
    let attempts = 0;
    renderContexts(async () => {
      attempts += 1;
      if (attempts <= 2) return json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500);
      return json(selectResponse);
    });

    const retry = await screen.findByRole('button', { name: 'Tentar de novo' }, { timeout: 5000 });
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar seus contextos.');
    fireEvent.click(retry);
    await screen.findByText('Área da agência · Admin');
  });
});
