// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

afterEach(cleanup);

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

interface Scenario {
  readonly reset: Response;
  readonly resolve?: unknown;
}

const makeFetch = (scenario: Scenario) => {
  const calls = { reset: 0, resolve: 0 };
  let serverLoggedIn = false;
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/session')) return serverLoggedIn ? json(sessionBody) : unauthenticated();
    if (url.endsWith('/auth/password/reset')) {
      calls.reset += 1;
      const clone = scenario.reset.clone();
      const body = await clone.json().catch(() => undefined) as { signedIn?: boolean } | undefined;
      if (body?.signedIn === true) serverLoggedIn = true;
      return scenario.reset;
    }
    if (url.endsWith('/me/contexts/resolve')) {
      calls.resolve += 1;
      if (!serverLoggedIn) return unauthenticated();
      return json(scenario.resolve ?? { decision: 'enter', context: agencyA });
    }
    throw new Error(`unexpected ${url}`);
  };
  return { impl, calls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}
function LocationProbe({ probe }: { probe: { pathname: string } }) {
  probe.pathname = useLocation().pathname;
  return null;
}

const renderReset = (impl: typeof fetch, search = '?token=reset-token') => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  const probe = { pathname: '' };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[`/senha/redefinir${search}`]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <LocationProbe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, store };
};

const submit = (password: string): void => {
  fireEvent.change(screen.getByLabelText('Nova senha'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
};

describe('ResetPasswordPage (/senha/redefinir)', () => {
  it('shows the rule and rejects a short password before calling the API', () => {
    const { impl, calls } = makeFetch({ reset: json({ signedIn: true }) });
    renderReset(impl);
    expect(document.title).toBe('Definir nova senha — Ageniza');
    expect(screen.getByText('Mínimo de 10 caracteres')).toBeTruthy();
    submit('short');
    expect(screen.getByText('A senha tem no mínimo 10 caracteres.')).toBeTruthy();
    expect(calls.reset).toBe(0);
  });

  it('authenticates and goes to the context when there is no invitation', async () => {
    const { impl, calls } = makeFetch({ reset: json({ signedIn: true }), resolve: { decision: 'enter', context: agencyA } });
    const { probe } = renderReset(impl);
    submit('a new correct password');
    await waitFor(() => expect(probe.pathname).toBe('/app'));
    expect(calls.resolve).toBe(1);
  });

  it('goes to /contextos for more than one context', async () => {
    const { impl } = makeFetch({ reset: json({ signedIn: true }), resolve: { decision: 'select', contexts: [agencyA], highlighted: null } });
    const { probe } = renderReset(impl);
    submit('a new correct password');
    await waitFor(() => expect(probe.pathname).toBe('/contextos'));
  });

  it('continues the invitation, without resolving, when the URL carries invite', async () => {
    const { impl, calls } = makeFetch({ reset: json({ signedIn: true }) });
    const { probe } = renderReset(impl, '?token=reset-token&invite=invite-value');
    submit('a new correct password');
    await waitFor(() => expect(probe.pathname).toBe('/convite/invite-value'));
    expect(calls.resolve).toBe(0);
  });

  it('goes to /sem-acesso and ends the session for NO_CONTEXT_ACCESS', async () => {
    const { impl } = makeFetch({ reset: json({ signedIn: false, reason: 'NO_CONTEXT_ACCESS' }) });
    const { probe, store } = renderReset(impl);
    const end = vi.spyOn(store, 'end');
    submit('a new correct password');
    await waitFor(() => expect(probe.pathname).toBe('/sem-acesso'));
    expect(end).toHaveBeenCalled();
  });

  it('goes to /entrar with a notice for SIGN_IN_REQUIRED', async () => {
    const { impl } = makeFetch({ reset: json({ signedIn: false, reason: 'SIGN_IN_REQUIRED' }) });
    const { probe } = renderReset(impl);
    submit('a new correct password');
    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(screen.getByRole('status').textContent).toContain('Senha redefinida. Entre com a nova senha.');
  });

  it('shows the invalid-link state, without distinguishing used from expired', async () => {
    const { impl } = makeFetch({ reset: json({ error: { code: 'INVALID_LINK', message: 'Este link não é mais válido.' } }, 400) });
    renderReset(impl);
    submit('a new correct password');
    await screen.findByRole('heading', { name: 'Este link não é mais válido' });
    expect(screen.getByRole('link', { name: 'Pedir um novo link' }).getAttribute('href')).toBe('/senha/esquecida');
  });
});
