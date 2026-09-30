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
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const agencyMe = { agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: true, role: { key: 'admin', name: 'Admin' }, permissions: ['colaborador.visualizar', 'cliente.visualizar'] };
const agencyMeB = { agencyId: AGENCY_B, agencyName: 'Agência Dois', isOwner: true, role: { key: 'admin', name: 'Admin' }, permissions: ['colaborador.visualizar', 'cliente.visualizar'] };
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

interface Scenario {
  readonly initiallyLoggedIn?: boolean;
  readonly loginError?: Response;
  readonly resolve?: unknown;
  /** Fails the first `resolve` only, so a retry can succeed. */
  readonly resolveErrorOnce?: Response;
}

/** Behaves like the real API: an authenticated route without a session answers 401 `UNAUTHENTICATED`. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls = { resolve: 0, login: 0, logout: 0, forgot: 0 };
  const forgotBodies: unknown[] = [];
  const lastContextBodies: unknown[] = [];
  let serverLoggedIn = scenario.initiallyLoggedIn ?? false;
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/session')) return serverLoggedIn ? json(sessionBody) : unauthenticated();
    if (url.endsWith('/me/last-context') && init?.method === 'PUT') {
      lastContextBodies.push(JSON.parse(String(init.body)));
      return noContent();
    }
    if (url.endsWith(`/agencies/${AGENCY_A}/me`)) return json(agencyMe);
    if (url.endsWith(`/agencies/${AGENCY_B}/me`)) return json(agencyMeB);
    if (url.endsWith('/auth/login')) {
      calls.login += 1;
      if (scenario.loginError !== undefined) return scenario.loginError;
      serverLoggedIn = true;
      return json({ user: sessionBody.user });
    }
    if (url.endsWith('/me/contexts/resolve')) {
      calls.resolve += 1;
      if (!serverLoggedIn) return unauthenticated();
      if (scenario.resolveErrorOnce !== undefined && calls.resolve === 1) return scenario.resolveErrorOnce;
      return json(scenario.resolve ?? { decision: 'enter', context: agencyA });
    }
    if (url.endsWith('/auth/logout')) { calls.logout += 1; if (!serverLoggedIn) return unauthenticated(); serverLoggedIn = false; return noContent(); }
    if (url.endsWith('/auth/password/forgot')) { calls.forgot += 1; forgotBodies.push(JSON.parse(String(init?.body))); return json({}); }
    if (url.endsWith('/auth/password/reset')) return noContent();
    throw new Error(`unexpected ${url}`);
  };
  return { impl, calls, forgotBodies, lastContextBodies, isServerLoggedIn: () => serverLoggedIn };
};

/** Mounts the real routes and a real session, wired as `app.tsx` does. */
function SessionHarness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

function LocationProbe({ probe }: { probe: { pathname: string } }) {
  probe.pathname = useLocation().pathname;
  return null;
}

const renderLogin = (impl: typeof fetch, options: { state?: unknown } = {}) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  const probe = { pathname: '' };
  const entry = options.state === undefined ? '/entrar' : { pathname: '/entrar', state: options.state };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <LocationProbe probe={probe} />
            <SessionHarness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, store };
};

const submit = (email: string, password: string): void => {
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
};

describe('LoginPage (/entrar)', () => {
  it('shows one message for a wrong password and keeps the typed e-mail', async () => {
    const { impl } = makeFetch({ loginError: json({ error: { code: 'INVALID_CREDENTIALS', message: 'x' } }, 401) });
    renderLogin(impl);
    submit('pessoa@example.test', 'a wrong password');

    expect((await screen.findByRole('alert')).textContent).toBe('E-mail ou senha incorretos.');
    expect((screen.getByLabelText('E-mail') as HTMLInputElement).value).toBe('pessoa@example.test');
  });

  it('shows the same message for an unknown e-mail', async () => {
    const { impl } = makeFetch({ loginError: json({ error: { code: 'INVALID_CREDENTIALS', message: 'x' } }, 401) });
    renderLogin(impl);
    submit('ninguem@example.test', 'a wrong password');
    expect((await screen.findByRole('alert')).textContent).toBe('E-mail ou senha incorretos.');
  });

  it('asks to try later on the rate limit', async () => {
    const { impl } = makeFetch({ loginError: json({ error: { code: 'RATE_LIMITED', message: 'x' } }, 429) });
    renderLogin(impl);
    submit('pessoa@example.test', 'a correct password');
    expect((await screen.findByRole('alert')).textContent).toContain('Muitas tentativas');
  });

  it('rejects a short password before calling the API', () => {
    const { impl, calls } = makeFetch();
    renderLogin(impl);
    submit('pessoa@example.test', 'short');
    expect(screen.getByText('A senha tem no mínimo 10 caracteres.')).toBeTruthy();
    expect(calls.login).toBe(0);
  });

  it('offers the invite line and the recovery link', () => {
    const { impl } = makeFetch();
    renderLogin(impl);
    expect(screen.getByText('O acesso ao Ageniza é por convite.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Esqueci minha senha' }).getAttribute('href')).toBe('/senha/esquecida');
  });

  it('goes to /contextos for select, and never stops on the workspace first', async () => {
    const { impl } = makeFetch({ resolve: { decision: 'select', contexts: [agencyA], highlighted: null } });
    const { probe } = renderLogin(impl);
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect(probe.pathname).toBe('/contextos'));
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('enters directly for a single context, at its own address, recording it as the last one', async () => {
    const { impl, lastContextBodies } = makeFetch({ resolve: { decision: 'enter', context: agencyA } });
    const { probe } = renderLogin(impl);
    submit('pessoa@example.test', 'a correct password');
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(lastContextBodies).toEqual([{ type: 'agency', agencyId: AGENCY_A }]);
  });

  it('shows a login failure message when the login itself fails', async () => {
    const { impl } = makeFetch({ loginError: json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) });
    renderLogin(impl);
    submit('pessoa@example.test', 'a correct password');

    expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível entrar. Tente de novo.');
  });

  it('retries only the resolve when it fails after a successful login', async () => {
    const { impl, calls } = makeFetch({ resolveErrorOnce: json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) });
    const { probe } = renderLogin(impl);
    submit('pessoa@example.test', 'a correct password');

    expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível carregar seus contextos');
    expect(calls.login).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    // The retry ran the resolve again; it did not ask for the password.
    expect(calls.login).toBe(1);
    expect(calls.resolve).toBe(2);
  });

  it('returns to the destination kept by the session guard, and ignores a hostile one', async () => {
    const good = makeFetch({ resolve: { decision: 'enter', context: agencyA } });
    const first = renderLogin(good.impl, { state: { sessionDestination: { path: '/convite/abc', savedAt: Date.now() } } });
    submit('pessoa@example.test', 'a correct password');
    await waitFor(() => expect(first.probe.pathname).toBe('/convite/abc'));

    cleanup();
    const hostile = makeFetch({ resolve: { decision: 'enter', context: agencyA } });
    const second = renderLogin(hostile.impl, { state: { sessionDestination: { path: '//evil.example', savedAt: Date.now() } } });
    submit('pessoa@example.test', 'a correct password');
    await waitFor(() => expect(second.probe.pathname).toBe(`/agencia/${AGENCY_A}`));
  });

  it('records the context of a saved destination, not the one resolve picked', async () => {
    const { impl, lastContextBodies } = makeFetch({ resolve: { decision: 'enter', context: agencyA } });
    const { probe } = renderLogin(impl, { state: { sessionDestination: { path: `/agencia/${AGENCY_B}`, savedAt: Date.now() } } });
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_B}`));
    // The destination wins over `enter`; recording the resolve context here would make the next
    // login enter an agency the person never used.
    expect(lastContextBodies).toEqual([{ type: 'agency', agencyId: AGENCY_B }]);
  });

  it('does not call resolve when the login carries an invite token, and goes to the invitation URL', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = renderLogin(impl, { state: { inviteToken: 'invite-token-value' } });
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect(probe.pathname).toBe('/convite/invite-token-value'));
    expect(calls.resolve).toBe(0);
  });

  it('carries the invite token into the recovery screen', async () => {
    const { impl, forgotBodies } = makeFetch();
    renderLogin(impl, { state: { inviteToken: 'invite-token-value' } });
    fireEvent.click(screen.getByRole('link', { name: 'Esqueci minha senha' }));

    await screen.findByRole('heading', { name: 'Recuperar acesso' });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'pessoa@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar link' }));
    await waitFor(() => expect(forgotBodies).toEqual([{ email: 'pessoa@example.test', inviteToken: 'invite-token-value' }]));
  });

  it('goes to /sem-acesso and ends the session for a zero-context account', async () => {
    const { impl } = makeFetch({ loginError: json({ error: { code: 'NO_CONTEXT_ACCESS', message: 'x' } }, 403) });
    const { probe, store } = renderLogin(impl);
    const end = vi.spyOn(store, 'end');
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect(probe.pathname).toBe('/sem-acesso'));
    expect(end).toHaveBeenCalled();
  });

  it('redirects a person who already has a session, through the resolve', async () => {
    const { impl, calls } = makeFetch({ initiallyLoggedIn: true, resolve: { decision: 'select', contexts: [agencyA], highlighted: null } });
    const { probe } = renderLogin(impl);
    await waitFor(() => expect(probe.pathname).toBe('/contextos'));
    expect(calls.resolve).toBeGreaterThan(0);
  });

  it('disables the button while sending, and sets the tab title', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { impl } = makeFetch();
    const gated: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/auth/login')) await gate;
      return impl(input, init);
    };
    renderLogin(gated);
    expect(document.title).toBe('Entrar — Ageniza');
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect((screen.getByRole('button', { name: 'Entrar' }) as HTMLButtonElement).disabled).toBe(true));
    release?.();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Agência Um' })).toBeTruthy());
  });
});
