// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { LoginPage } from './login.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sessionBody = { user: { id: 'user-1', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const renderLogin = (fetchImpl: typeof fetch, store?: AuthSessionStore) => {
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  const sessionStore = store ?? createAuthSessionStore(client);
  return render(
    <AuthSessionProvider store={sessionStore}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={['/entrar']}>
            <Routes>
              <Route path="/entrar" element={<LoginPage />} />
              <Route path="/app" element={<h1>Workspace</h1>} />
              <Route path="/contextos" element={<h1>Escolher contexto</h1>} />
              <Route path="/sem-acesso" element={<h1>Sem acesso</h1>} />
            </Routes>
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

const successfulLogin = (resolveBody: unknown): typeof fetch => async (input) => {
  const url = String(input);
  if (url.endsWith('/auth/login')) return json({ user: sessionBody.user });
  if (url.endsWith('/auth/session')) return json(sessionBody);
  if (url.endsWith('/me/contexts/resolve')) return json(resolveBody);
  throw new Error(`unexpected ${url}`);
};

describe('LoginPage (/entrar)', () => {
  it('shows one message for a wrong password and keeps the typed e-mail', async () => {
    renderLogin(async () => json({ error: { code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas.' } }, 401));
    submit('pessoa@example.test', 'a wrong password');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('E-mail ou senha incorretos.');
    expect((screen.getByLabelText('E-mail') as HTMLInputElement).value).toBe('pessoa@example.test');
  });

  it('shows the same message for an unknown e-mail', async () => {
    renderLogin(async () => json({ error: { code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas.' } }, 401));
    submit('ninguem@example.test', 'a wrong password');

    expect((await screen.findByRole('alert')).textContent).toBe('E-mail ou senha incorretos.');
  });

  it('asks to try later on the rate limit', async () => {
    renderLogin(async () => json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, 429));
    submit('pessoa@example.test', 'a correct password');

    expect((await screen.findByRole('alert')).textContent).toContain('Muitas tentativas');
  });

  it('rejects a short password before calling the API', () => {
    let calls = 0;
    renderLogin(async () => { calls += 1; return json({}); });
    submit('pessoa@example.test', 'short');

    expect(screen.getByText('A senha tem no mínimo 10 caracteres.')).toBeTruthy();
    expect(calls).toBe(0);
  });

  it('enters directly when there is exactly one context', async () => {
    renderLogin(successfulLogin({ decision: 'enter', context: agencyA }));
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy());
  });

  it('goes to /contextos when there is more than one context', async () => {
    renderLogin(successfulLogin({ decision: 'select', contexts: [agencyA], highlighted: null }));
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Escolher contexto' })).toBeTruthy());
  });

  it('ends the session and shows no-access when the account has zero contexts', async () => {
    const client = new HttpClient('http://127.0.0.1:3001', async () => json({}));
    const store = createAuthSessionStore(client);
    const end = vi.spyOn(store, 'end');
    renderLogin(async () => json({ error: { code: 'NO_CONTEXT_ACCESS', message: 'Sem contexto.' } }, 403), store);
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sem acesso' })).toBeTruthy());
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('disables the button while sending', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    renderLogin(async (input) => {
      if (String(input).endsWith('/auth/login')) { await gate; return json({ user: sessionBody.user }); }
      if (String(input).endsWith('/auth/session')) return json(sessionBody);
      return json({ decision: 'enter', context: agencyA });
    });
    submit('pessoa@example.test', 'a correct password');

    await waitFor(() => expect((screen.getByRole('button', { name: 'Entrar' }) as HTMLButtonElement).disabled).toBe(true));
    release?.();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy());
  });

  it('sets the tab title and offers the invite line and the recovery link', () => {
    renderLogin(async () => json({}));
    expect(document.title).toBe('Entrar — Ageniza');
    expect(screen.getByRole('link', { name: 'Esqueci minha senha' }).getAttribute('href')).toBe('/senha/esquecida');
    expect(screen.getByText('O acesso ao Ageniza é por convite.')).toBeTruthy();
  });

  it('redirects a person who already has a session', () => {
    const client = new HttpClient('http://127.0.0.1:3001', async () => json({}));
    render(
      <AuthSessionProvider store={createAuthSessionStore(client)}>
        <QueryClientProvider client={createQueryClient()}>
          <ApiClientProvider client={client}>
            <MemoryRouter initialEntries={['/entrar']}>
              <ApplicationRoutes session={{ status: 'ready', isAuthenticated: true }} />
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </AuthSessionProvider>
    );
    expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy();
  });
});
