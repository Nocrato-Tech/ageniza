// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const user = { id: AGENCY, name: 'Pessoa', email: 'pessoa@example.test' };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const agencyMe = { agencyId: AGENCY, agencyName: 'Agência Um', isOwner: true, membershipId: null, role: { key: 'admin', name: 'Admin' }, permissions: [] };

const fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/auth/session')) return json({ user, session: { expiresAt: '2026-01-01T00:00:00.000Z' } });
  if (url.endsWith(`/agencies/${AGENCY}/me`)) return json(agencyMe);
  return new Response(null, { status: 401 });
};

const theme = () => document.documentElement.getAttribute('data-theme');

const renderAt = (path: string, isAuthenticated = true) => {
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  return render(
    <AuthSessionProvider store={createAuthSessionStore(client)}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}><MemoryRouter initialEntries={[path]}>
          <ApplicationRoutes session={{ status: 'ready', isAuthenticated, user: isAuthenticated ? user : null }} />
          <Link to="/contextos">sair da agência</Link>
        </MemoryRouter></ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme of the areas', () => {
  it.each([
    ['the agency home', `/agencia/${AGENCY}`],
    ['a screen of the agency', `/agencia/${AGENCY}/clientes`],
    ['a deep address of the agency', `/agencia/${AGENCY}/clientes/${CLIENT}/geral`],
    ['an unknown address inside the agency', `/agencia/${AGENCY}/nao-existe`],
    ['an agency address that is not valid', '/agencia/nao-e-um-id']
  ])('is dark on %s', async (_name, path) => {
    renderAt(path);
    await waitFor(() => expect(theme()).toBe('dark'));
  });

  it.each([
    ['the public home', '/', false],
    ['the login', '/entrar', false],
    ['a public page', '/termos', false],
    ['the context picker', '/contextos', true],
    ['the portal', `/portal/${CLIENT}/inicio`, true],
    ['an unknown address', '/nao-existe', false]
  ])('stays light on %s', async (_name, path, isAuthenticated) => {
    renderAt(path, isAuthenticated);
    await screen.findByRole('main').catch(() => undefined);
    expect(theme()).toBeNull();
  });

  it('takes the theme off when the person leaves the agency area', async () => {
    renderAt(`/agencia/${AGENCY}`);
    await waitFor(() => expect(theme()).toBe('dark'));
    screen.getByRole('link', { name: 'sair da agência' }).click();
    await waitFor(() => expect(theme()).toBeNull());
  });

  it('gives back the theme that was there before the agency area', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    renderAt(`/agencia/${AGENCY}`);
    await waitFor(() => expect(theme()).toBe('dark'));
    cleanup();
    expect(theme()).toBe('light');
  });
});
