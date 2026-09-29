// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });

interface Scenario {
  readonly initiallyLoggedIn?: boolean;
  readonly loginError?: Response;
  readonly resolve?: unknown;
  readonly resolveError?: Response;
}

const makeFetch = (scenario: Scenario = {}) => {
  const calls = { resolve: 0, login: 0, logout: 0, forgot: 0 };
  const forgotBodies: unknown[] = [];
  let loggedIn = scenario.initiallyLoggedIn ?? false;
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/auth/session')) return loggedIn ? json(sessionBody) : json({ error: { code: 'UNAUTHENTICATED', message: 'no' } }, 401);
    if (url.endsWith('/auth/login')) {
      calls.login += 1;
      if (scenario.loginError !== undefined) return scenario.loginError;
      loggedIn = true;
      return json({ user: sessionBody.user });
    }
    if (url.endsWith('/me/contexts/resolve')) {
      calls.resolve += 1;
      if (scenario.resolveError !== undefined) return scenario.resolveError;
      return json(scenario.resolve ?? { decision: 'enter', context: agencyA });
    }
    if (url.endsWith('/auth/logout')) { calls.logout += 1; loggedIn = false; return noContent(); }
    if (url.endsWith('/auth/password/forgot')) { calls.forgot += 1; forgotBodies.push(JSON.parse(String(init?.body))); return json({}); }
    throw new Error(`unexpected ${url}`);
  };
  return { impl, calls, forgotBodies };
};

/** Mounts the real routes and a real session, exactly as `app.tsx` wires them. */
function SessionHarness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

const renderLogin = (impl: typeof fetch, options: { state?: unknown; store?: AuthSessionStore } = {}) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl);
  const store = options.store ?? createAuthSessionStore(client);
  const entry = options.state === undefined ? '/entrar' : { pathname: '/entrar', state: options.state };
  return render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionHarness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
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

  it('goes to /contextos for select, and never stops on the workspace first', async () => {
    const { impl } = makeFetch({ resolve: { decision: 'select', contexts: [agencyA], highlighted: null } });
    renderLogin(impl);
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('enters directly for a single context', async () => {
    const { impl } = makeFetch({ resolve: { decision: 'enter', context: agencyA } });
    renderLogin(impl);
    submit('pessoa@example.test', 'a correct password');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy());
  });

  it('keeps the person on the login with a repeatable error when resolve fails', async () => {
    const { impl } = makeFetch({ resolveError: json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) });
    renderLogin(impl);
    submit('pessoa@example.test', 'a correct password');

    expect((await screen.findByRole('alert')).textContent).toContain('Não foi possível carregar seus contextos');
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('returns to the destination kept by the session guard, and ignores a hostile one', async () => {
    const good = makeFetch({ resolve: { decision: 'enter', context: agencyA } });
    renderLogin(good.impl, { state: { sessionDestination: { path: '/convite/abc', savedAt: Date.now() } } });
    submit('pessoa@example.test', 'a correct password');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy());

    cleanup();
    const hostile = makeFetch({ resolve: { decision: 'enter', context: agencyA } });
    renderLogin(hostile.impl, { state: { sessionDestination: { path: '//evil.example', savedAt: Date.now() } } });
    submit('pessoa@example.test', 'a correct password');
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy());
  });

  it('does not call resolve when the login carries an invite token', async () => {
    const { impl, calls } = makeFetch();
    renderLogin(impl, { state: { inviteToken: 'invite-token-value' } });
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy());
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

  it('leaves the login for a zero-context account (no-access route lands with #174)', async () => {
    const { impl } = makeFetch({ loginError: json({ error: { code: 'NO_CONTEXT_ACCESS', message: 'x' } }, 403) });
    renderLogin(impl);
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Ageniza' })).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('redirects a person who already has a session, through the resolve', async () => {
    const { impl, calls } = makeFetch({ initiallyLoggedIn: true, resolve: { decision: 'select', contexts: [agencyA], highlighted: null } });
    renderLogin(impl);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy());
    expect(calls.resolve).toBeGreaterThan(0);
  });

  it('disables the button while sending, and sets the tab title', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { impl } = makeFetch();
    const gated: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/auth/login')) { await gate; }
      return impl(input, init);
    };
    renderLogin(gated);
    expect(document.title).toBe('Entrar — Ageniza');
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect((screen.getByRole('button', { name: 'Entrar' }) as HTMLButtonElement).disabled).toBe(true));
    release?.();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy());
  });
});
