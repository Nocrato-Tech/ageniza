// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AccountMenu } from './account-menu.js';
import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

const REAUTH_KEY = 'ageniza.google-reauth-return';

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

const dialogDescriptors = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
beforeAll(() => {
  // jsdom has no top layer; these stubs only model opening and closing.
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => {
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
  }
});

const USER_ID = '11111111-1111-4111-8111-111111111111';
const AGENCY_A = '22222222-2222-4222-8222-222222222222';
const AGENCY_B = '33333333-3333-4333-8333-333333333333';
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const agencyB = { type: 'agency', agencyId: AGENCY_B, agencyName: 'Agência Dois', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const agencyMe = { agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: true, membershipId: null, role: { key: 'admin', name: 'Admin' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions: ['colaborador.visualizar', 'cliente.visualizar'] };
const INVITE_TOKEN = 'tok-invite-0123456789abcdef';
const INVITE_KEY = 'ageniza.google-invite-return';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const portalClient = {
  id: CLIENT_ID, name: 'Padaria Central', status: 'active', photoUrl: null, legalName: null, taxId: null, segment: null, website: null,
  instagramHandle: null, contactName: null, contactPhone: null, contactEmail: null, closingDate: null, archivedAt: null,
  agencyName: 'Agência Um', onboardingSeenAt: '2026-10-01T12:00:00.000Z', agencyReadOnly: false,
  home: { threadsAnsweredByAgency: 0, brandStudyFilled: 5, contentsAwaitingApproval: 0 }
};
const sessionBody = { user: { id: USER_ID, name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const legalAccepted = { required: false, documents: [
  { document: 'terms', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false },
  { document: 'privacy', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false }
] };
const selectBoth = { decision: 'select', contexts: [agencyA, agencyB], highlighted: null, canCreateAgency: false };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string): Response => json({ error: { code, message: code } }, status);

interface Call { readonly path: string; readonly method: string; readonly body: unknown }

interface Scenario {
  /** What `GET /auth/providers` answers; Google is on by default. */
  readonly providers?: () => Response;
  readonly loggedIn?: boolean;
  /** Holds `GET /auth/session` until released, to see the landing page while it waits. */
  readonly sessionGate?: Promise<void>;
  /**
   * Every `GET /auth/session` answers only after this many milliseconds, a task of its own: the answers come in the order of the
   * calls and never in the same microtask run, as in a browser (a fake that answers at once hides the order of the reads).
   */
  readonly sessionDelayMs?: number;
  /** Holds `GET /agencies/:id/me` and `GET /clients/:id` until released, to see the loading skeleton of the area. */
  readonly areaGate?: Promise<void>;
  readonly resolve?: unknown;
  /** The invitation `INVITE_TOKEN` names; `gone` is asked at every call, so a test can end it while the person is away. */
  readonly invitation?: { readonly email: string; readonly accountExists?: boolean; readonly gone?: () => boolean };
  /** What `POST /me/email-change` answers, from the body the contract accepted. */
  readonly emailChange?: (body: { newEmail: string; currentPassword?: string }) => Response;
}

/**
 * Answers like the API: the routes of a session answer 401 without one, the body of the e-mail change is checked by the
 * contract first, and a route nobody planned for is a network failure.
 */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    // A base path (`https://host/api`) is cut by the proxy before the API sees the route.
    const path = new URL(String(input)).pathname.replace(/^\/api(?=\/)/, '');
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ path, method, body });
    if (path === '/auth/providers') return scenario.providers === undefined ? json({ google: true }) : scenario.providers();
    if (path === '/auth/session') {
      await scenario.sessionGate;
      if (scenario.sessionDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, scenario.sessionDelayMs));
      return scenario.loggedIn === true ? json(sessionBody) : apiError(401, 'UNAUTHENTICATED');
    }
    if (path === '/auth/login') return apiError(401, 'INVALID_CREDENTIALS');
    const invitation = scenario.invitation;
    if (invitation !== undefined && path === `/invitations/${INVITE_TOKEN}`) {
      if (invitation.gone?.() === true) return apiError(410, 'INVITATION_INVALID');
      return json({ purpose: 'collaborator_invite', email: invitation.email, agency: { name: 'Agência Um' }, client: null, accountExists: invitation.accountExists ?? true });
    }
    if (scenario.loggedIn !== true) return apiError(401, 'UNAUTHENTICATED');
    if (invitation !== undefined && path === `/invitations/${INVITE_TOKEN}/accept` && method === 'POST') {
      // Like the API: a gone invitation is 410, and only the account of the invited address accepts.
      if (invitation.gone?.() === true) return apiError(410, 'INVITATION_INVALID');
      if (sessionBody.user.email !== invitation.email) return apiError(403, 'INVITATION_ACCOUNT_MISMATCH');
      return json({ status: 'accepted', context: { agencyId: AGENCY_A, clientId: null } });
    }
    if (path === '/me/legal-acceptances') return json(legalAccepted);
    if (path === '/me/contexts/resolve') return json(scenario.resolve ?? { decision: 'enter', context: agencyA });
    if (path === '/me/last-context' && method === 'PUT') return new Response(null, { status: 204 });
    if (path === `/agencies/${AGENCY_A}/me`) { await scenario.areaGate; return json(agencyMe); }
    if (path === `/clients/${CLIENT_ID}`) { await scenario.areaGate; return json(portalClient); }
    if (path === '/me/contexts') return json({ canCreateAgency: false, contexts: [] });
    if (path === '/me/email-change' && method === 'POST') {
      const request = body as { newEmail?: unknown; currentPassword?: unknown };
      if (typeof request.newEmail !== 'string') return apiError(400, 'VALIDATION_ERROR');
      return scenario.emailChange === undefined
        ? json({}, 202)
        : scenario.emailChange({ newEmail: request.newEmail, ...(typeof request.currentPassword === 'string' ? { currentPassword: request.currentPassword } : {}) });
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { impl, calls, count: (path: string) => calls.filter((call) => call.path === path).length };
};

function SessionHarness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface Probe {
  pathname: string;
  search: string;
  state: unknown;
  /** Every address the screen was at, in order: an address the person only passed through is a result too. */
  visited: string[];
  navigate: NavigateFunction;
}

const newProbe = (): Probe => ({ pathname: '', search: '', state: null, visited: [], navigate: () => undefined });

function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.state = location.state;
    probe.navigate = navigate;
    const address = `${location.pathname}${location.search}`;
    if (probe.visited[probe.visited.length - 1] !== address) probe.visited.push(address);
  });
  return null;
}

const renderApp = (impl: typeof fetch, entry: string | { pathname: string; state: unknown }, baseUrl = 'http://127.0.0.1:3001') => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient(baseUrl, impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  const probe = newProbe();
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <LocationProbe probe={probe} />
            <SessionHarness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, queryClient };
};

/** Lets a request that should NOT change the screen finish, so an absence is a result and not a screen that was not ready. */
const settle = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });

/** Clicks a link the way a browser would, but keeps jsdom from navigating; says whether the page itself cancelled the click. */
const clickAndReportCancelled = (element: HTMLElement): boolean => {
  let cancelled = true;
  const listener = (event: Event): void => { cancelled = event.defaultPrevented; event.preventDefault(); };
  document.addEventListener('click', listener);
  fireEvent.click(element);
  document.removeEventListener('click', listener);
  return cancelled;
};

const START = 'http://127.0.0.1:3001/auth/google/start';

describe('the Google button on /entrar and /criar-conta (issue #713)', () => {
  it('shows "Entrar com o Google" under the sign-in form, as a link to the API route, with the divider', async () => {
    const { impl, count } = makeFetch();
    renderApp(impl, '/entrar');

    const link = await screen.findByRole('link', { name: 'Entrar com o Google' });
    expect(link.getAttribute('href')).toBe(START);
    expect(screen.getByText('ou')).toBeTruthy();
    expect(count('/auth/providers')).toBe(1);
    // It sits after the password sign-in and before the invitation to create an account.
    const submit = screen.getByRole('button', { name: 'Entrar' });
    expect(submit.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Ainda não tem conta?').compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('lets the click through: the link leaves the page by itself, no script holds it back', async () => {
    const { impl } = makeFetch();
    renderApp(impl, '/entrar');
    const link = await screen.findByRole('link', { name: 'Entrar com o Google' });

    expect(clickAndReportCancelled(link)).toBe(false);
  });

  it('shows the same button under the sign-up form', async () => {
    const { impl } = makeFetch();
    renderApp(impl, '/criar-conta');

    const link = await screen.findByRole('link', { name: 'Entrar com o Google' });
    expect(link.getAttribute('href')).toBe(START);
    expect(screen.getByRole('button', { name: 'Criar conta' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Já tenho conta' })).toBeTruthy();
  });

  it('keeps the base path of the API in the link: behind a proxy at /api the route is /api/auth/google/start', async () => {
    const { impl } = makeFetch();
    renderApp(impl, '/entrar', 'https://app.example.test/api');

    const link = await screen.findByRole('link', { name: 'Entrar com o Google' });
    expect(link.getAttribute('href')).toBe('https://app.example.test/api/auth/google/start');
  });

  it.each([
    ['says Google is off', () => json({ google: false })],
    ['fails', () => apiError(500, 'INTERNAL_ERROR')],
    ['answers something that is not the contract', () => json({ google: 'yes' })],
    ['answers a flag with an extra field', () => json({ google: true, clientId: 'leaked' })]
  ])('shows no button, no divider and keeps the form whole when the providers read %s', async (_name, providers) => {
    const { impl, count } = makeFetch({ providers });
    renderApp(impl, '/entrar');
    await screen.findByRole('button', { name: 'Entrar' });
    await waitFor(() => expect(count('/auth/providers')).toBe(1));
    await settle();

    expect(screen.queryByRole('link', { name: 'Entrar com o Google' })).toBeNull();
    expect(screen.queryByText('ou')).toBeNull();
    expect(screen.getByLabelText('E-mail')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Criar conta' })).toBeTruthy();
  });

  it('shows no button on the sign-up form while Google is off', async () => {
    const { impl, count } = makeFetch({ providers: () => json({ google: false }) });
    renderApp(impl, '/criar-conta');
    await screen.findByRole('button', { name: 'Criar conta' });
    await waitFor(() => expect(count('/auth/providers')).toBe(1));
    await settle();

    expect(screen.queryByRole('link', { name: 'Entrar com o Google' })).toBeNull();
  });

  it('shows the button on a sign-in that carries an invitation (the owner decided it, 2026-10-26), with no token in the address', async () => {
    const { impl } = makeFetch();
    renderApp(impl, { pathname: '/entrar', state: { inviteToken: INVITE_TOKEN } });

    const link = await screen.findByRole('link', { name: 'Entrar com o Google' });
    expect(link.getAttribute('href')).toBe(START);
    expect(clickAndReportCancelled(link)).toBe(false);
    expect(window.sessionStorage.getItem(INVITE_KEY)).toBe(INVITE_TOKEN);
  });
});

describe('the single refusal message of /entrar?erro=google (issue #713)', () => {
  it('says the same sentence as a wrong password, as an alert, and nothing about the reason', async () => {
    const { impl } = makeFetch();
    renderApp(impl, '/entrar?erro=google');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('E-mail ou senha incorretos.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/google (recusou|negou|não)|não verificado|não confirmado|já existe|conta existente/i);
    expect(screen.getByLabelText('E-mail')).toBeTruthy();
  });

  it('shows no alert on /entrar without the mark, nor for another value of it', async () => {
    const { impl } = makeFetch();
    renderApp(impl, '/entrar?erro=outro');
    await screen.findByRole('button', { name: 'Entrar' });
    await settle();

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not say it twice when the password sign-in is also refused on the same screen', async () => {
    const { impl, count } = makeFetch();
    renderApp(impl, '/entrar?erro=google');
    await screen.findByRole('alert');

    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'pessoa@example.test' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'a wrong password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    await waitFor(() => expect(count('/auth/login')).toBe(1));
    await settle();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe('E-mail ou senha incorretos.');
  });
});

describe('the landing /entrar/google (issue #713)', () => {
  it('says what is happening while the session is read', async () => {
    let release: () => void = () => undefined;
    const sessionGate = new Promise<void>((resolve) => { release = resolve; });
    const { impl } = makeFetch({ loggedIn: true, sessionGate });
    renderApp(impl, '/entrar/google');

    expect(await screen.findByRole('heading', { name: 'Entrando com o Google' })).toBeTruthy();
    expect(screen.getByText('Só um instante.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Confirmando o seu acesso…');
    release();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Entrando com o Google' })).toBeNull());
  });

  it('with a session goes on through the sign-in screen, which resolves the destination like it does after a password', async () => {
    const { impl, calls } = makeFetch({ loggedIn: true });
    const { probe } = renderApp(impl, '/entrar/google');

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(calls.filter((call) => call.path === '/me/contexts/resolve').length).toBeGreaterThan(0);
    expect(calls.filter((call) => call.method === 'PUT').map((call) => [call.path, call.body])).toEqual([
      ['/me/last-context', { type: 'agency', agencyId: AGENCY_A }]
    ]);
  });

  it('with several contexts sends the person to choose one', async () => {
    const { impl } = makeFetch({ loggedIn: true, resolve: selectBoth });
    const { probe } = renderApp(impl, '/entrar/google');

    expect(await screen.findByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy();
    expect(probe.pathname).toBe('/contextos');
  });

  it('without a session is the same refusal as any other, on /entrar, with the one message', async () => {
    const { impl } = makeFetch({ loggedIn: false });
    const { probe } = renderApp(impl, '/entrar/google');

    expect((await screen.findByRole('alert')).textContent).toBe('E-mail ou senha incorretos.');
    expect(probe.pathname).toBe('/entrar');
    expect(probe.search).toBe('?erro=google');
  });

  describe('after a reauthentication (?intent=reauth)', () => {
    it('goes back to the screen that asked and reopens the e-mail change there, in its Google mode', async () => {
      window.sessionStorage.setItem(REAUTH_KEY, '/contextos');
      const { impl } = makeFetch({ loggedIn: true, resolve: selectBoth });
      const { probe } = renderApp(impl, '/entrar/google?intent=reauth');

      const dialog = await screen.findByRole('dialog', { name: 'Pedir troca de e-mail' });
      expect(probe.pathname).toBe('/contextos');
      expect(within(dialog).queryByLabelText('Senha atual')).toBeNull();
      expect(within(dialog).getByText(/Você entra com o Google, então não há senha para confirmar/)).toBeTruthy();
      // The mark is spent on arrival: the entry does not reopen the dialog again.
      await waitFor(() => expect(probe.state).toBeNull());
      expect(window.sessionStorage.getItem(REAUTH_KEY)).toBeNull();
    });

    it.each([
      ['an address of another site', '//evil.example.test/steal'],
      ['an absolute address', 'https://evil.example.test/'],
      ['a backslash that browsers read as a slash', '/\\evil.example.test'],
      ['nothing', null]
    ])('falls back to /contextos when what was kept is %s', async (_name, kept) => {
      if (kept !== null) window.sessionStorage.setItem(REAUTH_KEY, kept);
      const { impl } = makeFetch({ loggedIn: true, resolve: selectBoth });
      const { probe } = renderApp(impl, '/entrar/google?intent=reauth');

      expect(await screen.findByRole('heading', { name: 'Onde você quer entrar?' })).toBeTruthy();
      expect(probe.pathname).toBe('/contextos');
    });

    it('with no session is the refusal, and keeps nothing it must not follow', async () => {
      window.sessionStorage.setItem(REAUTH_KEY, '/contextos');
      const { impl } = makeFetch({ loggedIn: false });
      const { probe } = renderApp(impl, '/entrar/google?intent=reauth');

      expect((await screen.findByRole('alert')).textContent).toBe('E-mail ou senha incorretos.');
      expect(probe.pathname).toBe('/entrar');
      expect(probe.search).toBe('?erro=google');
    });
  });
});

describe('the return from Google when the page loads from scratch (review of #736)', () => {
  // The landing asks for the session before the app subscribes to the store, and the app then asks again: the first read is
  // dropped. The answers come one task apart, as in a browser, so the return must wait for the read that publishes.
  const REFUSED = '/entrar?erro=google';

  it('with a session never passes through the refusal on the way in', async () => {
    const { impl } = makeFetch({ loggedIn: true, sessionDelayMs: 15 });
    const { probe } = renderApp(impl, '/entrar/google');

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(probe.visited).not.toContain(REFUSED);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('after a reauthentication goes back to the screen that asked and reopens the dialog, never through the refusal', async () => {
    window.sessionStorage.setItem(REAUTH_KEY, '/contextos');
    const { impl } = makeFetch({ loggedIn: true, resolve: selectBoth, sessionDelayMs: 15 });
    const { probe } = renderApp(impl, '/entrar/google?intent=reauth');

    expect(await screen.findByRole('dialog', { name: 'Pedir troca de e-mail' })).toBeTruthy();
    expect(probe.pathname).toBe('/contextos');
    expect(probe.visited).not.toContain(REFUSED);
    expect(window.sessionStorage.getItem(REAUTH_KEY)).toBeNull();
  });

  it('without a session is still the refusal, once the reads are done', async () => {
    const { impl } = makeFetch({ loggedIn: false, sessionDelayMs: 15 });
    const { probe } = renderApp(impl, '/entrar/google');

    expect((await screen.findByRole('alert')).textContent).toBe('E-mail ou senha incorretos.');
    expect(probe.visited).toContain(REFUSED);
  });

  it('does not take the person back when the screen was left before the session answered', async () => {
    let release: () => void = () => undefined;
    const sessionGate = new Promise<void>((resolve) => { release = resolve; });
    const { impl } = makeFetch({ loggedIn: false, sessionGate });
    const { probe } = renderApp(impl, '/entrar/google');
    await screen.findByRole('heading', { name: 'Entrando com o Google' });

    act(() => { probe.navigate('/criar-conta'); });
    await screen.findByRole('heading', { name: 'Criar conta' });
    release();
    await settle();

    expect(probe.pathname).toBe('/criar-conta');
    expect(probe.visited).not.toContain(REFUSED);
  });
});

describe('Google on the invitation screen (review of #736; owner decision 2026-10-26)', () => {
  const INVITED = sessionBody.user.email;
  const OTHER = 'outra.pessoa@example.test';
  const acceptPosts = (calls: readonly Call[]) => calls.filter((call) => call.method === 'POST' && call.path === `/invitations/${INVITE_TOKEN}/accept`);

  /** Clicks the button on the invitation, then loads the app from scratch at the return, as the browser does after Google. */
  const goToGoogleAndBack = async (before: ReturnType<typeof makeFetch>, after: ReturnType<typeof makeFetch>) => {
    renderApp(before.impl, `/convite/${INVITE_TOKEN}`);
    const link = await screen.findByRole('link', { name: 'Entrar com o Google' });
    expect(link.getAttribute('href')).toBe(START);
    expect(clickAndReportCancelled(link)).toBe(false);
    cleanup();
    return renderApp(after.impl, '/entrar/google');
  };

  it('offers the button to a visitor, to whoever has an account and to whoever has not, and only while Google is on', async () => {
    for (const accountExists of [true, false]) {
      const { impl } = makeFetch({ invitation: { email: INVITED, accountExists } });
      renderApp(impl, `/convite/${INVITE_TOKEN}`);
      expect(await screen.findByRole('link', { name: 'Entrar com o Google' })).toBeTruthy();
      cleanup();
    }
    const off = makeFetch({ invitation: { email: INVITED }, providers: () => json({ google: false }) });
    renderApp(off.impl, `/convite/${INVITE_TOKEN}`);
    await screen.findByRole('button', { name: 'Aceitar convite' });
    await waitFor(() => expect(off.count('/auth/providers')).toBe(1));
    await settle();
    expect(screen.queryByRole('link', { name: 'Entrar com o Google' })).toBeNull();
  });

  it('does not offer it to a person who is already connected', async () => {
    const { impl, count } = makeFetch({ loggedIn: true, invitation: { email: INVITED } });
    renderApp(impl, `/convite/${INVITE_TOKEN}`);
    await screen.findByRole('button', { name: 'Aceitar convite' });
    await settle();

    expect(screen.queryByRole('link', { name: 'Entrar com o Google' })).toBeNull();
    expect(count('/auth/providers')).toBe(0);
  });

  it('accepts on the way back when the Google address is the invited one, through the screen of the invitation', async () => {
    const before = makeFetch({ invitation: { email: INVITED } });
    const after = makeFetch({ loggedIn: true, invitation: { email: INVITED } });
    const { probe } = await goToGoogleAndBack(before, after);

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(acceptPosts(after.calls)).toHaveLength(1);
    expect(probe.visited).toEqual([`/entrar/google`, `/convite/${INVITE_TOKEN}`, `/agencia/${AGENCY_A}`]);
    // Spent: nothing of the invitation stays in the tab.
    expect(window.sessionStorage.getItem(INVITE_KEY)).toBeNull();
  });

  it('accepts nothing and links nothing when the Google address is another one, and shows the error the invitation already shows', async () => {
    const before = makeFetch({ invitation: { email: OTHER } });
    const after = makeFetch({ loggedIn: true, invitation: { email: OTHER } });
    const { probe } = await goToGoogleAndBack(before, after);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(`Você está conectado com outra conta. O convite foi enviado para ${OTHER}.`);
    expect(screen.getByRole('button', { name: 'Entrar com outra conta' })).toBeTruthy();
    await settle();
    expect(acceptPosts(after.calls)).toHaveLength(0);
    expect(after.calls.filter((call) => call.method === 'PUT' || call.path === '/me/contexts/resolve')).toEqual([]);
    expect(probe.pathname).toBe(`/convite/${INVITE_TOKEN}`);
  });

  it('shows the invitation as no longer valid when it expired or was revoked while the person was away, and accepts nothing', async () => {
    let gone = false;
    const before = makeFetch({ invitation: { email: INVITED, gone: () => gone } });
    const after = makeFetch({ loggedIn: true, invitation: { email: INVITED, gone: () => gone } });
    renderApp(before.impl, `/convite/${INVITE_TOKEN}`);
    clickAndReportCancelled(await screen.findByRole('link', { name: 'Entrar com o Google' }));
    cleanup();
    gone = true;
    renderApp(after.impl, '/entrar/google');

    expect(await screen.findByRole('heading', { name: 'Este convite não é mais válido' })).toBeTruthy();
    await settle();
    expect(acceptPosts(after.calls)).toHaveLength(0);
  });

  it('never puts the token in an address sent to the server: the link is the bare start, and only the invitation routes carry it', async () => {
    const before = makeFetch({ invitation: { email: INVITED } });
    const after = makeFetch({ loggedIn: true, invitation: { email: INVITED } });
    const { probe } = await goToGoogleAndBack(before, after);
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));

    const withToken = [...before.calls, ...after.calls].map((call) => call.path).filter((path) => path.includes(INVITE_TOKEN));
    expect(new Set(withToken)).toEqual(new Set([`/invitations/${INVITE_TOKEN}`, `/invitations/${INVITE_TOKEN}/accept`]));
  });

  it('uses the kept invitation once: a later return goes on through the sign-in screen', async () => {
    window.sessionStorage.setItem(INVITE_KEY, INVITE_TOKEN);
    const first = makeFetch({ loggedIn: true, invitation: { email: INVITED } });
    const firstRun = renderApp(first.impl, '/entrar/google');
    await waitFor(() => expect(firstRun.probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    cleanup();

    const second = makeFetch({ loggedIn: true, invitation: { email: INVITED } });
    const secondRun = renderApp(second.impl, '/entrar/google');
    await waitFor(() => expect(secondRun.probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(secondRun.probe.visited).not.toContain(`/convite/${INVITE_TOKEN}`);
    expect(acceptPosts(second.calls)).toHaveLength(0);
  });

  it('forgets a refused return: without a session the kept invitation goes too', async () => {
    window.sessionStorage.setItem(INVITE_KEY, INVITE_TOKEN);
    const { impl } = makeFetch({ loggedIn: false });
    renderApp(impl, '/entrar/google');

    await screen.findByRole('alert');
    expect(window.sessionStorage.getItem(INVITE_KEY)).toBeNull();
  });

  it('does not follow a kept value that is not a token', async () => {
    window.sessionStorage.setItem(INVITE_KEY, 'x'.repeat(2_049));
    const { impl } = makeFetch({ loggedIn: true });
    const { probe } = renderApp(impl, '/entrar/google');

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(probe.visited.some((address) => address.startsWith('/convite/'))).toBe(false);
  });

  it('does not let an abandoned invitation ride on a later sign-in that has none', async () => {
    window.sessionStorage.setItem(INVITE_KEY, INVITE_TOKEN);
    const { impl } = makeFetch();
    renderApp(impl, '/entrar');

    clickAndReportCancelled(await screen.findByRole('link', { name: 'Entrar com o Google' }));

    expect(window.sessionStorage.getItem(INVITE_KEY)).toBeNull();
  });

  it('never takes a reauthentication to an invitation, even when one was left in the tab', async () => {
    window.sessionStorage.setItem(INVITE_KEY, INVITE_TOKEN);
    window.sessionStorage.setItem(REAUTH_KEY, '/contextos');
    const { impl } = makeFetch({ loggedIn: true, resolve: selectBoth, invitation: { email: INVITED } });
    const { probe } = renderApp(impl, '/entrar/google?intent=reauth');

    expect(await screen.findByRole('dialog', { name: 'Pedir troca de e-mail' })).toBeTruthy();
    expect(probe.pathname).toBe('/contextos');
    expect(probe.visited.some((address) => address.startsWith('/convite/'))).toBe(false);
  });

  it('does not keep the invitation for the reauthentication of an e-mail change', async () => {
    window.sessionStorage.setItem(INVITE_KEY, INVITE_TOKEN);
    const { impl } = makeFetch({ loggedIn: true, emailChange: () => apiError(403, 'REAUTH_REQUIRED') });
    renderMenu(impl);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: GOOGLE_TOGGLE }));
    fireEvent.change(within(dialog).getByLabelText('Novo e-mail'), { target: { value: 'novo@exemplo.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));
    clickAndReportCancelled(await within(dialog).findByRole('link', { name: 'Confirmar com o Google' }));

    expect(window.sessionStorage.getItem(INVITE_KEY)).toBeNull();
  });
});

describe('the dialog of the e-mail change reopens in the real menu of the area (review of #736)', () => {
  // The menus of the loading skeletons are gone when the area loads: if one of them spent the mark, the real one would not find it.
  const back = async (area: string) => {
    window.sessionStorage.setItem(REAUTH_KEY, area);
    let release: () => void = () => undefined;
    const areaGate = new Promise<void>((resolve) => { release = resolve; });
    const { impl } = makeFetch({ loggedIn: true, areaGate });
    const { probe } = renderApp(impl, '/entrar/google?intent=reauth');

    await waitFor(() => expect(probe.pathname).toBe(area));
    // On the skeleton: the mark is still there, nothing opened.
    expect((probe.state as { reopenEmailChange?: unknown } | null)?.reopenEmailChange).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'Pedir troca de e-mail' })).toBeNull();
    release();
    const dialog = await screen.findByRole('dialog', { name: 'Pedir troca de e-mail' });
    expect(within(dialog).queryByLabelText('Senha atual')).toBeNull();
    await waitFor(() => expect(probe.state).toBeNull());
  };

  it('back to the agency area', async () => {
    await back(`/agencia/${AGENCY_A}`);
  });

  it('back to the client portal', async () => {
    await back(`/portal/${CLIENT_ID}/inicio`);
  });
});

const renderMenu = (impl: typeof fetch, entry: string | { pathname: string; state: unknown } = `/agencia/${AGENCY_A}`) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: createSessionEndSignal().notify });
  const store = createAuthSessionStore(client);
  const probe = newProbe();
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <LocationProbe probe={probe} />
            <AccountMenu activeContext='Agência Um' />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe };
};

const openDialog = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Pedir troca de e-mail' }));
  return screen.findByRole('dialog', { name: 'Pedir troca de e-mail' });
};

const GOOGLE_TOGGLE = 'Não tenho senha, entro com o Google';

describe('the e-mail change of an account that has only Google (issue #713)', () => {
  const googleOnly = (sessionIsRecent: boolean) => (body: { newEmail: string; currentPassword?: string }): Response => {
    // The real route: the account has no password, so one in the body is not asked for; an old session wants Google again.
    if (body.currentPassword !== undefined) return apiError(403, 'INVALID_PASSWORD');
    return sessionIsRecent ? json({}, 202) : apiError(403, 'REAUTH_REQUIRED');
  };

  it('offers the way without a password only while Google is on', async () => {
    const off = makeFetch({ loggedIn: true, providers: () => json({ google: false }) });
    renderMenu(off.impl);
    const dialog = await openDialog();
    await waitFor(() => expect(off.count('/auth/providers')).toBe(1));
    await settle();

    expect(within(dialog).getByLabelText('Senha atual')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: GOOGLE_TOGGLE })).toBeNull();
  });

  it('keeps the password form first and offers the Google way as a button, when Google is on', async () => {
    const { impl } = makeFetch({ loggedIn: true });
    renderMenu(impl);
    const dialog = await openDialog();

    expect(within(dialog).getByLabelText('Senha atual')).toBeTruthy();
    expect(await within(dialog).findByRole('button', { name: GOOGLE_TOGGLE })).toBeTruthy();
  });

  it('sends the request without any password, and says it went out', async () => {
    const { impl, calls } = makeFetch({ loggedIn: true, emailChange: googleOnly(true) });
    renderMenu(impl);
    const dialog = await openDialog();

    fireEvent.click(await within(dialog).findByRole('button', { name: GOOGLE_TOGGLE }));
    expect(within(dialog).queryByLabelText('Senha atual')).toBeNull();
    expect(within(dialog).getByText(/Você entra com o Google, então não há senha para confirmar/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Novo e-mail'), { target: { value: ' Novo@Exemplo.test ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));

    await within(dialog).findByText(/Pedido enviado/);
    expect(calls.filter((call) => call.path === '/me/email-change').map((call) => call.body)).toEqual([{ newEmail: 'novo@exemplo.test' }]);
  });

  it('still checks the new address on the screen before calling the API', async () => {
    const { impl, count } = makeFetch({ loggedIn: true, emailChange: googleOnly(true) });
    renderMenu(impl);
    const dialog = await openDialog();

    fireEvent.click(await within(dialog).findByRole('button', { name: GOOGLE_TOGGLE }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));

    expect(within(dialog).getByText('Informe um e-mail válido.')).toBeTruthy();
    expect(within(dialog).queryByText('Informe a senha atual.')).toBeNull();
    expect(count('/me/email-change')).toBe(0);
  });

  it('on an old session says to confirm with Google and offers the reauthentication link, then keeps the way back', async () => {
    const { impl } = makeFetch({ loggedIn: true, emailChange: googleOnly(false) });
    renderMenu(impl, `/agencia/${AGENCY_A}?aba=geral`);
    const dialog = await openDialog();

    fireEvent.click(await within(dialog).findByRole('button', { name: GOOGLE_TOGGLE }));
    fireEvent.change(within(dialog).getByLabelText('Novo e-mail'), { target: { value: 'novo@exemplo.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));

    expect(await within(dialog).findByText('Confirme com o Google para continuar.')).toBeTruthy();
    expect(within(dialog).queryByText(/Pedido enviado/)).toBeNull();
    const link = within(dialog).getByRole('link', { name: 'Confirmar com o Google' });
    expect(link.getAttribute('href')).toBe(`${START}?intent=reauth`);
    expect(window.sessionStorage.getItem(REAUTH_KEY)).toBeNull();

    expect(clickAndReportCancelled(link)).toBe(false);
    expect(window.sessionStorage.getItem(REAUTH_KEY)).toBe(`/agencia/${AGENCY_A}?aba=geral`);
    // The refusal keeps what was typed.
    expect((within(dialog).getByLabelText('Novo e-mail') as HTMLInputElement).value).toBe('novo@exemplo.test');
  });

  it('offers no way to Google when Google has been turned off in the meantime, and still says why the request stopped', async () => {
    const { impl, count } = makeFetch({ loggedIn: true, providers: () => json({ google: false }), emailChange: googleOnly(false) });
    renderMenu(impl, { pathname: `/agencia/${AGENCY_A}`, state: { reopenEmailChange: true } });
    const dialog = await screen.findByRole('dialog', { name: 'Pedir troca de e-mail' });

    fireEvent.change(within(dialog).getByLabelText('Novo e-mail'), { target: { value: 'novo@exemplo.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));

    expect(await within(dialog).findByText('Confirme com o Google para continuar.')).toBeTruthy();
    await waitFor(() => expect(count('/auth/providers')).toBe(1));
    await settle();
    expect(within(dialog).queryByRole('link', { name: 'Confirmar com o Google' })).toBeNull();
  });

  it('takes the reauthentication prompt away when the person tries again', async () => {
    let recent = false;
    const { impl } = makeFetch({ loggedIn: true, emailChange: (body) => googleOnly(recent)(body) });
    renderMenu(impl);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: GOOGLE_TOGGLE }));
    fireEvent.change(within(dialog).getByLabelText('Novo e-mail'), { target: { value: 'novo@exemplo.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));
    await within(dialog).findByText('Confirme com o Google para continuar.');

    recent = true;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));

    await within(dialog).findByText(/Pedido enviado/);
    expect(within(dialog).queryByText('Confirme com o Google para continuar.')).toBeNull();
  });

  it('goes back to the password field when the API says the account has a password after all', async () => {
    // The real route: a body without a password for an account that has one is a 400.
    const { impl } = makeFetch({ loggedIn: true, emailChange: () => apiError(400, 'VALIDATION_ERROR') });
    renderMenu(impl);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: GOOGLE_TOGGLE }));
    fireEvent.change(within(dialog).getByLabelText('Novo e-mail'), { target: { value: 'novo@exemplo.test' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' }));

    expect(await within(dialog).findByText('Informe a senha atual.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Senha atual')).toBeTruthy();
    expect((within(dialog).getByLabelText('Novo e-mail') as HTMLInputElement).value).toBe('novo@exemplo.test');
  });

  it('lets the person go back to the password with "Tenho uma senha"', async () => {
    const { impl } = makeFetch({ loggedIn: true });
    renderMenu(impl);
    const dialog = await openDialog();
    fireEvent.click(await within(dialog).findByRole('button', { name: GOOGLE_TOGGLE }));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Tenho uma senha' }));

    expect(within(dialog).getByLabelText('Senha atual')).toBeTruthy();
    expect(within(dialog).queryByText(/Você entra com o Google/)).toBeNull();
  });

  describe('coming back from Google', () => {
    it('opens the dialog already in the Google mode and spends the mark, so a reload does not open it again', async () => {
      const { impl } = makeFetch({ loggedIn: true });
      const { probe } = renderMenu(impl, { pathname: `/agencia/${AGENCY_A}`, state: { reopenEmailChange: true } });

      const dialog = await screen.findByRole('dialog', { name: 'Pedir troca de e-mail' });
      expect(within(dialog).queryByLabelText('Senha atual')).toBeNull();
      expect(within(dialog).getByText(/Você entra com o Google, então não há senha para confirmar/)).toBeTruthy();
      await waitFor(() => expect(probe.state).toBeNull());
      expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`);
    });

    it('does not open anything on an ordinary visit to the same address', async () => {
      const { impl } = makeFetch({ loggedIn: true });
      renderMenu(impl);
      await screen.findByRole('button', { name: /Pessoa/ });
      await settle();

      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('asks for the password again when the dialog is closed and opened again from the menu', async () => {
      const { impl } = makeFetch({ loggedIn: true });
      renderMenu(impl, { pathname: `/agencia/${AGENCY_A}`, state: { reopenEmailChange: true } });
      const first = await screen.findByRole('dialog', { name: 'Pedir troca de e-mail' });

      fireEvent.click(within(first).getByRole('button', { name: 'Cancelar' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const second = await openDialog();

      expect(within(second).getByLabelText('Senha atual')).toBeTruthy();
    });
  });
});
