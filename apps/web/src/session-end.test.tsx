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
import { createSessionEndSignal, loginPathPreserving, SessionEndRedirect, sessionDestination } from './session-end.js';

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
let navigateTo: NavigateFunction = () => undefined;
function RouterProbe() {
  const location = useLocation();
  currentLocation = `${location.pathname}${location.search}${location.hash}`;
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
  </Routes>;
}

/** The same wiring as App, with a protected page that holds fetched data on screen. */
const renderSession = (initialPath: string, respond: (path: string) => Response) => {
  const signal = createSessionEndSignal();
  const httpClient = new HttpClient('http://127.0.0.1:3001', async (input) => respond(new URL(String(input)).pathname), { onSessionEnded: signal.notify });
  const store = createAuthSessionStore(httpClient);
  const queryClient = createQueryClient();
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

    expect(currentLocation).toBe('/entrar?destino=%2Fapp%2Fclientes%3Fpagina%3D2%23topo');
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeTruthy();
    expect(screen.queryByText('Old Client')).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false });
  });

  it('brings the person back to exactly the route they were on once authenticated again', async () => {
    let sessionAlive = true;
    let generation = 0;
    const { store, queryClient } = renderSession('/app/clientes?pagina=2#topo', (path) => {
      if (!sessionAlive) return unauthenticated();
      return path === '/auth/session' ? activeSession() : json(200, { names: [`Client v${generation}`] });
    });
    await screen.findByText('Client v0');

    sessionAlive = false;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ['clients'] }); });
    expect(currentLocation.startsWith('/entrar?')).toBe(true);

    // What the login screen does once the credential is accepted.
    sessionAlive = true;
    generation = 1;
    await act(async () => { await store.refresh(); });
    const destination = sessionDestination(currentLocation.slice(currentLocation.indexOf('?')));
    await act(async () => { navigateTo(destination ?? '/', { replace: true }); });

    expect(currentLocation).toBe('/app/clientes?pagina=2#topo');
    await screen.findByText('Client v1');
    expect(screen.queryByText('Client v0')).toBeNull();
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
  it('encodes the full address, and does not nest the login inside itself', () => {
    expect(loginPathPreserving({ pathname: '/app', search: '?a=1&b=2', hash: '#x' })).toBe('/entrar?destino=%2Fapp%3Fa%3D1%26b%3D2%23x');
    expect(loginPathPreserving({ pathname: '/entrar', search: '?destino=%2Fapp', hash: '' })).toBe('/entrar?destino=%2Fapp');
  });

  it('only returns destinations inside the application', () => {
    expect(sessionDestination('?destino=%2Fapp%2Fclientes%3Fpagina%3D2%23topo')).toBe('/app/clientes?pagina=2#topo');
    for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', 'javascript:alert(1)', 'app', '/entrar']) {
      expect(sessionDestination(`?${new URLSearchParams({ destino: unsafe }).toString()}`)).toBeNull();
    }
    expect(sessionDestination('')).toBeNull();
  });
});
