// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { portalClientBody } from './portal-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const agencyMe = { agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: true, role: { key: 'admin', name: 'Admin' }, permissions: [] };

// `/app` now lands on the context resolver, which reads the session store; the 401 here is the
// ordinary answer for a visitor and keeps the boundary test deterministic.
const unauthenticatedFetch: typeof fetch = async () => new Response(null, { status: 401 });
/** A valid session for the store; every other endpoint keeps answering like a visitor. */
const authenticatedFetch: typeof fetch = async (input) =>
  String(input).endsWith('/auth/session') ? json(sessionBody) : new Response(null, { status: 401 });
/** What `/entrar` with a valid session touches on its way to the active context. */
const signedInFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith('/auth/session')) return json(sessionBody);
  if (url.endsWith('/me/contexts/resolve')) return json({ decision: 'enter', context: agencyA });
  if (url.endsWith('/me/last-context') && init?.method === 'PUT') return new Response(null, { status: 204 });
  if (url.endsWith(`/agencies/${AGENCY_A}/me`)) return json(agencyMe);
  return new Response(null, { status: 401 });
};

function LocationProbe({ probe }: { probe: { pathname: string } }) {
  const location = useLocation();
  probe.pathname = location.pathname;
  return null;
}

const renderRoute = (path: string, isAuthenticated: boolean, impl: typeof fetch = unauthenticatedFetch) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl);
  const probe = { pathname: '' };
  render(
    <AuthSessionProvider store={createAuthSessionStore(client)}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}><MemoryRouter initialEntries={[path]}>
          <LocationProbe probe={probe} />
          <ApplicationRoutes session={{ status: 'ready', isAuthenticated, user: isAuthenticated ? sessionBody.user : null }} />
        </MemoryRouter></ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe };
};

/** Opens the account menu and asserts the person identity inside it, not only its trigger. */
const expectAccountMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /Pessoa/ }));
  const menu = screen.getByRole('menu', { name: 'Menu da conta' });
  expect(within(menu).getByText('Pessoa')).toBeTruthy();
  expect(within(menu).getByText('pessoa@example.test')).toBeTruthy();
};

describe('route boundaries', () => {
  it('keeps protected workspace content out of an anonymous route', () => {
    renderRoute('/app', false);
    expect(screen.getByRole('heading', { name: 'Workspace unavailable' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pessoa/ })).toBeNull();
  });

  it('sends /app to the resolve instead of rendering a workspace of its own', () => {
    renderRoute('/app', true);
    // `/app` is only a redirect now (issue #181): it lands on the context resolver, never on the
    // old placeholder.
    expect(screen.getByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('sends unknown paths to an accessible not-found boundary', () => {
    renderRoute('/missing', false);
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });

  it('keeps the account menu with the person identity on the context resolver', async () => {
    renderRoute('/contextos', true);
    expectAccountMenu();
    expect(screen.getByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy();
  });

  it('keeps the account menu with the person identity on the client portal', async () => {
    const clientId = '11111111-1111-4111-8111-111111111111';
    renderRoute(`/portal/${clientId}/inicio`, true, async (input) => (
      String(input).endsWith(`/clients/${clientId}`) ? json(portalClientBody(clientId, 'Cliente Um')) : authenticatedFetch(input)
    ));
    expect(await screen.findByRole('heading', { name: 'Olá, Pessoa' })).toBeTruthy();
    expectAccountMenu();
  });

  it('keeps the account menu on the global not-found when there is a session', () => {
    renderRoute('/rota-inexistente', true);
    expectAccountMenu();
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
  });
});

// Issue #342: the rule 11 exceptions. Each screen below opens for a valid session, because the
// invitation is accepted while signed in and the reset/confirmation links arrive by e-mail and may
// belong to another account; Terms and Privacy are public. None of them may bounce to the context.
describe('screens that open with a valid session (rule 11 exceptions, issue #342)', () => {
  it('opens the invitation so a signed-in person can accept it, without redirecting', async () => {
    const { probe } = renderRoute('/convite/um-token', true, authenticatedFetch);
    expect(await screen.findByRole('heading', { name: 'Convite' })).toBeTruthy();
    expect(probe.pathname).toBe('/convite/um-token');
    expect(screen.queryByRole('heading', { name: 'Onde você quer entrar?' })).toBeNull();
  });

  it('opens the password reset from the e-mail link with its form, without redirecting', async () => {
    // With a token the screen renders the form; a redirect added after the token check would bounce here.
    const { probe } = renderRoute('/senha/redefinir?token=um-token', true, authenticatedFetch);
    expect(await screen.findByRole('heading', { name: 'Definir nova senha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Salvar' })).toBeTruthy();
    expect(probe.pathname).toBe('/senha/redefinir');
  });

  it('opens the e-mail confirmation from the e-mail link with its button, without redirecting', async () => {
    const { probe } = renderRoute('/email/confirmar?token=um-token', true, authenticatedFetch);
    expect(await screen.findByRole('heading', { name: 'Confirmar novo e-mail' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Confirmar troca de e-mail' })).toBeTruthy();
    expect(probe.pathname).toBe('/email/confirmar');
  });

  it('opens the Terms of Use page, without redirecting', async () => {
    const { probe } = renderRoute('/termos', true, authenticatedFetch);
    expect(await screen.findByRole('heading', { name: 'Termos de Uso' })).toBeTruthy();
    expect(probe.pathname).toBe('/termos');
  });

  it('opens the Privacy Policy page, without redirecting', async () => {
    const { probe } = renderRoute('/privacidade', true, authenticatedFetch);
    expect(await screen.findByRole('heading', { name: 'Política de Privacidade' })).toBeTruthy();
    expect(probe.pathname).toBe('/privacidade');
  });

  it('still sends the common screens /sem-acesso and /senha/esquecida to the active context', async () => {
    const noAccess = renderRoute('/sem-acesso', true);
    await waitFor(() => expect(noAccess.probe.pathname).toBe('/contextos'));
    cleanup();
    const forgot = renderRoute('/senha/esquecida', true);
    await waitFor(() => expect(forgot.probe.pathname).toBe('/contextos'));
  });

  it('still sends /entrar to the active context, through the resolve', async () => {
    const { probe } = renderRoute('/entrar', true, signedInFetch);
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(screen.queryByRole('heading', { name: 'Entrar' })).toBeNull();
  });
});
