// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { portalClientBody } from './portal-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { useCommittedLocation } from './location-probe-fixture.js';

afterEach(cleanup);

// Decision 2026-10-27, "a conta de convite só entra depois de confirmar": the account of a copied invitation link holds a
// session that opens nothing, so the screen says "confirme seu e-mail para entrar" instead of the agency. The fake answers
// like the API does for that account: the session says `emailVerified: false`, the contexts are empty, and every route
// that opens something answers 403 EMAIL_NOT_CONFIRMED.
const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_A = '33333333-3333-4333-8333-333333333333';
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const user = { id: '22222222-2222-4222-8222-222222222222', name: 'Pessoa Convidada', email: 'convidada@example.test' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noContent = (): Response => new Response(null, { status: 204 });
const error = (status: number, code: string): Response => json({ error: { code, message: code } }, status);
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Scenario {
  readonly loggedIn?: boolean;
  readonly confirmed?: boolean;
}

/** `confirmed` flips when the one-click confirmation is accepted, as the API does for the session of the link's own account. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  const bodies: Record<string, unknown[]> = {};
  let loggedIn = scenario.loggedIn ?? false;
  let confirmed = scenario.confirmed ?? false;
  const impl: typeof fetch = async (input, init) => {
    await macrotask();
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    calls.push(`${method} ${path}`);
    if (init?.body !== undefined) (bodies[`${method} ${path}`] ??= []).push(JSON.parse(String(init.body)));

    if (path.endsWith('/accept-new-account')) { loggedIn = true; return json({ status: 'accepted', context: { agencyId: AGENCY_A, clientId: null } }, 201); }
    if (path.startsWith('/invitations/')) {
      return json({ purpose: 'collaborator_invite', email: user.email, agency: { name: 'Agência Um' }, client: null, accountExists: false });
    }
    if (path === '/auth/session') {
      return loggedIn ? json({ user, emailVerified: confirmed, session: { expiresAt: '2026-01-01T00:00:00.000Z' } }) : error(401, 'UNAUTHENTICATED');
    }
    if (path === '/auth/logout') { loggedIn = false; return noContent(); }
    if (path === '/auth/email/verify') {
      if (!loggedIn) return error(400, 'INVALID_LINK_OR_PASSWORD');
      confirmed = true;
      return json({ user });
    }
    if (path === '/auth/email/verification/resend') return json({}, 202);
    if (!loggedIn) return error(401, 'UNAUTHENTICATED');
    if (path === '/me/contexts/resolve') return json(confirmed ? { decision: 'enter', context: agencyA } : { decision: 'none' });
    if (!confirmed) return error(403, 'EMAIL_NOT_CONFIRMED');
    if (path === `/agencies/${AGENCY_A}/me`) {
      return json({ agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: true, membershipId: null, role: { key: 'admin', name: 'Admin' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions: ['colaborador.visualizar', 'cliente.visualizar'] });
    }
    if (path === `/clients/${CLIENT_A}`) return json(portalClientBody(CLIENT_A, 'Cliente Um'));
    if (path === '/me/last-context' && method === 'PUT') return noContent();
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls, bodies };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}
interface Probe {
  pathname: string;
  navigate: (to: string) => void;
}
function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.navigate = (to: string) => navigate(to);
  });
  return null;
}

const renderAt = (impl: typeof fetch, path: string) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  const probe: Probe = { pathname: '', navigate: () => undefined };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
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

const PENDING_TITLE = 'Confirme seu e-mail para entrar';

describe('accepting a copied invitation link', () => {
  it('lands on the screen that asks to confirm the e-mail, and records no context nor opens the agency', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = renderAt(impl, '/convite/copied-token');
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pessoa Convidada' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'a correct new password' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));

    await screen.findByRole('heading', { name: PENDING_TITLE });
    expect(probe.pathname).toBe('/confirme-seu-email');
    expect(screen.getByText(/convidada@example\.test/)).toBeTruthy();
    expect(calls).not.toContain('PUT /me/last-context');
    expect(calls.filter((call) => call.includes('/agencies/'))).toEqual([]);
  });

  it('enters the agency directly when the session is of a confirmed account (the token of the e-mail)', async () => {
    const { impl, calls } = makeFetch({ confirmed: true });
    const { probe } = renderAt(impl, '/convite/email-token');
    await screen.findByRole('heading', { name: 'Você foi convidado' });
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pessoa Convidada' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'a correct new password' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta e entrar' }));

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(calls).toContain('PUT /me/last-context');
    expect(screen.queryByRole('heading', { name: PENDING_TITLE })).toBeNull();
  });
});

describe('every area sends the unconfirmed session to the confirmation screen', () => {
  it.each([
    ['the agency', `/agencia/${AGENCY_A}`],
    ['the agency collaborators', `/agencia/${AGENCY_A}/colaboradores`],
    ['the portal', `/portal/${CLIENT_A}/inicio`],
    ['the context chooser', '/contextos'],
    ['the start page', '/comecar']
  ])('%s', async (_name, path) => {
    const { impl, calls } = makeFetch({ loggedIn: true });
    const { probe } = renderAt(impl, path);

    await screen.findByRole('heading', { name: PENDING_TITLE });
    expect(probe.pathname).toBe('/confirme-seu-email');
    expect(calls.filter((call) => call.includes('/agencies/') || call.includes('/clients/') || call.includes('/contexts/'))).toEqual([]);
  });
});

describe('the confirmation screen', () => {
  it('asks a new link for the account\'s own address, without asking the address again', async () => {
    const { impl, bodies } = makeFetch({ loggedIn: true });
    renderAt(impl, '/confirme-seu-email');
    await screen.findByRole('heading', { name: PENDING_TITLE });
    expect(screen.queryByLabelText('E-mail da conta')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reenviar o link' }));

    await screen.findByText(/enviamos um novo link/);
    expect(bodies['POST /auth/email/verification/resend']).toEqual([{ email: user.email }]);
  });

  it('signs out on the server and goes to the login', async () => {
    const { impl, calls } = makeFetch({ loggedIn: true });
    const { probe } = renderAt(impl, '/confirme-seu-email');
    await screen.findByRole('heading', { name: PENDING_TITLE });

    fireEvent.click(screen.getByRole('button', { name: 'Sair' }));

    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(calls).toContain('POST /auth/logout');
  });

  it('sends a visitor with no session to the login', async () => {
    const { impl } = makeFetch();
    const { probe } = renderAt(impl, '/confirme-seu-email');
    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
    expect(screen.queryByRole('heading', { name: PENDING_TITLE })).toBeNull();
  });

  it('sends a confirmed account on to its contexts instead of asking it to confirm again', async () => {
    const { impl } = makeFetch({ loggedIn: true, confirmed: true });
    const { probe } = renderAt(impl, '/confirme-seu-email');
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(screen.queryByRole('heading', { name: PENDING_TITLE })).toBeNull();
  });
});

describe('the click in the e-mail, with the session the acceptance left', () => {
  it('confirms with no password and enters the agency of the invitation', async () => {
    const { impl, calls, bodies } = makeFetch({ loggedIn: true });
    const { probe } = renderAt(impl, '/confirme-seu-email');
    await screen.findByRole('heading', { name: PENDING_TITLE });

    probe.navigate('/email/verificar?token=the-link-of-the-email');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar sem digitar a senha' }));

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(bodies['POST /auth/email/verify']).toEqual([{ token: 'the-link-of-the-email' }]);
    await waitFor(() => expect(calls).toContain(`GET /agencies/${AGENCY_A}/me`));
  });
});
