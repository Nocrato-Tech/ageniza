// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { useCommittedLocation } from './location-probe-fixture.js';

afterEach(cleanup);

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

type ResetBody = { token?: string; newPassword?: string; inviteToken?: string };

interface Scenario {
  readonly authenticated?: boolean;
  readonly reset?: (body: ResetBody) => Response;
}

const noContent = (): Response => new Response(null, { status: 204 });

const makeFetch = (scenario: Scenario = {}) => {
  const calls = { reset: 0, resolve: 0, login: 0 };
  const resetBodies: ResetBody[] = [];
  const loginBodies: ResetBody[] = [];
  let serverLoggedIn = scenario.authenticated ?? false;
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/session')) return serverLoggedIn ? json(sessionBody) : unauthenticated();
    if (url.endsWith('/auth/login')) { calls.login += 1; loginBodies.push(JSON.parse(String(init?.body))); serverLoggedIn = true; return json({ user: sessionBody.user }); }
    if (url.endsWith('/auth/password/reset')) {
      calls.reset += 1;
      const body = JSON.parse(String(init?.body)) as ResetBody;
      resetBodies.push(body);
      const response = (scenario.reset ?? noContent)(body);
      // The API ends every session of the account on a successful reset, and creates none.
      if (response.ok) serverLoggedIn = false;
      return response;
    }
    if (url.endsWith('/me/contexts/resolve')) {
      calls.resolve += 1;
      return serverLoggedIn ? json({ decision: 'enter', context: agencyA }) : unauthenticated();
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
  useCommittedLocation((location) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
  });
  return null;
}
function SessionProbe({ store, probe }: { store: AuthSessionStore; probe: { sessionStatus: string } }) {
  probe.sessionStatus = useAuthSession(store).status;
  return null;
}

const renderReset = (impl: typeof fetch, search = '?token=reset-token') => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  const probe = { pathname: '', search: '', sessionStatus: '' };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[`/senha/redefinir${search}`]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <LocationProbe probe={probe} />
            <SessionProbe store={store} probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, store, queryClient };
};

const submit = (password: string): void => {
  fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
};

describe('ResetPasswordPage (/senha/redefinir)', () => {
  it('shows the invalid state with no token, and strips the URL', async () => {
    const { impl } = makeFetch();
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

  it('sends only the token and the new password, even when the link carries an invitation', async () => {
    const { impl, resetBodies } = makeFetch();
    const { probe } = renderReset(impl, '?token=reset-token&invite=invite-value');
    submit('a new correct password');

    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(resetBodies).toEqual([{ token: 'reset-token', newPassword: 'a new correct password' }]);
  });

  it('goes to the login with the notice, and neither signs in nor resolves', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = renderReset(impl);
    submit('a new correct password');

    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(screen.getByRole('status').textContent).toBe('Senha alterada. Entre com a nova senha.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(calls.login).toBe(0);
    expect(calls.resolve).toBe(0);
  });

  it('carries the invite token to the login, so the login continues the invitation', async () => {
    const { impl, loginBodies } = makeFetch();
    const { probe } = renderReset(impl, '?token=reset-token&invite=invite-value');
    submit('a new correct password');

    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(screen.getByRole('status').textContent).toBe('Senha alterada. Entre com a nova senha.');
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'pessoa@example.test' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'a new correct password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(loginBodies).toEqual([{ email: 'pessoa@example.test', password: 'a new correct password', inviteToken: 'invite-value' }]));
    await waitFor(() => expect(probe.pathname).toBe('/convite/invite-value'));
  });

  it('does not carry an invitation to the login when the link has none', async () => {
    const { impl, loginBodies } = makeFetch();
    const { probe } = renderReset(impl);
    submit('a new correct password');

    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'pessoa@example.test' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'a new correct password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(loginBodies).toEqual([{ email: 'pessoa@example.test', password: 'a new correct password' }]));
  });

  it('treats an out-of-shape invitation in the link as a broken link, before any request', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = renderReset(impl, `?token=reset-token&invite=${'i'.repeat(2_049)}`);
    submit('a new correct password');

    await screen.findByRole('heading', { name: 'Este link não é mais válido' });
    expect(calls.reset).toBe(0);
    await waitFor(() => expect(probe.search).toBe(''));
  });

  it('forgets the session this browser still held, so the login shows the notice instead of resolving', async () => {
    // The reset revoked every session of the account, but the store still believes in one: without
    // dropping it, the login screen would take it for valid and leave for the workspace.
    const { impl, calls } = makeFetch({ authenticated: true });
    const { probe } = renderReset(impl);
    await waitFor(() => expect(probe.sessionStatus).toBe('ready'));

    submit('a new correct password');

    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(screen.getByRole('status').textContent).toBe('Senha alterada. Entre com a nova senha.');
    await waitFor(() => expect(probe.sessionStatus).toBe('ready'));
    expect(calls.resolve).toBe(0);
    expect(probe.pathname).toBe('/entrar');
  });

  it('drops the previous account cache, so nothing of it outlives the reset', async () => {
    const { impl } = makeFetch({ authenticated: true });
    const { probe, queryClient } = renderReset(impl);
    await waitFor(() => expect(probe.sessionStatus).toBe('ready'));
    queryClient.setQueryData(['contexts', 'resolve', null], { decision: 'select', contexts: [], highlighted: null });

    submit('a new correct password');

    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(queryClient.getQueryData(['contexts', 'resolve', null])).toBeUndefined();
  });

  it('keeps the form and says so when the rate limit is hit', async () => {
    const { impl } = makeFetch({ reset: () => json({ error: { code: 'RATE_LIMITED', message: 'x' } }, 429) });
    const { probe } = renderReset(impl);
    submit('a new correct password');

    expect((await screen.findByRole('alert')).textContent).toBe('Muitas tentativas. Tente novamente mais tarde.');
    expect(probe.pathname).toBe('/senha/redefinir');
  });

  it('keeps the form and says the password was not saved on any other failure', async () => {
    const { impl } = makeFetch({ reset: () => json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) });
    const { probe } = renderReset(impl);
    submit('a new correct password');

    expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível salvar a nova senha. Tente de novo.');
    expect(probe.pathname).toBe('/senha/redefinir');
  });

  it('reports a password over 128 characters as too long, not too short', () => {
    const { impl, calls } = makeFetch();
    renderReset(impl);
    submit('a'.repeat(129));
    expect(screen.getByText('A senha pode ter no máximo 128 caracteres.')).toBeTruthy();
    expect(calls.reset).toBe(0);
  });

  it('puts the focus on the password when it is refused, with no alert besides its description', () => {
    const { impl } = makeFetch();
    renderReset(impl);
    submit('short');

    expect(document.activeElement).toBe(screen.getByLabelText('Nova senha'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('links the field error into the description', () => {
    const { impl } = makeFetch();
    renderReset(impl);
    submit('short');
    const input = screen.getByLabelText('Nova senha');
    expect(input.getAttribute('aria-describedby')).toContain('reset-password-error');
    expect(screen.getByText('A senha tem no mínimo 10 caracteres.')).toBeTruthy();
  });
});
