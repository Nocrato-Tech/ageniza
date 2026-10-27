// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
  readonly resolve?: unknown;
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
      return scenario.loggedIn === true ? json(sessionBody) : apiError(401, 'UNAUTHENTICATED');
    }
    if (path === '/auth/login') return apiError(401, 'INVALID_CREDENTIALS');
    if (scenario.loggedIn !== true) return apiError(401, 'UNAUTHENTICATED');
    if (path === '/me/legal-acceptances') return json(legalAccepted);
    if (path === '/me/contexts/resolve') return json(scenario.resolve ?? { decision: 'enter', context: agencyA });
    if (path === '/me/last-context' && method === 'PUT') return new Response(null, { status: 204 });
    if (path === `/agencies/${AGENCY_A}/me`) return json(agencyMe);
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

interface Probe { pathname: string; search: string; state: unknown }

function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.state = location.state;
  });
  return null;
}

const renderApp = (impl: typeof fetch, entry: string | { pathname: string; state: unknown }, baseUrl = 'http://127.0.0.1:3001') => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient(baseUrl, impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  const probe: Probe = { pathname: '', search: '', state: null };
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

  it('shows no button on a sign-in that carries an invitation, which Google cannot carry, and asks nothing about Google', async () => {
    const { impl, count } = makeFetch();
    renderApp(impl, { pathname: '/entrar', state: { inviteToken: 'invite-token' } });
    await screen.findByRole('button', { name: 'Entrar' });
    await settle();

    expect(screen.queryByRole('link', { name: 'Entrar com o Google' })).toBeNull();
    expect(count('/auth/providers')).toBe(0);
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

const renderMenu = (impl: typeof fetch, entry: string | { pathname: string; state: unknown } = `/agencia/${AGENCY_A}`) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: createSessionEndSignal().notify });
  const store = createAuthSessionStore(client);
  const probe: Probe = { pathname: '', search: '', state: null };
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
