// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore } from './auth.js';
import { AccountMenu } from './account-menu.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { createSessionEndSignal, SessionEndRedirect, sessionDestination } from './session-end.js';

afterEach(cleanup);

const USER_ID = '11111111-1111-4111-8111-111111111111';
const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const AGENCY_B = '22222222-2222-4222-8222-222222222222';
const CLIENT_C = '33333333-3333-4333-8333-333333333333';

const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const agencyB = { type: 'agency', agencyId: AGENCY_B, agencyName: 'Agência Dois', roleKey: 'production', roleName: 'Produção', isOwner: false };
const clientC = { type: 'client', clientId: CLIENT_C, clientName: 'Cliente Um', agencyId: AGENCY_A, agencyName: 'Agência Um', onboardingPending: false };

const sessionBody = {
  user: { id: USER_ID, name: 'Pessoa', email: 'pessoa@example.test' },
  session: { expiresAt: '2026-01-01T00:00:00.000Z' }
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' }
});
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

interface Call {
  path: string;
  method: string;
  body: unknown;
}

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

interface RenderOptions {
  /** Response for `GET /me/contexts`; two contexts by default. */
  contexts?: () => Response | Promise<Response>;
}

function renderAccountMenu(fetchImplementation: typeof fetch, options: RenderOptions = {}) {
  const queryClient = createQueryClient();
  queryClient.setQueryData(['private-account-data'], { name: 'Private data' });
  const signal = createSessionEndSignal();
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      path: new URL(url).pathname,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
    });
    if (url.endsWith('/me/contexts')) {
      return options.contexts === undefined ? json({ contexts: [agencyA, agencyB, clientC] }) : options.contexts();
    }
    return fetchImplementation(input, init);
  };
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: signal.notify });
  const authStore = createAuthSessionStore(client);
  const probe: LocationCapture = { pathname: '', state: null };

  render(
    <AuthSessionProvider store={authStore}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[`/agencia/${AGENCY_A}`]}>
            <SessionEndRedirect signal={signal} authStore={authStore} />
            <AccountMenu activeContext={'Agência Um'} />
            <LocationProbe probe={probe} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );

  return { queryClient, store: authStore, probe, calls };
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
    const { queryClient, store } = renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      if (String(input).endsWith('/auth/logout')) return new Response(null, { status: 204 });
      throw new Error('unexpected ' + String(input));
    });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sair' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/entrar'));
    expect(queryClient.getQueryData(['private-account-data'])).toBeUndefined();
    // The local session has to end, not only the server one; otherwise the next screen still believes
    // someone is signed in.
    expect(store.getSnapshot()).toEqual({ status: 'ready', isAuthenticated: false, user: null });
  });

  it('treats a 401 on logout as a completed sign-out and stores no destination', async () => {
    const { queryClient, store, probe } = renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      if (String(input).endsWith('/auth/logout')) return unauthenticated();
      throw new Error('unexpected ' + String(input));
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
    const { calls } = renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      if (String(input).endsWith('/auth/logout-all')) return new Response(null, { status: 204 });
      throw new Error('unexpected ' + String(input));
    });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    const logoutAll = screen.getByRole('menuitem', { name: 'Sair de todas as sessões' });
    expect(logoutAll.className).toContain('ui-menu-item--destructive');
    fireEvent.click(logoutAll);
    expect(calls.some((call) => call.method === 'POST' && call.path === '/auth/logout-all')).toBe(false);

    const dialog = await screen.findByRole('dialog', { name: 'Sair de todas as sessões?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sair de todas as sessões' }));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/entrar'));
    expect(calls.some((call) => call.method === 'POST' && call.path === '/auth/logout-all')).toBe(true);
  });

  it('offers a retry when logout fails and keeps the cache and the session until it succeeds', async () => {
    let attempts = 0;
    const { queryClient, store } = renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      if (String(input).endsWith('/auth/logout')) {
        attempts += 1;
        return attempts === 1
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'Failure' } }, 500)
          : new Response(null, { status: 204 });
      }
      throw new Error('unexpected ' + String(input));
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
          <MemoryRouter initialEntries={[`/agencia/${AGENCY_A}`]}>
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

  it('switches context by writing last-context, clearing the previous cache and navigating', async () => {
    const { queryClient, probe, calls } = renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      if (String(input).endsWith('/me/last-context')) return new Response(null, { status: 204 });
      throw new Error('unexpected ' + String(input));
    });
    queryClient.setQueryData(['agency', AGENCY_A, 'me'], { agencyId: AGENCY_A, agencyName: 'Agência Um' });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Trocar de contexto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Agência Dois/ }));

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_B}`));
    expect(calls).toContainEqual({ path: '/me/last-context', method: 'PUT', body: { type: 'agency', agencyId: AGENCY_B } });
    // The previous context's data is gone before the next one renders.
    expect(queryClient.getQueryData(['agency', AGENCY_A, 'me'])).toBeUndefined();
    // Switching never recreates the session.
    expect(calls.some((call) => call.path.startsWith('/auth/logout'))).toBe(false);
  });

  it('switches to a client portal at the portal address', async () => {
    const { probe, calls } = renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      if (String(input).endsWith('/me/last-context')) return new Response(null, { status: 204 });
      throw new Error('unexpected ' + String(input));
    });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Trocar de contexto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Cliente Um/ }));

    await waitFor(() => expect(probe.pathname).toBe(`/portal/${CLIENT_C}`));
    expect(calls).toContainEqual({ path: '/me/last-context', method: 'PUT', body: { type: 'client', clientId: CLIENT_C } });
  });

  it('does not offer context switching to a person with a single context', async () => {
    renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      throw new Error('unexpected ' + String(input));
    }, { contexts: () => json({ contexts: [agencyA] }) });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    await waitFor(() => expect(document.querySelector('.account-menu__loading')).toBeNull());
    expect(screen.queryByRole('menuitem', { name: /Trocar de contexto/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Sair' })).toBeTruthy();
  });

  it('shows a loading row while the context list loads', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<Response>((resolve) => { release = () => resolve(json({ contexts: [agencyA, agencyB] })); });
    renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      throw new Error('unexpected ' + String(input));
    }, { contexts: () => pending });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    expect(document.querySelector('.account-menu__loading')).not.toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Trocar de contexto/ })).toBeNull();

    await act(async () => { release?.(); });
    await screen.findByRole('menuitem', { name: /Trocar de contexto/ });
  });

  it('offers a retry when the context list fails', async () => {
    let attempts = 0;
    renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      throw new Error('unexpected ' + String(input));
    }, {
      contexts: () => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500)
          : json({ contexts: [agencyA, agencyB] });
      }
    });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
    expect(alert.textContent).toContain('Não foi possível carregar seus contextos.');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await screen.findByRole('menuitem', { name: /Trocar de contexto/ });
  });

  it('marks the current context and supports keyboard navigation and returning to the first level', async () => {
    renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      throw new Error('unexpected ' + String(input));
    });

    const trigger = await screen.findByRole('button', { name: /Pessoa/ });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('menuitem', { name: /Trocar de contexto/ }));

    // `/^Agência Um/` avoids the client item, whose "owning agency" line also says Agência Um.
    const current = await screen.findByRole('menuitem', { name: /^Agência Um/ });
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('menuitem', { name: /Agência Dois/ }).getAttribute('aria-current')).toBeNull();

    // The second level opens with focus on its first item, and arrows walk the list.
    const back = screen.getByRole('menuitem', { name: 'Trocar de contexto' });
    expect(document.activeElement).toBe(back);
    fireEvent.keyDown(back, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(current);

    // The back item returns to the first level without closing the menu.
    fireEvent.click(back);
    expect(screen.getByRole('menu', { name: 'Menu da conta' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Trocar de contexto/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /^Agência Um/ })).toBeNull();

    // Escape closes the menu and returns focus to the trigger.
    fireEvent.keyDown(screen.getByRole('menuitem', { name: /Trocar de contexto/ }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('focuses the context switcher when the list arrives after the menu opens', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<Response>((resolve) => { release = () => resolve(json({ contexts: [agencyA, agencyB] })); });
    renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      throw new Error('unexpected ' + String(input));
    }, { contexts: () => pending });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    // Before the list resolves the only item is Sair; the menu focuses it for now.
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Sair' }));

    await act(async () => { release?.(); });
    const switcher = await screen.findByRole('menuitem', { name: /Trocar de contexto/ });
    // When the real first item arrives, the menu must move focus onto it.
    await waitFor(() => expect(document.activeElement).toBe(switcher));
  });

  it('does not pull focus back to the first item when the person has already moved', async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<Response>((resolve) => { release = () => resolve(json({ contexts: [agencyA, agencyB] })); });
    renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      throw new Error('unexpected ' + String(input));
    }, { contexts: () => pending });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Sair' }), { key: 'ArrowDown' });
    const moved = screen.getByRole('menuitem', { name: 'Sair de todas as sessões' });
    expect(document.activeElement).toBe(moved);

    await act(async () => { release?.(); });
    await screen.findByRole('menuitem', { name: /Trocar de contexto/ });
    expect(document.activeElement).toBe(moved);
  });

  it('renders a hostile context name as literal text, never as HTML', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      throw new Error('unexpected ' + String(input));
    }, { contexts: () => json({ contexts: [{ ...agencyA, agencyName: hostile }, agencyB] }) });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Trocar de contexto/ }));

    const menu = screen.getByRole('menu', { name: 'Menu da conta' });
    expect(menu.textContent).toContain(hostile);
    expect(menu.querySelector('img')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('does not end the local session when switching context', async () => {
    const { store, probe } = renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      if (String(input).endsWith('/me/last-context')) return new Response(null, { status: 204 });
      throw new Error('unexpected ' + String(input));
    });
    const end = vi.spyOn(store, 'end');

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Trocar de contexto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Agência Dois/ }));

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_B}`));
    // Switching context is not signing out: the local session stays.
    expect(end).not.toHaveBeenCalled();
    expect(store.getSnapshot().isAuthenticated).toBe(true);
  });

  it('does not navigate when the last-context write is refused', async () => {
    const { probe } = renderAccountMenu(async (input) => {
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      if (String(input).endsWith('/me/last-context')) return json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500);
      throw new Error('unexpected ' + String(input));
    });

    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Trocar de contexto/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Agência Dois/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível trocar de contexto.');
    // The write failed, so the person stays where they were.
    expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`);
  });
});
