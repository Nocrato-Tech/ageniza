// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const renderForgot = (fetchImpl: typeof fetch) => {
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <ApiClientProvider client={client}>
        <MemoryRouter initialEntries={['/senha/esquecida']}>
          <ApplicationRoutes session={{ status: 'ready', isAuthenticated: false }} />
        </MemoryRouter>
      </ApiClientProvider>
    </QueryClientProvider>
  );
};

const submitWith = (email: string): void => {
  fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar link' }));
};

describe('ForgotPasswordPage (/senha/esquecida)', () => {
  it('renders the form with a way back to /entrar', () => {
    renderForgot(async () => json({}));
    expect(screen.getByRole('heading', { name: 'Recuperar acesso' })).toBeTruthy();
    expect(screen.getByLabelText('E-mail')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para entrar' }).getAttribute('href')).toBe('/entrar');
  });

  it('rejects an invalid e-mail before calling the API', () => {
    let calls = 0;
    renderForgot(async () => { calls += 1; return json({}); });
    submitWith('not-an-email');

    expect(screen.getByText('Informe um e-mail válido.')).toBeTruthy();
    expect(calls).toBe(0);
  });

  it('confirms with one sentence that never reveals whether the account exists', async () => {
    const bodies: unknown[] = [];
    renderForgot(async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return json({}); });
    submitWith('someone@example.test');

    await screen.findByRole('heading', { name: 'Verifique seu e-mail' });
    expect(bodies).toEqual([{ email: 'someone@example.test' }]);
    expect(screen.getByText(/Se existir uma conta com esse endereço, o link chegou/)).toBeTruthy();
  });

  it('sends the canonicalized address', async () => {
    const bodies: unknown[] = [];
    renderForgot(async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return json({}); });
    submitWith('  Someone@Example.TEST ');

    await screen.findByRole('heading', { name: 'Verifique seu e-mail' });
    expect(bodies).toEqual([{ email: 'someone@example.test' }]);
  });

  it('gives the rate limit its own message and keeps the form usable', async () => {
    renderForgot(async () => json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, 429));
    submitWith('someone@example.test');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Muitas tentativas');
    expect(screen.getByRole('button', { name: 'Enviar link' })).toBeTruthy();
  });
});
