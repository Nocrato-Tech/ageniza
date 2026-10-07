// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { EmailChangeConfirmRequestSchema, EmailChangeRequestSchema } from '@ageniza/contracts';

import { AccountMenu } from './account-menu.js';
import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal } from './session-end.js';

afterEach(cleanup);

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
const AGENCY = '22222222-2222-4222-8222-222222222222';
const sessionBody = {
  user: { id: USER_ID, name: 'Pessoa', email: 'pessoa@example.test' },
  session: { expiresAt: '2026-01-01T00:00:00.000Z' }
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string): Response => json({ error: { code, message: code } }, status);

interface Call { readonly path: string; readonly method: string; readonly body: unknown }

interface Scenario {
  /** What the request route answers; the real route validates the body with the contract first. */
  request?: (body: { newEmail: string; currentPassword: string }) => Response;
  /** Tokens the link route accepts, once each. */
  validTokens?: Set<string>;
  confirmFails?: Response;
}

/** Answers like the real API: 400 for a body the contract refuses, a spent token is a dead link. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    if (url.pathname === '/auth/session') return json(sessionBody);
    if (url.pathname === '/me/contexts') return json({ contexts: [] });
    calls.push({ path: url.pathname, method, body });
    if (url.pathname === '/me/email-change' && method === 'POST') {
      const parsed = EmailChangeRequestSchema.safeParse(body);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR');
      return scenario.request === undefined ? json({}, 202) : scenario.request(parsed.data);
    }
    if (url.pathname === '/email-change/confirm' && method === 'POST') {
      const parsed = EmailChangeConfirmRequestSchema.safeParse(body);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR');
      if (scenario.confirmFails !== undefined) return scenario.confirmFails;
      const tokens = scenario.validTokens ?? new Set<string>();
      if (!tokens.delete(parsed.data.token)) return apiError(400, 'INVALID_LINK');
      return json({});
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  };
  return { impl, calls };
};

const posts = (calls: readonly Call[], path: string): Call[] => calls.filter((call) => call.path === path && call.method === 'POST');

function LocationProbe({ probe }: { probe: { pathname: string; search: string } }) {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.search = location.search;
  return null;
}

const renderMenu = (impl: typeof fetch) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: createSessionEndSignal().notify });
  const store = createAuthSessionStore(client);
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[`/agencia/${AGENCY}`]}>
            <AccountMenu activeContext='Agência Um' />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};

const openDialog = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Pedir troca de e-mail' }));
  return screen.findByRole('dialog', { name: 'Pedir troca de e-mail' });
};

const fill = (dialog: HTMLElement, email: string, password: string): void => {
  fireEvent.change(within(dialog).getByLabelText('Novo e-mail'), { target: { value: email } });
  fireEvent.change(within(dialog).getByLabelText('Senha atual'), { target: { value: password } });
};

const submit = (dialog: HTMLElement): void => { fireEvent.click(within(dialog).getByRole('button', { name: 'Enviar pedido' })); };

describe('asking for an e-mail change in the account menu (issue #80)', () => {
  it('offers the item in the account menu and opens a form with the two fields', async () => {
    const { impl } = makeFetch();
    renderMenu(impl);

    const dialog = await openDialog();

    expect(within(dialog).getByLabelText('Novo e-mail')).toBeTruthy();
    const password = within(dialog).getByLabelText('Senha atual');
    expect(password.getAttribute('type')).toBe('password');
    expect(password.getAttribute('autocomplete')).toBe('current-password');
  });

  it('refuses an empty or malformed form on the screen, without a request', async () => {
    const { impl, calls } = makeFetch();
    renderMenu(impl);
    const dialog = await openDialog();

    submit(dialog);
    expect(within(dialog).getByText('Informe um e-mail válido.')).toBeTruthy();
    expect(within(dialog).getByText('Informe a senha atual.')).toBeTruthy();

    fill(dialog, 'not-an-address', 'a password');
    submit(dialog);
    expect(within(dialog).getByText('Informe um e-mail válido.')).toBeTruthy();
    expect(within(dialog).queryByText('Informe a senha atual.')).toBeNull();
    expect(posts(calls, '/me/email-change')).toEqual([]);
  });

  it('sends exactly the address and the password, then says the request went out without touching the address', async () => {
    const { impl, calls } = makeFetch();
    renderMenu(impl);
    const dialog = await openDialog();

    fill(dialog, '  Novo.Endereco@Exemplo.test ', 'current password');
    submit(dialog);

    await within(dialog).findByText(/Pedido enviado/);
    expect(posts(calls, '/me/email-change').map((call) => call.body)).toEqual([
      { newEmail: 'novo.endereco@exemplo.test', currentPassword: 'current password' }
    ]);
    expect(within(dialog).queryByLabelText('Senha atual')).toBeNull();
    expect(dialog.textContent).not.toMatch(/novo\.endereco/i);
    expect(dialog.textContent).not.toMatch(/já (existe|pertence|usa)/i);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pedir troca de e-mail' })).toBeNull());
  });

  it('shows a wrong current password on the password field and keeps what was typed', async () => {
    const { impl } = makeFetch({ request: () => apiError(403, 'INVALID_PASSWORD') });
    renderMenu(impl);
    const dialog = await openDialog();

    fill(dialog, 'novo@exemplo.test', 'wrong password');
    submit(dialog);

    expect(await within(dialog).findByText('A senha atual não confere.')).toBeTruthy();
    expect((within(dialog).getByLabelText('Novo e-mail') as HTMLInputElement).value).toBe('novo@exemplo.test');
    expect(within(dialog).queryByText(/Pedido enviado/)).toBeNull();
  });

  it('shows the address the account already has on the address field', async () => {
    const { impl } = makeFetch({ request: () => apiError(400, 'SAME_EMAIL') });
    renderMenu(impl);
    const dialog = await openDialog();

    fill(dialog, 'pessoa@example.test', 'current password');
    submit(dialog);

    expect(await within(dialog).findByText('Informe um e-mail diferente do atual.')).toBeTruthy();
  });

  it('says so when there were too many attempts or the request failed, and can be repeated', async () => {
    let answer = (): Response => apiError(429, 'RATE_LIMITED');
    const { impl, calls } = makeFetch({ request: () => answer() });
    renderMenu(impl);
    const dialog = await openDialog();
    fill(dialog, 'novo@exemplo.test', 'current password');

    submit(dialog);
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Muitas tentativas. Tente novamente mais tarde.');

    answer = () => apiError(500, 'INTERNAL_ERROR');
    submit(dialog);
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toBe('Não foi possível enviar o pedido. Tente de novo.'));

    answer = () => json({}, 202);
    submit(dialog);
    await within(dialog).findByText(/Pedido enviado/);
    expect(posts(calls, '/me/email-change')).toHaveLength(3);
  });
});

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

const renderConfirm = (impl: typeof fetch, entry: string) => {
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: createSessionEndSignal().notify });
  const queryClient = createQueryClient();
  queryClient.setQueryData(['private-account-data'], { name: 'Private data' });
  const store = createAuthSessionStore(client);
  let ended = 0;
  const originalEnd = store.end.bind(store);
  store.end = () => { ended += 1; originalEnd(); };
  const probe = { pathname: '', search: '' };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <LocationProbe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, queryClient, endedCount: () => ended };
};

describe('confirming the new e-mail from the link (issue #80)', () => {
  it('asks for a click, and spends nothing on load', async () => {
    const { impl, calls } = makeFetch({ validTokens: new Set(['good-token']) });
    const { probe } = renderConfirm(impl, '/email/confirmar?token=good-token');

    expect(await screen.findByRole('heading', { name: 'Confirmar novo e-mail' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(posts(calls, '/email-change/confirm')).toEqual([]);
    expect(probe.pathname).toBe('/email/confirmar');
    expect(probe.search).toBe('');
  });

  it('sends the token the link carried, ends the local session, and offers the sign-in with the new address', async () => {
    const scenario = { validTokens: new Set(['good-token']) };
    const { impl, calls } = makeFetch(scenario);
    const { endedCount, queryClient } = renderConfirm(impl, '/email/confirmar?token=good-token');
    expect(queryClient.getQueryData(['private-account-data'])).toBeDefined();

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar troca de e-mail' }));

    expect(await screen.findByRole('heading', { name: 'E-mail alterado' })).toBeTruthy();
    expect(queryClient.getQueryData(['private-account-data'])).toBeUndefined();
    expect(posts(calls, '/email-change/confirm').map((call) => call.body)).toEqual([{ token: 'good-token' }]);
    expect(scenario.validTokens.size).toBe(0);
    expect(endedCount()).toBe(1);
    expect(screen.getByRole('link', { name: 'Entrar com o novo e-mail' }).getAttribute('href')).toBe('/entrar');
  });

  it('shows the dead-link screen for a used, expired or unknown link, and keeps the local session', async () => {
    const { impl } = makeFetch({ validTokens: new Set() });
    const { endedCount } = renderConfirm(impl, '/email/confirmar?token=spent-token');

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar troca de e-mail' }));

    expect(await screen.findByRole('heading', { name: 'Este link não é mais válido' })).toBeTruthy();
    expect(screen.getByText(/valem por 48 horas/)).toBeTruthy();
    expect(endedCount()).toBe(0);
  });

  it('shows the dead-link screen at once when the address carries no token, without a request', async () => {
    const { impl, calls } = makeFetch();
    renderConfirm(impl, '/email/confirmar');

    expect(await screen.findByRole('heading', { name: 'Este link não é mais válido' })).toBeTruthy();
    expect(posts(calls, '/email-change/confirm')).toEqual([]);
  });

  it('says so when the confirmation fails for another reason, and can be repeated', async () => {
    const scenario: Scenario = { validTokens: new Set(['good-token']), confirmFails: apiError(500, 'INTERNAL_ERROR') };
    const { impl } = makeFetch(scenario);
    const { endedCount } = renderConfirm(impl, '/email/confirmar?token=good-token');

    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar troca de e-mail' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível confirmar a troca. Tente de novo.');
    expect(endedCount()).toBe(0);

    scenario.confirmFails = undefined;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirmar troca de e-mail' })); });
    expect(await screen.findByRole('heading', { name: 'E-mail alterado' })).toBeTruthy();
  });
});
