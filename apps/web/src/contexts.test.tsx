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

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const AGENCY_B = '22222222-2222-4222-8222-222222222222';
const CLIENT_C = '33333333-3333-4333-8333-333333333333';

const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const agencyB = { type: 'agency', agencyId: AGENCY_B, agencyName: 'Agência Dois', roleKey: 'production', roleName: 'Produção', isOwner: false };
const clientC = { type: 'client', clientId: CLIENT_C, clientName: 'Cliente Um', agencyId: AGENCY_A, agencyName: 'Agência Um', onboardingPending: false };

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const renderContexts = (fetchImpl: typeof fetch) => {
  const client = new HttpClient('http://127.0.0.1:3001', fetchImpl);
  return render(
    <AuthSessionProvider store={createAuthSessionStore(client)}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={['/contextos']}>
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
      'Agência DoisÁrea da agência · Produção',
      'Cliente UmPortal do cliente · Agência Um'
    ]);
  });

  it('emphasises the highlighted context without entering it', async () => {
    renderContexts(async () => json(selectResponse));
    await screen.findByText('Área da agência · Admin');

    const highlighted = screen.getAllByRole('button').filter((element) => element.classList.contains('ui-choice-card--highlighted'));
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]?.textContent).toContain('Agência Dois');
    // Highlight is visual only: the workspace must not be entered by itself.
    expect(screen.queryByRole('heading', { name: 'Workspace' })).toBeNull();
  });

  it('writes the chosen context to last-context and enters the workspace', async () => {
    const putBodies: unknown[] = [];
    renderContexts(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/me/contexts/resolve')) return json(selectResponse);
      if (url.endsWith('/me/last-context') && init?.method === 'PUT') {
        putBodies.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    });

    await screen.findByText('Área da agência · Admin');
    fireEvent.click(screen.getByRole('button', { name: /Cliente Um/ }));

    await waitFor(() => expect(putBodies).toEqual([{ type: 'client', clientId: CLIENT_C }]));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Workspace' })).toBeTruthy());
  });

  it('shows skeletons on the first load', () => {
    renderContexts(() => new Promise<Response>(() => undefined));
    expect(document.querySelectorAll('.ui-skeleton')).toHaveLength(2);
  });

  it('offers a retry when the resolve request fails', async () => {
    let attempts = 0;
    renderContexts(async () => {
      attempts += 1;
      if (attempts <= 2) return new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } });
      return json(selectResponse);
    });

    const retry = await screen.findByRole('button', { name: 'Tentar de novo' }, { timeout: 5000 });
    expect(screen.getByRole('alert').textContent).toContain('Não foi possível carregar seus contextos.');
    fireEvent.click(retry);
    await screen.findByText('Área da agência · Admin');
  });
});
