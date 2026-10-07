// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AcceptLegalDocumentRequestSchema } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

afterEach(cleanup);

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const agencyMe = { agencyId: AGENCY, agencyName: 'Agência Um', isOwner: true, role: { key: 'admin', name: 'Admin' }, permissions: ['colaborador.visualizar'] };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Document = 'terms' | 'privacy';

interface Account {
  readonly current: Record<Document, string>;
  /** The newest version the account accepted, as the server would keep it. */
  accepted: Record<Document, string | null>;
}

interface Scenario {
  readonly account: Account;
  /** Makes the next POSTs fail with a 500, to exercise the error path. */
  failAccept?: boolean;
  /** Makes the status read fail with a 500. */
  failRead?: boolean;
}

const status = (account: Account) => ({
  documents: (['terms', 'privacy'] as const).map((document) => ({
    document,
    currentVersion: account.current[document],
    acceptedVersion: account.accepted[document],
    pending: account.accepted[document] === null || account.accepted[document]! < account.current[document]
  }))
});

/** Answers like the real API: 400 for a body the contract refuses, and a per-document record. */
const makeFetch = (scenario: Scenario) => {
  const calls: string[] = [];
  const posted: unknown[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${new URL(url).pathname}`);
    if (url.endsWith('/auth/session')) return json(sessionBody);
    if (new RegExp(`/agencies/${AGENCY}/me$`).test(url)) return json(agencyMe);
    if (url.endsWith('/me/legal-acceptances') && method === 'GET') {
      return scenario.failRead === true ? json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error.' } }, 500) : json(status(scenario.account));
    }
    if (url.endsWith('/me/legal-acceptances') && method === 'POST') {
      const body: unknown = JSON.parse(String(init?.body));
      posted.push(body);
      const parsed = AcceptLegalDocumentRequestSchema.safeParse(body);
      if (!parsed.success) return json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' } }, 400);
      if (scenario.failAccept === true) return json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error.' } }, 500);
      const { document } = parsed.data;
      const accepted = scenario.account.accepted[document];
      if (accepted === null || accepted < scenario.account.current[document]) scenario.account.accepted[document] = scenario.account.current[document];
      return json(status(scenario.account));
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls, posted };
};

const outdatedAccount = (): Account => ({
  current: { terms: '2026-03-01', privacy: '2026-05-01' },
  accepted: { terms: '2026-01-01', privacy: '2026-02-01' }
});

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface Probe { pathname: string; navigate: (to: string) => void }

function NavigationProbe({ probe }: { probe: Probe }) {
  probe.pathname = useLocation().pathname;
  probe.navigate = useNavigate();
  return null;
}

const renderApp = (impl: typeof fetch, entry: string) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: Probe = { pathname: '', navigate: () => undefined };
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <NavigationProbe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return probe;
};

const notice = (): HTMLElement => screen.getByRole('region', { name: 'Aviso sobre os documentos legais' });
const queryNotice = (): HTMLElement | null => screen.queryByRole('region', { name: 'Aviso sobre os documentos legais' });

describe('legal notice in the agency shell (issue #81)', () => {
  it('announces each outdated document on its own, with a link to its text and its own accept button', async () => {
    const { impl } = makeFetch({ account: outdatedAccount() });
    renderApp(impl, `/agencia/${AGENCY}`);

    const region = await screen.findByRole('region', { name: 'Aviso sobre os documentos legais' });
    expect(within(region).getByText('Atualizamos os Termos de Uso.')).toBeTruthy();
    expect(within(region).getByText('Atualizamos a Política de Privacidade.')).toBeTruthy();
    const termsLink = within(region).getByRole('link', { name: 'Ler os Termos de Uso' });
    const privacyLink = within(region).getByRole('link', { name: 'Ler a Política de Privacidade' });
    expect(termsLink.getAttribute('href')).toBe('/termos');
    expect(privacyLink.getAttribute('href')).toBe('/privacidade');
    expect(termsLink.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(region).getAllByRole('button', { name: /^Li e aceito/ })).toHaveLength(2);
  });

  it('announces only the document that changed', async () => {
    const account = outdatedAccount();
    account.accepted.terms = account.current.terms;
    const { impl } = makeFetch({ account });
    renderApp(impl, `/agencia/${AGENCY}`);

    const region = await screen.findByRole('region', { name: 'Aviso sobre os documentos legais' });
    expect(within(region).queryByText('Atualizamos os Termos de Uso.')).toBeNull();
    expect(within(region).getByText('Atualizamos a Política de Privacidade.')).toBeTruthy();
    expect(within(region).getAllByRole('button', { name: /^Li e aceito/ })).toHaveLength(1);
  });

  it('shows nothing to an account that already accepted the versions in force', async () => {
    const account = outdatedAccount();
    account.accepted = { ...account.current };
    const { impl, calls } = makeFetch({ account });
    renderApp(impl, `/agencia/${AGENCY}`);

    await screen.findByRole('heading', { name: 'Agência Um' });
    await waitFor(() => expect(calls).toContain('GET /me/legal-acceptances'));
    expect(queryNotice()).toBeNull();
  });

  it('accepting one document sends only that document, and the other one stays announced', async () => {
    const account = outdatedAccount();
    const { impl, posted } = makeFetch({ account });
    renderApp(impl, `/agencia/${AGENCY}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Li e aceito a Política de Privacidade' }));

    await waitFor(() => expect(within(notice()).queryByText('Atualizamos a Política de Privacidade.')).toBeNull());
    expect(posted).toEqual([{ document: 'privacy' }]);
    expect(within(notice()).getByText('Atualizamos os Termos de Uso.')).toBeTruthy();
    expect(account.accepted).toEqual({ terms: '2026-01-01', privacy: '2026-05-01' });
  });

  it('accepting the last pending document removes the notice', async () => {
    const account = outdatedAccount();
    account.accepted.privacy = account.current.privacy;
    const { impl, posted } = makeFetch({ account });
    renderApp(impl, `/agencia/${AGENCY}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Li e aceito os Termos de Uso' }));

    await waitFor(() => expect(queryNotice()).toBeNull());
    expect(posted).toEqual([{ document: 'terms' }]);
    expect(account.accepted.terms).toBe('2026-03-01');
  });

  it('closing the notice hides it without accepting anything, and it stays hidden while the session lasts', async () => {
    const account = outdatedAccount();
    const { impl, posted } = makeFetch({ account });
    const probe = renderApp(impl, `/agencia/${AGENCY}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Fechar o aviso' }));

    await waitFor(() => expect(queryNotice()).toBeNull());
    expect(posted).toEqual([]);
    expect(account.accepted).toEqual({ terms: '2026-01-01', privacy: '2026-02-01' });
    await act(async () => { probe.navigate(`/portal/${CLIENT}`); });
    await screen.findByRole('heading', { name: 'Portal do cliente' });
    expect(queryNotice()).toBeNull();
  });

  it('keeps the screen working when the status cannot be read, without a notice or an error banner', async () => {
    const { impl } = makeFetch({ account: outdatedAccount(), failRead: true });
    renderApp(impl, `/agencia/${AGENCY}`);

    await screen.findByRole('heading', { name: 'Agência Um' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(queryNotice()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the notice and says so when recording the acceptance fails, then succeeds on retry', async () => {
    const scenario: Scenario = { account: outdatedAccount(), failAccept: true };
    const { impl } = makeFetch(scenario);
    renderApp(impl, `/agencia/${AGENCY}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Li e aceito os Termos de Uso' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível registrar o aceite. Tente de novo.');
    expect(within(notice()).getByText('Atualizamos os Termos de Uso.')).toBeTruthy();
    expect(scenario.account.accepted.terms).toBe('2026-01-01');

    scenario.failAccept = false;
    fireEvent.click(screen.getByRole('button', { name: 'Li e aceito os Termos de Uso' }));
    await waitFor(() => expect(within(notice()).queryByText('Atualizamos os Termos de Uso.')).toBeNull());
    expect(scenario.account.accepted.terms).toBe('2026-03-01');
  });
});

describe('legal notice in the portal (issue #81)', () => {
  it('shows the same notice on the client portal', async () => {
    const { impl } = makeFetch({ account: outdatedAccount() });
    renderApp(impl, `/portal/${CLIENT}`);

    await screen.findByRole('heading', { name: 'Portal do cliente' });
    const region = await screen.findByRole('region', { name: 'Aviso sobre os documentos legais' });
    expect(within(region).getByText('Atualizamos os Termos de Uso.')).toBeTruthy();
  });

  it('is not part of the context picker, which is neither the agency shell nor the portal', async () => {
    const { impl, calls } = makeFetch({ account: outdatedAccount() });
    const probe = renderApp(impl, '/contextos');

    await waitFor(() => expect(probe.pathname).toBe('/contextos'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).not.toContain('GET /me/legal-acceptances');
    expect(queryNotice()).toBeNull();
  });
});
