// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { signUpEmailState } from './sign-up.js';

afterEach(cleanup);

const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);

interface Scenario {
  readonly initiallyLoggedIn?: boolean;
  readonly verifyError?: Response;
  /** Refuses only the request that carries no password: the session is not the account of the link. */
  readonly verifyWithoutPasswordError?: Response;
}

const makeFetch = (scenario: Scenario = {}) => {
  const bodies: Record<string, unknown[]> = { signUp: [], resend: [], verify: [] };
  let serverLoggedIn = scenario.initiallyLoggedIn ?? false;
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = (): unknown => JSON.parse(String(init?.body));
    if (url.endsWith('/auth/session')) return serverLoggedIn ? json(sessionBody) : unauthenticated();
    if (url.endsWith('/auth/sign-up')) { bodies.signUp!.push(body()); return json({}, 202); }
    if (url.endsWith('/auth/email/verification/resend')) { bodies.resend!.push(body()); return json({}, 202); }
    if (url.endsWith('/auth/email/verify')) {
      bodies.verify!.push(body());
      if (scenario.verifyError !== undefined) return scenario.verifyError;
      if (scenario.verifyWithoutPasswordError !== undefined && !('password' in (body() as object))) return scenario.verifyWithoutPasswordError;
      serverLoggedIn = true;
      return json({ user: sessionBody.user });
    }
    if (url.includes('/me/contexts/resolve')) return serverLoggedIn ? json({ decision: 'none' }) : unauthenticated();
    throw new Error(`unexpected ${url}`);
  };
  return { impl, bodies };
};

function SessionHarness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

function LocationProbe({ probe }: { probe: { pathname: string; search: string } }) {
  useCommittedLocation((location) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
  });
  return null;
}

const renderAt = (impl: typeof fetch, entry: string | { pathname: string; state: unknown }) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  void store.refresh();
  const probe = { pathname: '', search: '' };
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
  return { probe, store, queryClient };
};

describe('SignUpPage (/criar-conta, #713)', () => {
  it('needs the acceptance, sends the four fields, and then says the link went to the e-mail, with a resend', async () => {
    const { impl, bodies } = makeFetch();
    renderAt(impl, '/criar-conta');
    expect(document.title).toBe('Criar conta — Ageniza');

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pessoa Nova' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: ' Nova@Example.test ' } });
    fireEvent.change(screen.getByLabelText(/^Senha/), { target: { value: 'a long enough password' } });
    const submit = screen.getByRole('button', { name: 'Criar conta' });
    expect(submit.getAttribute('aria-disabled') === 'true' || submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }));

    expect(await screen.findByRole('heading', { name: 'Enviamos um link para o seu e-mail' })).toBeTruthy();
    expect(bodies.signUp).toEqual([{ name: 'Pessoa Nova', email: 'nova@example.test', password: 'a long enough password', acceptTerms: true }]);

    fireEvent.click(screen.getByRole('button', { name: 'Reenviar o link' }));
    await waitFor(() => expect(bodies.resend).toEqual([{ email: 'nova@example.test' }]));
  });

  it('starts with the address carried by the navigation (the approval link), and the person can still change it', async () => {
    const { impl, bodies } = makeFetch();
    renderAt(impl, { pathname: '/criar-conta', state: signUpEmailState('maria@padariacentral.example.test') });
    expect((screen.getByLabelText('E-mail') as HTMLInputElement).value).toBe('maria@padariacentral.example.test');
    expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('');

    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Maria Souza' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'outra@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Senha/), { target: { value: 'a long enough password' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }));
    await screen.findByRole('heading', { name: 'Enviamos um link para o seu e-mail' });
    expect(bodies.signUp).toEqual([{ name: 'Maria Souza', email: 'outra@example.test', password: 'a long enough password', acceptTerms: true }]);
  });

  it.each([
    ['text that is not an address', { email: 'not an address' }],
    ['something that is not text', { email: 42 }],
    ['no address at all', {}],
    ['no state', null]
  ])('starts empty when the navigation carries %s', (_name, state) => {
    const { impl } = makeFetch();
    renderAt(impl, { pathname: '/criar-conta', state });
    expect((screen.getByLabelText('E-mail') as HTMLInputElement).value).toBe('');
  });

  it('refuses a short password on the screen, without sending', async () => {
    const { impl, bodies } = makeFetch();
    renderAt(impl, '/criar-conta');
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Pessoa Nova' } });
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'nova@example.test' } });
    fireEvent.change(screen.getByLabelText(/^Senha/), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Criar conta' }));

    expect((await screen.findAllByText('A senha tem no mínimo 10 caracteres.')).length).toBeGreaterThan(0);
    expect(bodies.signUp).toEqual([]);
  });

  it('pins type, autocomplete and name of each credential field, and opens the documents apart (checklist item 72)', async () => {
    const { impl } = makeFetch();
    renderAt(impl, '/criar-conta');
    await screen.findByLabelText('Nome');

    const fields = [
      ['Nome', 'text', 'name', 'name'],
      ['E-mail', 'email', 'email', 'email'],
      [/^Senha/, 'password', 'new-password', 'password']
    ] as const;
    for (const [label, type, autocomplete, name] of fields) {
      const input = screen.getByLabelText(label);
      expect([String(label), input.getAttribute('type') ?? 'text', input.getAttribute('autocomplete'), input.getAttribute('name')])
        .toEqual([String(label), type, autocomplete, name]);
    }
    for (const [text, href] of [['Termos de Uso', '/termos'], ['Política de Privacidade', '/privacidade']] as const) {
      const link = screen.getByRole('link', { name: text });
      expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual([href, '_blank', 'noreferrer']);
    }
  });

  it('sends a signed-in person to the app instead', async () => {
    const { impl } = makeFetch({ initiallyLoggedIn: true });
    const { probe } = renderAt(impl, '/criar-conta');
    await waitFor(() => expect(probe.pathname).toBe('/comecar'));
  });
});

describe('VerifyEmailPage (/email/verificar, finding A1 of the review of PR #720)', () => {
  it('takes the token out of the address, asks for the password, and signs in to /comecar', async () => {
    const { impl, bodies } = makeFetch();
    const { probe } = renderAt(impl, '/email/verificar?token=the-token');

    await waitFor(() => expect(probe.search).toBe(''));
    expect(probe.pathname).toBe('/email/verificar');
    const passwordField = screen.getByLabelText('Senha');
    expect([passwordField.getAttribute('type'), passwordField.getAttribute('autocomplete'), passwordField.getAttribute('name')])
      .toEqual(['password', 'current-password', 'password']);
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'the account password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e-mail' }));

    await waitFor(() => expect(probe.pathname).toBe('/comecar'));
    expect(bodies.verify).toEqual([{ token: 'the-token', password: 'the account password' }]);
  });

  it('says the link or the password is wrong, in one sentence, and offers a new link', async () => {
    const { impl, bodies } = makeFetch({ verifyError: json({ error: { code: 'INVALID_LINK_OR_PASSWORD', message: 'x' } }, 400) });
    const { probe } = renderAt(impl, '/email/verificar?token=the-token');

    fireEvent.change(await screen.findByLabelText('Senha'), { target: { value: 'a wrong password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e-mail' }));

    expect((await screen.findByRole('alert')).textContent).toContain('O link não é mais válido ou a senha está incorreta.');
    expect(probe.pathname).toBe('/email/verificar');
    const emailField = screen.getByLabelText('E-mail da conta');
    expect([emailField.getAttribute('type'), emailField.getAttribute('autocomplete'), emailField.getAttribute('name')])
      .toEqual(['email', 'email', 'email']);
    fireEvent.change(screen.getByLabelText('E-mail da conta'), { target: { value: 'pessoa@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reenviar o link' }));
    await waitFor(() => expect(bodies.resend).toEqual([{ email: 'pessoa@example.test' }]));
  });

  it('clears what was cached for the account the browser had, once another one is confirmed', async () => {
    const { impl } = makeFetch({ initiallyLoggedIn: true });
    const { probe, queryClient, store } = renderAt(impl, '/email/verificar?token=the-token');
    // The browser's own session is in place first: what it cached is what must not survive.
    await store.refresh();
    queryClient.setQueryData(['another-account', 'profile'], { name: 'Conta que estava no navegador' });

    fireEvent.change(await screen.findByLabelText('Senha'), { target: { value: 'the account password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e-mail' }));

    await waitFor(() => expect(probe.pathname).toBe('/comecar'));
    expect(queryClient.getQueryData(['another-account', 'profile'])).toBeUndefined();
  });

  it('opens with a session in the browser, without redirecting (rule 11)', async () => {
    const { impl } = makeFetch({ initiallyLoggedIn: true });
    const { probe } = renderAt(impl, '/email/verificar?token=the-token');

    expect(await screen.findByRole('heading', { name: 'Confirmar e-mail' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probe.pathname).toBe('/email/verificar');
  });

  it('offers the click that sends no password only to a browser that holds a session (decision 2026-10-27)', async () => {
    const withoutSession = makeFetch();
    renderAt(withoutSession.impl, '/email/verificar?token=the-token');
    await screen.findByLabelText('Senha');
    expect(screen.queryByRole('button', { name: 'Confirmar sem digitar a senha' })).toBeNull();
    cleanup();

    const { impl, bodies } = makeFetch({ initiallyLoggedIn: true });
    const { probe, store } = renderAt(impl, '/email/verificar?token=the-token');
    await store.refresh();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar sem digitar a senha' }));

    await waitFor(() => expect(probe.pathname).toBe('/comecar'));
    // The token only: no password, not even an empty one.
    expect(bodies.verify).toEqual([{ token: 'the-token' }]);
  });

  it('keeps the password form when the API refuses the click, says why, and the password still confirms', async () => {
    const { impl, bodies } = makeFetch({
      initiallyLoggedIn: true,
      verifyWithoutPasswordError: json({ error: { code: 'INVALID_LINK_OR_PASSWORD', message: 'x' } }, 400)
    });
    const { probe, store } = renderAt(impl, '/email/verificar?token=the-token');
    await store.refresh();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar sem digitar a senha' }));

    expect((await screen.findByRole('alert')).textContent).toContain('pertence a outra conta. Digite a senha da conta do link.');
    expect(probe.pathname).toBe('/email/verificar');
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'the account password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e-mail' }));

    await waitFor(() => expect(probe.pathname).toBe('/comecar'));
    expect(bodies.verify).toEqual([{ token: 'the-token' }, { token: 'the-token', password: 'the account password' }]);
  });

  it('without a token shows the invalid link with the resend, and goes back to /entrar', async () => {
    const { impl } = makeFetch();
    const { probe } = renderAt(impl, '/email/verificar');

    expect(await screen.findByRole('heading', { name: 'Este link não é mais válido' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Voltar para entrar' }));
    await waitFor(() => expect(probe.pathname).toBe('/entrar'));
  });
});
