// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const AGENCY_B = '22222222-2222-4222-8222-222222222222';
const CLIENT_C = '33333333-3333-4333-8333-333333333333';

const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const agencyB = { type: 'agency', agencyId: AGENCY_B, agencyName: 'Agência Dois', roleKey: 'production', roleName: 'Produção', isOwner: false };
const clientC = { type: 'client', clientId: CLIENT_C, clientName: 'Cliente Um', agencyId: AGENCY_A, agencyName: 'Agência Um', onboardingPending: false };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });

const renderContexts = (
  fetchImpl: typeof fetch,
  options: { preferred?: string; store?: AuthSessionStore } = {}
) => {
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  const store = options.store ?? createAuthSessionStore(client);
  const path = options.preferred === undefined ? '/contextos' : `/contextos?preferred=${encodeURIComponent(options.preferred)}`;
  return render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <ApplicationRoutes session={{ status: 'ready', isAuthenticated: true }} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};

const selectResponse = { decision: 'select', contexts: [agencyA, agencyB, clientC], highlighted: agencyB };

const cardTexts = (): string[] => screen.getAllByRole('button')
  .filter((element) => element.classList.contains('ui-choice-card'))
  .map((element) => element.textContent ?? '');

describe('ContextSelectPage (/contextos)', () => {
  it('renders the resolve list in its own order, with kind, role and owning agency', async () => {
    renderContexts(async () => json(selectResponse));

    await screen.findByText('Área da agência · Admin');
    expect(screen.getByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy();
    expect(cardTexts()).toEqual([
      'Agência UmÁrea da agência · Admin',
      'SugeridoAgência DoisÁrea da agência · Produção',
      'Cliente UmPortal do cliente · Agência Um'
    ]);
  });

  it('communicates the highlighted context with visible text and an attribute, not colour alone', async () => {
    renderContexts(async () => json(selectResponse));
    await screen.findByText('Área da agência · Admin');

    const highlighted = screen.getAllByRole('button').filter((element) => element.classList.contains('ui-choice-card--highlighted'));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]?.textContent).toContain('Sugerido');
    expect(highlighted[0]?.getAttribute('aria-current')).toBe('true');
    // Highlight is visual only: the workspace must not be entered by itself.
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('forwards the preferred context to resolve, which is what fills highlighted', async () => {
    const urls: string[] = [];
    renderContexts(async (input) => {
      urls.push(String(input));
      return json(selectResponse);
    }, { preferred: `agency:${AGENCY_B}` });

    await screen.findByText('Área da agência · Produção');
    expect(urls.some((url) => url.includes(`preferred=agency%3A${AGENCY_B}`))).toBe(true);
    expect(screen.getByRole('button', { name: /Agência Dois/ }).getAttribute('aria-current')).toBe('true');
  });

  it('never calls /me/contexts, only resolve', async () => {
    const urls: string[] = [];
    renderContexts(async (input) => { urls.push(String(input)); return json(selectResponse); });

    await screen.findByText('Área da agência · Admin');
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.endsWith('/me/contexts/resolve'))).toBe(true);
  });

  it('writes the chosen context to last-context and enters the workspace', async () => {
    const putBodies: unknown[] = [];
    renderContexts(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/me/contexts/resolve')) return json(selectResponse);
      if (url.endsWith('/me/last-context') && init?.method === 'PUT') {
        putBodies.push(JSON.parse(String(init.body)));
        return noContent();
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    });

    await screen.findByText('Área da agência · Admin');
    fireEvent.click(screen.getByRole('button', { name: /Cliente Um/ }));

    await waitFor(() => expect(putBodies).toEqual([{ type: 'client', clientId: CLIENT_C }]));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy());
  });

  it('shows a repeatable error when choosing fails, and reloads the list on 404', async () => {
    let resolveCalls = 0;
    let putCalls = 0;
    renderContexts(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/me/contexts/resolve')) { resolveCalls += 1; return json(selectResponse); }
      if (url.endsWith('/me/last-context') && init?.method === 'PUT') {
        putCalls += 1;
        return putCalls === 1
          ? json({ error: { code: 'NOT_FOUND', message: 'Context not found.' } }, 404)
          : noContent();
      }
      throw new Error(`unexpected ${url}`);
    });

    await screen.findByText('Área da agência · Admin');
    fireEvent.click(screen.getByRole('button', { name: /Agência Dois/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível entrar nesse contexto');
    await waitFor(() => expect(resolveCalls).toBeGreaterThan(1));

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy());
  });

  it('shows a repeatable error when signing out fails', async () => {
    let logoutCalls = 0;
    renderContexts(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/me/contexts/resolve')) return json(selectResponse);
      if (url.endsWith('/auth/logout') && init?.method === 'POST') {
        logoutCalls += 1;
        return logoutCalls === 1
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500)
          : noContent();
      }
      throw new Error(`unexpected ${url}`);
    });

    await screen.findByText('Área da agência · Admin');
    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível sair');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy());
  });

  it('enters directly when resolve answers with a single context', async () => {
    renderContexts(async () => json({ decision: 'enter', context: agencyA }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy());
    expect(screen.queryByRole('heading', { name: 'Onde você quer entrar?' })).toBeNull();
  });

  it('ends the session and leaves when resolve answers none', async () => {
    const client = new HttpClient('http://127.0.0.1:3001', async () => json({ decision: 'none' }));
    const store = createAuthSessionStore(client);
    const end = vi.spyOn(store, 'end');

    renderContexts(async () => json({ decision: 'none' }), { store });
    await waitFor(() => expect(end).toHaveBeenCalledTimes(1));
  });

  it('shows skeletons on the first load', () => {
    renderContexts(() => new Promise<Response>(() => undefined));
    expect(document.querySelectorAll('.ui-skeleton')).toHaveLength(2);
  });

  it('offers a retry when the resolve request fails', async () => {
    let attempts = 0;
    renderContexts(async () => {
      attempts += 1;
      if (attempts <= 2) return json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500);
      return json(selectResponse);
    });

    const retry = await screen.findByRole('button', { name: 'Tentar de novo' }, { timeout: 5000 });
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar seus contextos.');
    fireEvent.click(retry);
    await screen.findByText('Área da agência · Admin');
  });
});
