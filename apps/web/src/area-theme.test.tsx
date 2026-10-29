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
    ['the root, which opens the login', '/', false],
    ['the login', '/entrar', false],
    ['a public page', '/termos', false],
    ['the context picker', '/contextos', true],
    ['the portal', `/portal/${CLIENT}/inicio`, true],
    ['the invitation', '/convite/token-de-teste', false],
    ['the password reset', '/senha/redefinir?token=token-de-teste', false],
    ['the service status', '/status', false],
    ['an unknown address', '/nao-existe', false]
  ])('stays light on %s', async (_name, path, isAuthenticated) => {
    renderAt(path, isAuthenticated);
    await screen.findByRole('main').catch(() => undefined);
    expect(theme()).toBeNull();
  });

  it.each([
    ['loading the session', true, 'loading'],
    ['no session', false, 'ready'],
    ['no session while loading', false, 'loading']
  ] as const)('is dark on the agency while %s, before any agency is known', async (_name, isAuthenticated, status) => {
    renderAt(`/agencia/${AGENCY}/clientes`, isAuthenticated, status);
    await waitFor(() => expect(theme()).toBe('dark'));
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

describe('theme before the first paint', () => {
  const indexHtml = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  const inline = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1];

  const runEarlyScript = (path: string): void => {
    if (inline === undefined) throw new Error('index.html has no inline theme script.');
    window.history.pushState({}, '', path);
    new Function(inline)();
  };

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme-early');
    window.history.pushState({}, '', '/');
  });

  it('runs before the stylesheets and the app bundle load', () => {
    const script = indexHtml.indexOf('<script>');
    expect(script).toBeGreaterThan(-1);
    expect(script).toBeLessThan(indexHtml.indexOf('type="module"'));
  });

  it.each([`/agencia/${AGENCY}`, `/agencia/${AGENCY}/clientes/${CLIENT}/geral`, '/agencia/nao-e-um-id'])('sets the dark theme on %s', (path) => {
    runEarlyScript(path);
    expect(theme()).toBe('dark');
  });

  it.each(['/', '/entrar', '/agencia', '/agencia/', '/agenciax/y', `/portal/${CLIENT}/inicio`, '/contextos', '/convite/abc', '/senha/redefinir'])('leaves %s light', (path) => {
    runEarlyScript(path);
    expect(theme()).toBeNull();
  });

  it('is not given back as a previous theme when the person leaves the agency', async () => {
    runEarlyScript(`/agencia/${AGENCY}`);
    renderAt(`/agencia/${AGENCY}`);
    await waitFor(() => expect(document.documentElement.hasAttribute('data-theme-early')).toBe(false));
    expect(theme()).toBe('dark');
    screen.getByRole('link', { name: 'sair da agência' }).click();
    await waitFor(() => expect(theme()).toBeNull());
  });
});
