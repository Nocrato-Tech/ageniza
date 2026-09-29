// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const renderNoAccess = (store?: AuthSessionStore) => {
  const client = new HttpClient('http://127.0.0.1:3001', async () => new Response(null, { status: 204 }));
  const sessionStore = store ?? createAuthSessionStore(client);
  return render(
    <AuthSessionProvider store={sessionStore}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={['/sem-acesso']}>
            <ApplicationRoutes session={{ status: 'ready', isAuthenticated: false }} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};

describe('NoAccessPage (/sem-acesso)', () => {
  it('states the cause affirmatively and never mentions a password or credential', () => {
    renderNoAccess();

    expect(screen.getByRole('heading', { level: 1, name: 'Sua conta não tem acesso a nenhum espaço de trabalho' })).toBeTruthy();
    expect(screen.getByText(/o vínculo com a agência foi encerrado/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para entrar' }).getAttribute('href')).toBe('/entrar');
    expect(document.body.textContent ?? '').not.toMatch(/senha|credencial/i);
  });

  it('ends any remaining session while it is displayed', async () => {
    const client = new HttpClient('http://127.0.0.1:3001', async () => new Response(null, { status: 204 }));
    const store = createAuthSessionStore(client);
    const end = vi.spyOn(store, 'end');

    renderNoAccess(store);
    await waitFor(() => expect(end).toHaveBeenCalled());
  });
});
