// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const renderForgot = (
  fetchImpl: typeof fetch,
  options: { authenticated?: boolean; state?: unknown } = {}
) => {
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  const store = createAuthSessionStore(client);
  const entry = options.state === undefined
    ? '/senha/esquecida'
    : { pathname: '/senha/esquecida', state: options.state };
  return render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <ApplicationRoutes session={{ status: 'ready', isAuthenticated: options.authenticated ?? false }} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};

const submitWith = (email: string): void => {
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar link' }));
};

describe('ForgotPasswordPage (/senha/esquecida)', () => {
  it('renders the form with a way back to /entrar and a document title', () => {
    renderForgot(async () => json({}));
    expect(screen.getByRole('heading', { name: 'Recuperar acesso' })).toBeTruthy();
    expect(screen.getByLabelText('E-mail')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para entrar' }).getAttribute('href')).toBe('/entrar');
    expect(document.title).toBe('Recuperar acesso — Ageniza');
  });

  it('redirects a person who already has a session', () => {
    renderForgot(async () => json({}), { authenticated: true });
    // The redirect goes through `/app`, which now lands on the context resolver (issue #181).
    expect(screen.getByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy();
    expect(screen.queryByLabelText('E-mail')).toBeNull();
  });

  it('rejects an invalid e-mail before calling the API', () => {
    let calls = 0;
    renderForgot(async () => { calls += 1; return json({}); });
    submitWith('not-an-email');

    expect(screen.getByText('Informe um e-mail válido.')).toBeTruthy();
    expect(calls).toBe(0);
  });

  it('confirms with one sentence and moves focus to the confirmation', async () => {
    const bodies: unknown[] = [];
    renderForgot(async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return json({}); });
    submitWith('someone@example.test');

    const heading = await screen.findByRole('heading', { name: 'Verifique seu e-mail' });
    expect(bodies).toEqual([{ email: 'someone@example.test' }]);
    expect(screen.getByText(/Se existir uma conta com esse endereço, o link chegou/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('sends the canonicalized address and the invite token from router state, never the URL', async () => {
    const bodies: unknown[] = [];
    renderForgot(
      async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return json({}); },
      { state: { inviteToken: 'invite-token-value' } }
    );
    submitWith('  Someone@Example.TEST ');

    await screen.findByRole('heading', { name: 'Verifique seu e-mail' });
    expect(bodies).toEqual([{ email: 'someone@example.test', inviteToken: 'invite-token-value' }]);
  });

  it('gives the rate limit its own message and keeps the typed address', async () => {
    renderForgot(async () => json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, 429));
    submitWith('someone@example.test');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Muitas tentativas');
    expect((screen.getByLabelText('E-mail') as HTMLInputElement).value).toBe('someone@example.test');
  });

  it('shows a generic, repeatable error on an unexpected failure', async () => {
    let attempts = 0;
    renderForgot(async () => { attempts += 1; return json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500); });
    submitWith('someone@example.test');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível enviar o link');
    expect(attempts).toBe(1);
    expect(screen.getByRole('button', { name: 'Enviar link' })).toBeTruthy();
  });
});
