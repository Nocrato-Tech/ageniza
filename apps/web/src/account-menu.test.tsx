// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore } from './auth.js';
import { AccountMenu } from './account-menu.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { createSessionEndSignal, SessionEndRedirect, sessionDestination } from './session-end.js';

afterEach(cleanup);

const USER_ID = '11111111-1111-4111-8111-111111111111';
const sessionBody = {
  user: { id: USER_ID, name: 'Pessoa', email: 'pessoa@example.test' },
  session: { expiresAt: '2026-01-01T00:00:00.000Z' }
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

interface LocationCapture {
  pathname: string;
  state: unknown;
}

function LocationProbe({ probe }: { probe: LocationCapture }) {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.state = location.state;
  return <output data-testid='location'>{location.pathname}</output>;
}

function renderAccountMenu(fetchImplementation: typeof fetch) {
  const queryClient = createQueryClient();
  queryClient.setQueryData(['private-account-data'], { name: 'Private data' });
  const signal = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', fetchImplementation, { onSessionEnded: signal.notify });
  const authStore = createAuthSessionStore(client);
  const probe: LocationCapture = { pathname: '', state: null };

  render(
    <AuthSessionProvider store={authStore}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={['/agencia/11111111-1111-4111-8111-111111111111']}>
            <SessionEndRedirect signal={signal} authStore={authStore} />
            <AccountMenu activeContext={'Agência Um'} />
            <LocationProbe probe={probe} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );

  return { queryClient, store: authStore, probe };
}

describe('AccountMenu', () => {
  it('shows the authenticated person and active context in the menu', async () => {
    renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      throw new Error('unexpected ' + String(input));
    });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    expect(screen.getByRole('group', { name: 'Conta' }).textContent).toContain('Pessoa');
    expect(screen.getByText('pessoa@example.test')).toBeTruthy();
    expect(screen.getByText('Agência Um')).toBeTruthy();
  });

  it('posts logout, clears the previous account cache, ends the local session, and returns to login', async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const { queryClient, store } = renderAccountMenu(async (input, init) => {
      const url = String(input);
      calls.push({ path: new URL(url).pathname, method: init?.method ?? 'GET' });
      if (url.endsWith('/auth/session')) return json(sessionBody);
      if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
      throw new Error('unexpected ' + url);
    });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sair' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/entrar'));
    expect(calls).toContainEqual({ path: '/auth/logout', method: 'POST' });
    expect(queryClient.getQueryData(['private-account-data'])).toBeUndefined();
    // The local session has to end, not only the server one; otherwise the next screen still believes
    // someone is signed in.
    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false, user: null });
  });

  it('treats a 401 on logout as a completed sign-out and stores no destination', async () => {
    const { queryClient, store, probe } = renderAccountMenu(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/session')) return json(sessionBody);
      if (url.endsWith('/auth/logout')) return unauthenticated();
      throw new Error('unexpected ' + url);
    });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sair' }));

    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    // The explicit sign-out must not leave the previous account's address for the next person.
    expect(sessionDestination(probe.state)).toBeNull();
    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false, user: null });
    expect(queryClient.getQueryData(['private-account-data'])).toBeUndefined();
  });

  it('requires confirmation before logout-all and uses the serious action style', async () => {
    const calls: string[] = [];
    renderAccountMenu(async (input, init) => {
      const url = String(input);
      calls.push((init?.method ?? 'GET') + ' ' + new URL(url).pathname);
      if (url.endsWith('/auth/session')) return json(sessionBody);
      if (url.endsWith('/auth/logout-all')) return new Response(null, { status: 204 });
      throw new Error('unexpected ' + url);
    });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    const logoutAll = screen.getByRole('menuitem', { name: 'Sair de todas as sessões' });
    expect(logoutAll.className).toContain('ui-menu-item--destructive');
    fireEvent.click(logoutAll);
    expect(calls).not.toContain('POST /auth/logout-all');

    const dialog = await screen.findByRole('dialog', { name: 'Sair de todas as sessões?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sair de todas as sessões' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/entrar'));
    expect(calls).toContain('POST /auth/logout-all');
  });

  it('offers a retry when logout fails and keeps the cache and the session until it succeeds', async () => {
    let attempts = 0;
    const { queryClient, store } = renderAccountMenu(async (input) => {
      const url = String(input);
      if (url.endsWith('/auth/session')) return json(sessionBody);
      if (url.endsWith('/auth/logout')) {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'Failure' } }, 500)
          : new Response(null, { status: 204 });
      }
      throw new Error('unexpected ' + url);
    });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sair' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível sair. Tente de novo.');
    // A failed sign-out must not drop the previous account's data or end the local session.
    expect(queryClient.getQueryData(['private-account-data'])).toBeDefined();
    expect(store.getSnapshot().isAuthenticated).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/entrar'));
    expect(attempts).toBe(2);
  });

  it('renders a hostile name and e-mail as literal text, never as HTML', async () => {
    // The e-mail field is a valid e-mail in the API contract, so the hostile value goes through the
    // render path directly to prove both fields are escaped, not interpreted.
    const hostile = '<img src=x onerror=alert(1)><script>window.__xss=1</script>';
    const client = new HttpClient('http://127.0.0.1:3001', async () => new Response(null, { status: 401 }));
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={['/agencia/11111111-1111-4111-8111-111111111111']}>
            <AccountMenu user={{ id: USER_ID, name: hostile, email: hostile }} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: /img/ }));
    const identity = screen.getByRole('group', { name: 'Conta' });
    expect(identity.textContent).toContain(hostile);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });
});
