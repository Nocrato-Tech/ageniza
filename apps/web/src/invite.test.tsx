// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

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
const noContent = (): Response => new Response(null, { status: 204 });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

const previewBody = (accountExists: boolean, client: { name: string } | null = null) => ({
  purpose: 'collaborator_invite', email: 'pessoa@example.test', agency: { name: 'Agência Um' }, client, accountExists
});

interface Scenario {
  readonly authenticated?: boolean;
  readonly preview?: () => Response;
  readonly accept?: () => Response;
  readonly acceptError?: Response;
  readonly createError?: Response;
  readonly resolve?: unknown;
  readonly resolveError?: boolean;
}

/** Behaves like the API: `accept` and `resolve` require a session and answer 401 without one. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const loginBodies: Array<Record<string, unknown>> = [];
  const lastContextBodies: unknown[] = [];
  let serverLoggedIn = scenario.authenticated ?? false;
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/accept-new-account')) {
      calls.push('create');
      if (scenario.createError !== undefined) return scenario.createError;
      serverLoggedIn = true;
      return json({ status: 'accepted', context: { agencyId: AGENCY_A, clientId: null } }, 201);
    }
    if (url.endsWith('/accept') && method === 'POST') {
      calls.push('accept');
      if (!serverLoggedIn) return unauthenticated();
      if (scenario.acceptError !== undefined) return scenario.acceptError;
      return scenario.accept?.() ?? json({ status: 'accepted', context: { agencyId: AGENCY_A, clientId: null } });
    }
    if (url.includes('/invitations/')) { calls.push('preview'); return scenario.preview?.() ?? json(previewBody(false)); }
    if (url.endsWith('/auth/session')) return serverLoggedIn ? json(sessionBody) : unauthenticated();
    if (url.endsWith('/auth/login')) { calls.push('login'); loginBodies.push(JSON.parse(String(init?.body))); serverLoggedIn = true; return json({ user: sessionBody.user }); }
    if (url.endsWith('/me/contexts/resolve')) {
      calls.push('resolve');
      if (!serverLoggedIn) return unauthenticated();
      if (scenario.resolveError === true) return json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500);
      return json(scenario.resolve ?? { decision: 'enter', context: agencyA });
    }
    if (url.endsWith('/me/last-context') && method === 'PUT') {
      calls.push('last-context');
      lastContextBodies.push(JSON.parse(String(init?.body)));
      return noContent();
    }
    if (url.endsWith(`/agencies/${AGENCY_A}/me`)) {
      return json({ agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: true, role: { key: 'admin', name: 'Admin' }, permissions: ['colaborador.visualizar', 'cliente.visualizar'] });
    }
    if (url.endsWith('/auth/logout')) { calls.push('logout'); serverLoggedIn = false; return noContent(); }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls, loginBodies, lastContextBodies };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}
function LocationProbe({ probe }: { probe: { pathname: string } }) {
  probe.pathname = useLocation().pathname;
  return null;
}
function SessionProbe({ store, probe }: { store: AuthSessionStore; probe: { sessionStatus: string } }) {
  probe.sessionStatus = useAuthSession(store).status;
  return null;
}

const renderInvite = (impl: typeof fetch) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  const probe = { pathname: '', sessionStatus: '' };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={['/convite/invite-token']}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <LocationProbe probe={probe} />
            <SessionProbe store={store} probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, store, queryClient };
};

const fillNewAccount = (): void => {
  fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pessoa' } });
  fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'a correct new password' } });
  fireEvent.click(screen.getByRole('checkbox'));
};

describe('InvitationPage (/convite/:token)', () => {
  it('shows one invalid message and nothing of the invitation for an invalid token', async () => {
    const { impl } = makeFetch({ preview: () => json({ error: { code: 'INVALID_LINK', message: 'x' } }, 410) });
    renderInvite(impl);
    await screen.findByRole('heading', { name: 'Este convite não é mais válido' });
    expect(screen.queryByText('pessoa@example.test')).toBeNull();
  });

  it('shows the invitation as text and the new-account form, with the checkbox required', async () => {
    const { impl } = makeFetch({ preview: () => json(previewBody(false, { name: 'Cliente Um' })) });
    renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });

    expect(screen.getByText('Agência Um')).toBeTruthy();
    expect(screen.getByText('Cliente Um')).toBeTruthy();
    expect(screen.getByText('pessoa@example.test')).toBeTruthy();
    expect(screen.queryByLabelText('E-mail')).toBeNull();

    const create = screen.getByRole('button', { name: 'Criar conta e entrar' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(create.disabled).toBe(false);
    expect(screen.getByRole('link', { name: 'Termos de Uso' }).getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'Política de Privacidade' }).getAttribute('target')).toBe('_blank');
  });

  it('rejects a short password before creating the account', async () => {
    const { impl, calls } = makeFetch({ preview: () => json(previewBody(false)) });
    renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pessoa' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));
    expect(screen.getByText('A senha tem no mínimo 10 caracteres.')).toBeTruthy();
    expect(calls).not.toContain('create');
  });

  it('creates the account, then accepts before resolving, and records the context it enters', async () => {
    const { impl, calls, lastContextBodies } = makeFetch({ preview: () => json(previewBody(false)) });
    const { probe } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fillNewAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(calls.indexOf('create')).toBeLessThan(calls.indexOf('resolve'));
    expect(lastContextBodies).toEqual([{ type: 'agency', agencyId: AGENCY_A }]);
  });

  it('offers a resolve-only retry when the resolve fails after creating the account', async () => {
    const { impl, calls } = makeFetch({ preview: () => json(previewBody(false)), resolveError: true });
    renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fillNewAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('O convite foi aceito');
    // Never shows the invalid-invitation state to someone already logged in.
    expect(screen.queryByRole('heading', { name: 'Este convite não é mais válido' })).toBeNull();
    expect(calls.filter((call) => call === 'resolve')).toHaveLength(1);
  });

  it('accepts for an authenticated existing account, then resolves, and records the context it enters', async () => {
    const { impl, calls, lastContextBodies } = makeFetch({ authenticated: true, preview: () => json(previewBody(true)) });
    const { probe } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar convite' }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(calls.indexOf('accept')).toBeLessThan(calls.indexOf('resolve'));
    expect(lastContextBodies).toEqual([{ type: 'agency', agencyId: AGENCY_A }]);
  });

  it('sends an unauthenticated existing account to the login carrying the invite token', async () => {
    const { impl, calls, loginBodies } = makeFetch({ preview: () => json(previewBody(true)) });
    const { probe } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar convite' }));

    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(calls).not.toContain('accept');
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'pessoa@example.test' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'a correct password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(loginBodies).toEqual([{ email: 'pessoa@example.test', password: 'a correct password', inviteToken: 'invite-token' }]));
  });

  it('explains the account mismatch and offers "Entrar com outra conta", without a retry', async () => {
    const { impl } = makeFetch({
      authenticated: true,
      preview: () => json(previewBody(true)),
      acceptError: json({ error: { code: 'INVITATION_ACCOUNT_MISMATCH', message: 'x' } }, 403)
    });
    renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar convite' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Você está conectado com outra conta');
    expect(screen.getByRole('button', { name: 'Entrar com outra conta' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });

  it('logs out on the server when entering with another account', async () => {
    const { impl, calls } = makeFetch({ authenticated: true, preview: () => json(previewBody(true)) });
    const { probe } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar com outra conta' }));
    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(calls).toContain('logout');
  });

  it('treats already_member as success', async () => {
    const { impl } = makeFetch({
      authenticated: true,
      preview: () => json(previewBody(true)),
      accept: () => json({ status: 'already_member', context: { agencyId: AGENCY_A, clientId: null } })
    });
    const { probe } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar convite' }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('moves to the existing-account state on ACCOUNT_EXISTS', async () => {
    let accountExists = false;
    const { impl } = makeFetch({
      preview: () => json(previewBody(accountExists)),
      createError: json({ error: { code: 'ACCOUNT_EXISTS', message: 'x' } }, 409)
    });
    // After the first preview the account exists, so the refetch shows the accept state.
    renderInvite(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && /\/invitations\/[^/]+$/.test(url)) { const response = json(previewBody(accountExists)); accountExists = true; return response; }
      return impl(input, init);
    });
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fillNewAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));

    await screen.findByRole('button', { name: 'Aceitar convite' });
  });

  it('clears the previous account cache on accept, so no old context reaches /contextos', async () => {
    // The previous session was authenticated, so `onSessionStarted` does not fire on refresh: only
    // the explicit queryClient.clear() of the acceptance keeps account X's cache off /contextos.
    const oldContext = { type: 'agency', agencyId: '22222222-2222-4222-8222-222222222222', agencyName: 'Agência ANTIGA', roleKey: 'admin', roleName: 'Admin', isOwner: true };
    const newContext = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência NOVA', roleKey: 'admin', roleName: 'Admin', isOwner: true };
    const { impl, calls } = makeFetch({
      authenticated: true,
      preview: () => json(previewBody(true)),
      resolve: { decision: 'select', contexts: [newContext], highlighted: null }
    });
    const { probe, queryClient } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    await waitFor(() => expect(probe.sessionStatus).toBe('ready'));
    queryClient.setQueryData(['contexts', 'resolve', null], { decision: 'select', contexts: [oldContext], highlighted: null });

    fireEvent.click(screen.getByRole('button', { name: 'Aceitar convite' }));

    await waitFor(() => expect(probe.pathname).toBe('/contextos'));
    await screen.findByText('Agência NOVA');
    expect(screen.queryByText('Agência ANTIGA')).toBeNull();
    expect(calls.filter((call) => call === 'resolve')).toHaveLength(2);
  });

  it('clears the previous account cache when creating a new account, so no old context reaches /contextos', async () => {
    const oldContext = { type: 'agency', agencyId: '22222222-2222-4222-8222-222222222222', agencyName: 'Agência ANTIGA', roleKey: 'admin', roleName: 'Admin', isOwner: true };
    const newContext = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência NOVA', roleKey: 'admin', roleName: 'Admin', isOwner: true };
    const { impl, calls } = makeFetch({
      authenticated: true,
      preview: () => json(previewBody(false)),
      resolve: { decision: 'select', contexts: [newContext], highlighted: null }
    });
    const { probe, queryClient } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    await waitFor(() => expect(probe.sessionStatus).toBe('ready'));
    queryClient.setQueryData(['contexts', 'resolve', null], { decision: 'select', contexts: [oldContext], highlighted: null });

    fillNewAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));

    await waitFor(() => expect(probe.pathname).toBe('/contextos'));
    await screen.findByText('Agência NOVA');
    expect(screen.queryByText('Agência ANTIGA')).toBeNull();
    expect(calls.filter((call) => call === 'resolve')).toHaveLength(2);
  });

  it('moves to the invalid state when the accept answers 410, using the API error body', async () => {
    // The API answers a revoked or already-used invitation with the contract's error body; the
    // preview refetch that follows shows this screen's invalid state (SPEC section 7). The token is
    // only invalid after the accept, so the preview keeps answering valid until that POST runs.
    const invalid = (): Response => json({ error: { code: 'INVALID_LINK', message: 'Este link não é mais válido.' } }, 410);
    let accepted = false;
    const { impl } = makeFetch({
      authenticated: true,
      preview: () => accepted ? invalid() : json(previewBody(true)),
      acceptError: invalid()
    });
    renderInvite(async (input, init) => {
      if ((init?.method ?? 'GET') === 'POST' && String(input).endsWith('/accept')) accepted = true;
      return impl(input, init);
    });
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar convite' }));

    await screen.findByRole('heading', { name: 'Este convite não é mais válido' });
    expect(screen.getByText('Convites valem por 7 dias e só podem ser usados uma vez.')).toBeTruthy();
    expect(screen.getByText('Peça um novo convite a quem administra a agência.')).toBeTruthy();
    expect(screen.queryByText('pessoa@example.test')).toBeNull();
  });
});
