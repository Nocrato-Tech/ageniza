// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
const agencyMe = { agencyId: AGENCY, agencyName: 'Agência Um', isOwner: true, membershipId: null, role: { key: 'admin', name: 'Admin' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions: [] };

const fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  if (url.endsWith('/auth/session')) return json({ user, session: { expiresAt: '2026-01-01T00:00:00.000Z' } });
  if (url.endsWith(`/agencies/${AGENCY}/me`)) return json(agencyMe);
  return new Response(null, { status: 401 });
};

const theme = () => document.documentElement.getAttribute('data-theme');

const renderAt = (path: string, isAuthenticated = true, status: 'loading' | 'ready' = 'ready') => {
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  return render(
    <AuthSessionProvider store={createAuthSessionStore(client)}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}><MemoryRouter initialEntries={[path]}>
          <ApplicationRoutes session={{ status, isAuthenticated, user: isAuthenticated ? user : null }} />
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

describe('one light theme for every area (docs/design-system.md section 7)', () => {
  it.each([
    ['the agency home', `/agencia/${AGENCY}`, true],
    ['a screen of the agency', `/agencia/${AGENCY}/clientes`, true],
    ['a deep address of the agency', `/agencia/${AGENCY}/clientes/${CLIENT}/geral`, true],
    ['an unknown address inside the agency', `/agencia/${AGENCY}/nao-existe`, true],
    ['an agency address that is not valid', '/agencia/nao-e-um-id', true],
    ['the root, which opens the login', '/', false],
    ['the login', '/entrar', false],
    ['a public page', '/termos', false],
    ['the context picker', '/contextos', true],
    ['the portal', `/portal/${CLIENT}/inicio`, true],
    ['the invitation', '/convite/token-de-teste', false],
    ['the password reset', '/senha/redefinir?token=token-de-teste', false],
    ['the service status', '/status', false],
    ['an unknown address', '/nao-existe', false]
  ])('puts no theme attribute on %s', async (_name, path, isAuthenticated) => {
    renderAt(path, isAuthenticated);
    await screen.findByRole('main').catch(() => undefined);
    expect(theme()).toBeNull();
  });

  it.each([
    ['loading the session', true, 'loading'],
    ['no session', false, 'ready'],
    ['no session while loading', false, 'loading']
  ] as const)('puts no theme attribute on the agency while %s, before any agency is known', async (_name, isAuthenticated, status) => {
    renderAt(`/agencia/${AGENCY}/clientes`, isAuthenticated, status);
    await screen.findByRole('main').catch(() => undefined);
    expect(theme()).toBeNull();
  });

  it('keeps the page light when the person enters and leaves the agency area', async () => {
    renderAt(`/agencia/${AGENCY}`);
    await waitFor(() => expect(document.querySelector('main')).not.toBeNull());
    expect(theme()).toBeNull();
    screen.getByRole('link', { name: 'sair da agência' }).click();
    await waitFor(() => expect(screen.getByRole('link', { name: 'sair da agência' })).toBeTruthy());
    expect(theme()).toBeNull();
  });
});

describe('the page that ships', () => {
  const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

  it('has no script that sets a theme before the first paint', () => {
    expect(indexHtml).not.toContain('<script>');
    expect(indexHtml).not.toContain('data-theme');
  });

  it('leaves the theme out of the stylesheets, so there is nothing to switch to', () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');
    expect(styles).not.toContain('data-theme');
    expect(styles).not.toContain('themes/dark.css');
  });
});
