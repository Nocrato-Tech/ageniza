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
const invalidLink = (): Response => json({ error: { code: 'INVALID_LINK', message: 'Este link não é mais válido.' } }, 410);

const preview = (accountExists: boolean, client: { name: string } | null = null) => ({
  purpose: 'collaborator_invite',
  email: 'pessoa@example.test',
  agency: { name: 'Agência Um' },
  client,
  accountExists
});

interface Scenario {
  readonly authenticated?: boolean;
  readonly preview: Response;
  readonly accept?: Response;
  readonly resolve?: unknown;
}

const makeFetch = (scenario: Scenario) => {
  const calls = { accept: 0, create: 0, resolve: 0 };
  let serverLoggedIn = scenario.authenticated ?? false;
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/accept-new-account')) { calls.create += 1; serverLoggedIn = true; return json({ status: 'accepted', context: { agencyId: AGENCY_A, clientId: null } }, 201); }
    if (url.endsWith('/accept') && method === 'POST') { calls.accept += 1; return scenario.accept ?? json({ status: 'accepted', context: { agencyId: AGENCY_A, clientId: null } }); }
    if (url.includes('/invitations/')) return scenario.preview.clone();
    if (url.endsWith('/auth/session')) return serverLoggedIn ? json(sessionBody) : unauthenticated();
    if (url.endsWith('/me/contexts/resolve')) { calls.resolve += 1; if (!serverLoggedIn) return unauthenticated(); return json(scenario.resolve ?? { decision: 'enter', context: agencyA }); }
    if (url.endsWith('/auth/logout')) { serverLoggedIn = false; return noContent(); }
    throw new Error(`unexpected ${method} ${url}`);
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

const renderInvite = (impl: typeof fetch) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  const probe = { pathname: '' };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={['/convite/invite-token']}>
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

describe('InvitationPage (/convite/:token)', () => {
  it('shows one invalid message and nothing of the invitation for an invalid token', async () => {
    const { impl } = makeFetch({ preview: invalidLink() });
    renderInvite(impl);

    await screen.findByRole('heading', { name: 'Este convite não é mais válido' });
    expect(screen.queryByText('pessoa@example.test')).toBeNull();
    expect(screen.queryByText('Agência Um')).toBeNull();
  });

  it('shows the invitation as text and the new-account form, with the checkbox required', async () => {
    const { impl } = makeFetch({ preview: json(preview(false, { name: 'Cliente Um' })) });
    renderInvite(impl);

    await screen.findByRole('heading', { name: 'Você foi convidado' });
    expect(screen.getByText('Agência Um')).toBeTruthy();
    expect(screen.getByText('Cliente Um')).toBeTruthy();
    expect(screen.getByText('pessoa@example.test')).toBeTruthy();
    // The e-mail is information, never an editable field.
    expect(screen.queryByLabelText('E-mail')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'E-mail' })).toBeNull();

    const create = screen.getByRole('button', { name: 'Criar conta e entrar' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(create.disabled).toBe(false);
    // The two documents open inside the checkbox text, in a new tab so the form survives.
    expect(screen.getByRole('link', { name: 'Termos de Uso' }).getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'Política de Privacidade' }).getAttribute('target')).toBe('_blank');
  });

  it('rejects a short password before creating the account', async () => {
    const { impl, calls } = makeFetch({ preview: json(preview(false)) });
    renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pessoa' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));

    expect(screen.getByText('A senha tem no mínimo 10 caracteres.')).toBeTruthy();
    expect(calls.create).toBe(0);
  });

  it('creates the account, then resolves and enters the context', async () => {
    const { impl, calls } = makeFetch({ preview: json(preview(false)) });
    const { probe } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pessoa' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'a correct new password' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));

    await waitFor(() => expect(probe.pathname).toBe('/app'));
    expect(calls.create).toBe(1);
    expect(calls.resolve).toBe(1);
  });

  it('accepts for an authenticated existing account, then resolves', async () => {
    const { impl, calls } = makeFetch({ authenticated: true, preview: json(preview(true)) });
    const { probe } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });

    fireEvent.click(screen.getByRole('button', { name: 'Aceitar convite' }));
    await waitFor(() => expect(probe.pathname).toBe('/app'));
    expect(calls.accept).toBe(1);
  });

  it('sends an unauthenticated existing account to the login with the invite token', async () => {
    const { impl, calls } = makeFetch({ preview: json(preview(true)) });
    const { probe } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });

    fireEvent.click(screen.getByRole('button', { name: 'Aceitar convite' }));
    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(calls.accept).toBe(0);
    // The login screen rendered with the invitation continuation.
    expect(screen.getByRole('heading', { name: 'Ageniza' })).toBeTruthy();
  });

  it('does not treat already_member as an error', async () => {
    const { impl } = makeFetch({
      authenticated: true,
      preview: json(preview(true)),
      accept: json({ status: 'already_member', context: { agencyId: AGENCY_A, clientId: null } })
    });
    const { probe } = renderInvite(impl);
    await screen.findByRole('heading', { name: 'Você foi convidado' });

    fireEvent.click(screen.getByRole('button', { name: 'Aceitar convite' }));
    await waitFor(() => expect(probe.pathname).toBe('/app'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
