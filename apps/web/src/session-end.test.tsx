// @vitest-environment jsdom
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { BrowserConfig } from '@ageniza/config/browser';
import { App } from './app.js';
import { createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient, useApiClient } from './http.js';
import { createQueryClient } from './query.js';
import { ProtectedLayout } from './routes.js';
import { createSessionEndSignal, DESTINATION_TTL_MS, loginNavigation, MAX_DESTINATION_LENGTH, SessionEndRedirect, sessionDestination } from './session-end.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const activeSession = () => json(200, {
  user: { id: '11111111-1111-4111-8111-111111111111', name: 'Person', email: 'person@example.com' },
  session: { expiresAt: '2026-10-01T00:00:00.000Z' }
});
const unauthenticated = () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } });
const ClientsSchema = z.object({ names: z.array(z.string()) });

function ClientList() {
  const client = useApiClient();
  const clients = useQuery({ queryKey: ['clients'], queryFn: () => client.request({ path: '/clients', response: ClientsSchema }) });
  if (clients.isPending) return <p>Loading clients</p>;
  if (clients.isError) return <p>Clients failed</p>;
  return <ul>{clients.data.names.map((name) => <li key={name}>{name}</li>)}</ul>;
}

let currentLocation = '';
let currentState: unknown = null;
let navigateTo: NavigateFunction = () => undefined;
function RouterProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}${location.hash}`;
  currentState = location.state;
  navigateTo = useNavigate();
  return null;
}

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <Routes>
    <Route element={<ProtectedLayout session={session} />}>
      <Route path="app/clientes" element={<ClientList />} />
    </Route>
    <Route path="entrar" element={<h1>Entrar</h1>} />
    <Route path="convite/:token" element={<h1>Convite</h1>} />
    <Route path="senha/redefinir" element={<h1>Redefinir</h1>} />
  </Routes>;
}

/** The same wiring as App, with a protected page that holds fetched data on screen. */
const renderSession = (initialPath: string, respond: (path: string) => Response | Promise<Response>) => {
  const signal = createSessionEndSignal();
  const httpClient = new HttpClient('http://127.0.0.1:3001', async (input) => respond(new URL(String(input)).pathname), { onSessionEnded: signal.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(httpClient, { onSessionStarted: () => queryClient.clear() });
  render(<QueryClientProvider client={queryClient}><ApiClientProvider client={httpClient}>
    <MemoryRouter initialEntries={[initialPath]}>
      <SessionEndRedirect signal={signal} authStore={store} /><RouterProbe /><Harness store={store} />
    </MemoryRouter>
  </ApiClientProvider></QueryClientProvider>);
  return { httpClient, store, queryClient };
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('401 as the end of the session', () => {
  it('sends a 401 on any request to /entrar with the destination preserved, leaving nothing of the old session on screen', async () => {
    let sessionAlive = true;
    const { httpClient, store, queryClient } = renderSession('/app/clientes?pagina=2#topo', (path) => {
      if (!sessionAlive) return unauthenticated();
      return path === '/auth/session' ? activeSession() : json(200, { names: ['Old Client'] });
    });
    await screen.findByText('Old Client');

    sessionAlive = false;
    await act(async () => { await httpClient.request({ path: '/anything', method: 'POST', body: {}, response: z.unknown() }).catch(() => undefined); });

    expect(currentLocation).toBe('/entrar');
    expect(sessionDestination(currentState)).toBe('/app/clientes?pagina=2#topo');
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeTruthy();
    expect(screen.queryByText('Old Client')).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false });
  });

  it('brings the person back to exactly the route they were on once authenticated again', async () => {
    let sessionAlive = true;
    let version = 0;
    const { store, queryClient } = renderSession('/app/clientes?pagina=2#topo', (path) => {
      if (!sessionAlive) return unauthenticated();
      return path === '/auth/session' ? activeSession() : json(200, { names: [`Client v${version}`] });
    });
    await screen.findByText('Client v0');

    sessionAlive = false;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['clients'] }); });
    expect(currentLocation).toBe('/entrar');

    // What the login screen does once the credential is accepted.
    sessionAlive = true;
    version = 1;
    await act(async () => { await store.refresh(); });
    const destination = sessionDestination(currentState);
    await act(async () => { navigateTo(destination ?? '/', { replace: true }); });

    expect(currentLocation).toBe('/app/clientes?pagina=2#topo');
    await screen.findByText('Client v1');
    expect(screen.queryByText('Client v0')).toBeNull();
  });

  it('ends the session when a refresh finds it expired, and the next person signs in to an empty cache', async () => {
    let user: 'A' | 'B' | null = 'A';
    const { store, queryClient } = renderSession('/app/clientes', (path) => {
      if (user === null) return unauthenticated();
      return path === '/auth/session' ? activeSession() : json(200, { names: [`Agency ${user} client`] });
    });
    await screen.findByText('Agency A client');

    user = null;
    await act(async () => { await store.refresh(); });
    expect(currentLocation).toBe('/entrar');
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);

    // Whatever lands in the cache while signed out must not survive into the next person's session.
    queryClient.setQueryData(['clients'], { names: ['Agency A client'] });
    user = 'B';
    await act(async () => { await store.refresh(); });
    expect(queryClient.getQueryData(['clients'])).toBeUndefined();

    await act(async () => { navigateTo('/app/clientes', { replace: true }); });
    await screen.findByText('Agency B client');
    expect(screen.queryByText('Agency A client')).toBeNull();
  });

  it('keeps the new session when a late 401 from the ended one arrives after signing in again', async () => {
    let sessionAlive = true;
    const late: Array<(response: Response) => void> = [];
    const { httpClient, store } = renderSession('/app/clientes', (path) => {
      if (path.startsWith('/slow')) return new Promise<Response>((resolve) => { late.push(resolve); });
      if (!sessionAlive) return unauthenticated();
      return path === '/auth/session' ? activeSession() : json(200, { names: ['Current client'] });
    });
    await screen.findByText('Current client');

    const first = httpClient.request({ path: '/slow/1', response: z.unknown() }).catch(() => undefined);
    const second = httpClient.request({ path: '/slow/2', response: z.unknown() }).catch(() => undefined);
    await waitFor(() => expect(late).toHaveLength(2));
    await act(async () => { late[0]?.(unauthenticated()); await first; });
    expect(currentLocation).toBe('/entrar');

    sessionAlive = true;
    await act(async () => { await store.refresh(); });
    await act(async () => { navigateTo('/app/clientes', { replace: true }); });
    await screen.findByText('Current client');

    await act(async () => { late[1]?.(unauthenticated()); await second; });
    expect(currentLocation).toBe('/app/clientes');
    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: true });
    expect(screen.getByText('Current client')).toBeTruthy();
  });

  it.each([
    ['/convite/inv-secret-token', 'inv-secret-token'],
    ['/senha/redefinir?token=reset-secret&invite=inv-secret#frag-secret', 'secret']
  ])('never copies a credential-bearing address (%s) into the login URL', async (initialPath, secret) => {
    let sessionAlive = true;
    const { httpClient } = renderSession(initialPath, (path) => (sessionAlive && path === '/auth/session' ? activeSession() : unauthenticated()));
    await waitFor(() => expect(currentLocation).toBe(initialPath));
    await act(async () => { await httpClient.request({ path: '/auth/session', response: z.unknown() }); });

    sessionAlive = false;
    await act(async () => { await httpClient.request({ path: '/invitations/x/accept', method: 'POST', body: {}, response: z.unknown() }).catch(() => undefined); });

    expect(currentLocation).toBe('/entrar');
    expect(currentLocation).not.toContain(secret);
    expect(sessionDestination(currentState)).toBe(initialPath);
  });

  it('keeps a visitor on the page they opened: the 401 from GET /auth/session is not a session ending', async () => {
    window.history.replaceState(null, '', '/status');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => (new URL(String(input)).pathname === '/auth/session'
      ? unauthenticated()
      : json(200, { status: 'ok' })));
    vi.stubGlobal('fetch', fetchMock);
    const config: BrowserConfig = { environment: 'test', apiBaseUrl: 'http://127.0.0.1:3001', deployVersion: 'test' };

    render(<App config={config} />);
    await screen.findByText('API is ok.');
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/auth/session'))).toBe(true));

    expect(window.location.pathname).toBe('/status');
    expect(screen.getByRole('heading', { name: 'Service status' })).toBeTruthy();
  });
});

describe('preserved destination', () => {
  const now = 1_000_000;
  const stateFor = (path: string, savedAt = now) => ({ sessionDestination: { path, savedAt } });

  it('keeps the full address in navigation state, and only up to the length limit', () => {
    expect(loginNavigation({ pathname: '/app', search: '?a=1&b=2', hash: '#x' }, now)).toEqual({ to: '/entrar', state: stateFor('/app?a=1&b=2#x') });
    const atLimit = `/${'a'.repeat(MAX_DESTINATION_LENGTH - 1)}`;
    expect(loginNavigation({ pathname: atLimit, search: '', hash: '' }, now).state).toEqual(stateFor(atLimit));
    expect(loginNavigation({ pathname: `${atLimit}b`, search: '', hash: '' }, now)).toEqual({ to: '/entrar' });
  });

  it('only returns fresh destinations inside the application', () => {
    expect(sessionDestination(stateFor('/app/clientes?pagina=2#topo'), now)).toBe('/app/clientes?pagina=2#topo');
    expect(sessionDestination(stateFor('/app', now), now + DESTINATION_TTL_MS)).toBe('/app');
    expect(sessionDestination(stateFor('/app', now), now + DESTINATION_TTL_MS + 1)).toBeNull();
    expect(sessionDestination(stateFor('/app', now + 1), now)).toBeNull();
    expect(sessionDestination(stateFor(`/${'a'.repeat(MAX_DESTINATION_LENGTH)}`), now)).toBeNull();
    for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', 'javascript:alert(1)', 'app']) {
      expect(sessionDestination(stateFor(unsafe), now)).toBeNull();
    }
    for (const invalid of [null, undefined, '/app', { sessionDestination: '/app' }, { sessionDestination: { path: '/app' } }]) {
      expect(sessionDestination(invalid, now)).toBeNull();
    }
  });

  it('does not send the person back to the login under another spelling of it', () => {
    for (const login of ['/entrar', '/ENTRAR', '/Entrar', '/entrar/', '/%65ntrar', '/entrar?x=1']) {
      expect(sessionDestination(stateFor(login), now)).toBeNull();
    }
  });
});
