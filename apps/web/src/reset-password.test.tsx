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
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

type ResetBody = { token?: string; newPassword?: string; inviteToken?: string };

interface Scenario {
  readonly reset: (body: ResetBody) => Response;
  readonly resolve?: unknown;
  readonly resolveErrorOnce?: boolean;
}

const makeFetch = (scenario: Scenario) => {
  const calls = { reset: 0, resolve: 0, login: 0 };
  const resetBodies: ResetBody[] = [];
  const loginBodies: ResetBody[] = [];
  let serverLoggedIn = false;
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/session')) return serverLoggedIn ? json(sessionBody) : unauthenticated();
    if (url.endsWith('/auth/login')) { calls.login += 1; loginBodies.push(JSON.parse(String(init?.body))); serverLoggedIn = true; return json({ user: sessionBody.user }); }
    if (url.endsWith('/auth/password/reset')) {
      calls.reset += 1;
      const body = JSON.parse(String(init?.body)) as ResetBody;
      resetBodies.push(body);
      const response = scenario.reset(body);
      const data = await response.clone().json().catch(() => undefined) as { signedIn?: boolean } | undefined;
      if (data?.signedIn === true) serverLoggedIn = true;
      return response;
    }
    if (url.endsWith('/me/contexts/resolve')) {
      calls.resolve += 1;
      if (!serverLoggedIn) return unauthenticated();
      if (scenario.resolveErrorOnce === true && calls.resolve === 1) return json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500);
      return json(scenario.resolve ?? { decision: 'enter', context: agencyA });
    }
    // The login with the token returns to /convite/:token; this screen is out of scope here.
    if (url.includes('/invitations/')) return json({ error: { code: 'INVALID_LINK', message: 'x' } }, 410);
    throw new Error(`unexpected ${url}`);
  };
  return { impl, calls, resetBodies, loginBodies };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}
function LocationProbe({ probe }: { probe: { pathname: string; search: string } }) {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.search = location.search;
  return null;
}

const renderReset = (impl: typeof fetch, search = '?token=reset-token') => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  const probe = { pathname: '', search: '' };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[`/senha/redefinir${search}`]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <LocationProbe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, store };
};

const submit = (password: string): void => {
  fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
};

describe('ResetPasswordPage (/senha/redefinir)', () => {
  it('shows the invalid state with no token, and strips the URL', async () => {
    const { impl } = makeFetch({ reset: () => json({ signedIn: true }) });
    const { probe } = renderReset(impl, '?invite=invite-value');
    await screen.findByRole('heading', { name: 'Este link não é mais válido' });
    await waitFor(() => expect(probe.search).toBe(''));
    expect(probe.pathname).toBe('/senha/redefinir');
  });

  it('shows the invalid state for a used or expired token, and strips the URL', async () => {
    const { impl } = makeFetch({ reset: () => json({ error: { code: 'INVALID_LINK', message: 'x' } }, 400) });
    const { probe } = renderReset(impl);
    submit('a new correct password');
    await screen.findByRole('heading', { name: 'Este link não é mais válido' });
    expect(screen.getByRole('link', { name: 'Pedir um novo link' }).getAttribute('href')).toBe('/senha/esquecida');
    await waitFor(() => expect(probe.search).toBe(''));
  });

  it('sends the token, the new password and the invite token in the body', async () => {
    // Like the API: the invitation continuation only applies when the body carries the token.
    const { impl, resetBodies } = makeFetch({ reset: (body) => body.inviteToken === 'invite-value' ? json({ signedIn: true }) : json({ signedIn: false, reason: 'NO_CONTEXT_ACCESS' }) });
    const { probe } = renderReset(impl, '?token=reset-token&invite=invite-value');
    submit('a new correct password');

    await waitFor(() => expect(probe.pathname).toBe('/convite/invite-value'));
    expect(resetBodies).toEqual([{ token: 'reset-token', newPassword: 'a new correct password', inviteToken: 'invite-value' }]);
  });

  it('authenticates and resolves when there is no invitation', async () => {
    const { impl, calls } = makeFetch({ reset: () => json({ signedIn: true }) });
    const { probe } = renderReset(impl);
    submit('a new correct password');
    await waitFor(() => expect(probe.pathname).toBe('/app'));
    expect(calls.resolve).toBe(1);
  });

  it('goes to /sem-acesso for NO_CONTEXT_ACCESS', async () => {
    const { impl } = makeFetch({ reset: () => json({ signedIn: false, reason: 'NO_CONTEXT_ACCESS' }) });
    const { probe } = renderReset(impl);
    submit('a new correct password');
    await waitFor(() => expect(probe.pathname).toBe('/sem-acesso'));
  });

  it('carries the invite token to the login on SIGN_IN_REQUIRED, so the login continues the invitation', async () => {
    const { impl, loginBodies } = makeFetch({ reset: () => json({ signedIn: false, reason: 'SIGN_IN_REQUIRED' }) });
    const { probe } = renderReset(impl, '?token=reset-token&invite=invite-value');
    submit('a new correct password');

    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(screen.getByRole('status').textContent).toContain('Senha redefinida. Entre com a nova senha.');
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'pessoa@example.test' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'a new correct password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(loginBodies).toEqual([{ email: 'pessoa@example.test', password: 'a new correct password', inviteToken: 'invite-value' }]));
  });

  it('offers a resolve-only retry when the resolve fails after a successful reset', async () => {
    const { impl, calls } = makeFetch({ reset: () => json({ signedIn: true }), resolveErrorOnce: true });
    const { probe } = renderReset(impl);
    submit('a new correct password');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Sua senha foi alterada');
    expect(alert.textContent).not.toContain('Não foi possível salvar');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(probe.pathname).toBe('/app'));
    expect(calls.reset).toBe(1);
    expect(calls.resolve).toBe(2);
  });

  it('reports a password over 128 characters as too long, not too short', () => {
    const { impl, calls } = makeFetch({ reset: () => json({ signedIn: true }) });
    renderReset(impl);
    submit('a'.repeat(129));
    expect(screen.getByText('A senha pode ter no máximo 128 caracteres.')).toBeTruthy();
    expect(calls.reset).toBe(0);
  });

  it('links the field error into the description', () => {
    const { impl } = makeFetch({ reset: () => json({ signedIn: true }) });
    renderReset(impl);
    submit('short');
    const input = screen.getByLabelText('Nova senha');
    expect(input.getAttribute('aria-describedby')).toContain('reset-password-error');
    expect(screen.getByText('A senha tem no mínimo 10 caracteres.')).toBeTruthy();
  });
});
