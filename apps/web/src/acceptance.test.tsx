// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

afterEach(cleanup);

const USER_ID = '11111111-1111-4111-8111-111111111111';
const AGENCY_A = '22222222-2222-4222-8222-222222222222';
const agencyA = { type: 'agency', agencyId: AGENCY_A, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: true };
const agencyMe = { agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: true, membershipId: null, role: { key: 'admin', name: 'Admin' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions: ['colaborador.visualizar', 'cliente.visualizar'] };
const sessionBody = { user: { id: USER_ID, name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const apiError = (status: number, code: string): Response => json({ error: { code, message: code } }, status);

type Document = 'terms' | 'privacy';

interface Scenario {
  /** Documents the account has not accepted yet; an account with none left is the one that is not blocked. */
  readonly pending: readonly Document[];
  /** Fails the next POST of a document with this answer, once. */
  readonly failOnce?: Partial<Record<Document, Response>>;
  /** Holds the POST of a document until released. */
  readonly hold?: Partial<Record<Document, Promise<void>>>;
  /** Answers the read of the status; the default is the account state. */
  readonly read?: () => Response | undefined;
}

/**
 * The account state lives here and the answers are computed from it, the way the API does: a POST records one document and
 * answers the whole status, `required` is true while any document is still pending, and a route of a session needs the session.
 */
const makeFetch = (scenario: Scenario) => {
  const pending = new Set<Document>(scenario.pending);
  const failures = { ...scenario.failOnce };
  const posts: Document[] = [];
  const counts = { read: 0, resolve: 0 };
  const status = () => ({
    required: pending.size > 0,
    documents: (['terms', 'privacy'] as const).map((document) => ({
      document,
      currentVersion: '2026-01-01',
      acceptedVersion: pending.has(document) ? null : '2026-01-01',
      pending: pending.has(document)
    }))
  });
  const impl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    if (path === '/auth/session') return json(sessionBody);
    if (path === '/me/legal-acceptances' && method === 'GET') {
      counts.read += 1;
      return scenario.read?.() ?? json(status());
    }
    if (path === '/me/legal-acceptances' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { document?: unknown };
      if (body.document !== 'terms' && body.document !== 'privacy') return apiError(400, 'VALIDATION_ERROR');
      const document: Document = body.document;
      posts.push(document);
      await scenario.hold?.[document];
      const failure = failures[document];
      if (failure !== undefined) { delete failures[document]; return failure; }
      pending.delete(document);
      return json(status());
    }
    // The API gives no context to an account that is still blocked.
    if (path === '/me/contexts/resolve') {
      counts.resolve += 1;
      return json(pending.size > 0 ? { decision: 'none' } : { decision: 'enter', context: agencyA });
    }
    if (path === '/me/last-context' && method === 'PUT') return new Response(null, { status: 204 });
    if (path === `/agencies/${AGENCY_A}/me`) return json(agencyMe);
    return apiError(404, 'NOT_FOUND');
  };
  return { impl, posts, counts };
};

function SessionHarness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface Probe { pathname: string }

function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location) => { probe.pathname = location.pathname; });
  return null;
}

const renderApp = (impl: typeof fetch, entry: string) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client, { onSessionStarted: () => queryClient.clear() });
  const probe: Probe = { pathname: '' };
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
  return { probe };
};

const settle = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });

const checkbox = (): HTMLInputElement => screen.getByRole('checkbox') as HTMLInputElement;
/** The sentence of the box as it reads, links included: the text is split across elements. */
const consent = (): string | null | undefined => checkbox().closest('label')?.textContent;
const continueButton = ():HTMLButtonElement => screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement;

describe('the block before the first use (issue #713)', () => {
  it.each(['/contextos', '/comecar'])('sends an account that has not accepted to /aceite from %s, without drawing the screen it left', async (entry) => {
    const { impl } = makeFetch({ pending: ['terms', 'privacy'] });
    const { probe } = renderApp(impl, entry);

    expect(await screen.findByRole('heading', { name: 'Antes de começar' })).toBeTruthy();
    expect(probe.pathname).toBe('/aceite');
    expect(screen.queryByRole('heading', { name: 'Onde você quer entrar?' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Sua conta está pronta' })).toBeNull();
  });

  it('lets an account that accepted through to the screen it asked for', async () => {
    const { impl } = makeFetch({ pending: [] });
    const { probe } = renderApp(impl, '/comecar');

    expect(await screen.findByRole('heading', { name: 'Sua conta está pronta' })).toBeTruthy();
    expect(probe.pathname).toBe('/comecar');
  });

  it('opens the screen when the status cannot be read, since the API refuses what needs the acceptance', async () => {
    const { impl } = makeFetch({ pending: [], read: () => apiError(403, 'FORBIDDEN') });
    const { probe } = renderApp(impl, '/comecar');

    expect(await screen.findByRole('heading', { name: 'Sua conta está pronta' })).toBeTruthy();
    expect(probe.pathname).toBe('/comecar');
  });
});

describe('/aceite (issue #713)', () => {
  it('explains the block and asks for one acceptance of both documents, with links that open apart', async () => {
    const { impl } = makeFetch({ pending: ['terms', 'privacy'] });
    renderApp(impl, '/aceite');

    expect(await screen.findByRole('heading', { name: 'Antes de começar' })).toBeTruthy();
    expect(screen.getByText('Para usar o Ageniza, leia e aceite os documentos abaixo. Sem o aceite, a sua conta fica sem acesso.')).toBeTruthy();
    expect(consent()).toBe('Li e aceito os Termos de Uso e a Política de Privacidade');
    for (const [name, href] of [['Termos de Uso', '/termos'], ['Política de Privacidade', '/privacidade']] as const) {
      const link = screen.getByRole('link', { name });
      expect(link.getAttribute('href')).toBe(href);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
    // The way out stays in the account menu, so a person who does not want to accept can leave.
    fireEvent.click(await screen.findByRole('button', { name: /Pessoa/ }));
    expect(await screen.findByRole('menuitem', { name: 'Sair' })).toBeTruthy();
  });

  it('keeps "Continuar" off until the box is checked, and a submit without it sends nothing', async () => {
    const { impl, posts } = makeFetch({ pending: ['terms', 'privacy'] });
    renderApp(impl, '/aceite');
    await screen.findByRole('heading', { name: 'Antes de começar' });

    expect(checkbox().checked).toBe(false);
    expect(continueButton().disabled).toBe(true);
    fireEvent.submit(continueButton().closest('form') as HTMLFormElement);
    await settle();
    expect(posts).toEqual([]);

    fireEvent.click(checkbox());
    expect(continueButton().disabled).toBe(false);
    fireEvent.click(checkbox());
    expect(continueButton().disabled).toBe(true);
  });

  it('records the Terms and then the Privacy Policy, one request each, and goes on through the sign-in screen', async () => {
    const { impl, posts } = makeFetch({ pending: ['terms', 'privacy'] });
    const { probe } = renderApp(impl, '/aceite');
    await screen.findByRole('heading', { name: 'Antes de começar' });

    fireEvent.click(checkbox());
    fireEvent.click(continueButton());

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(posts).toEqual(['terms', 'privacy']);
  });

  it('asks only for what is pending: a single document, named alone, and a single request', async () => {
    const { impl, posts } = makeFetch({ pending: ['privacy'] });
    const { probe } = renderApp(impl, '/aceite');

    await screen.findByRole('checkbox');
    expect(consent()).toBe('Li e aceito a Política de Privacidade');
    expect(screen.queryByRole('link', { name: 'Termos de Uso' })).toBeNull();
    fireEvent.click(checkbox());
    fireEvent.click(continueButton());

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(posts).toEqual(['privacy']);
  });

  it('keeps the first acceptance when the second fails, says so, and the retry sends only what is left', async () => {
    const { impl, posts } = makeFetch({ pending: ['terms', 'privacy'], failOnce: { privacy: apiError(500, 'INTERNAL_ERROR') } });
    const { probe } = renderApp(impl, '/aceite');
    await screen.findByRole('heading', { name: 'Antes de começar' });
    fireEvent.click(checkbox());
    fireEvent.click(continueButton());

    expect((await screen.findByRole('alert')).textContent).toBe('Não foi possível registrar o aceite. Tente de novo.');
    expect(posts).toEqual(['terms', 'privacy']);
    expect(probe.pathname).toBe('/aceite');
    // What the server recorded is what the screen asks for now.
    await waitFor(() => expect(consent()).toBe('Li e aceito a Política de Privacidade'));
    expect(screen.queryByRole('link', { name: 'Termos de Uso' })).toBeNull();

    fireEvent.click(continueButton());

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(posts).toEqual(['terms', 'privacy', 'privacy']);
  });

  it('says to try later on the rate limit and stays on the screen', async () => {
    const { impl } = makeFetch({ pending: ['terms', 'privacy'], failOnce: { terms: apiError(429, 'RATE_LIMITED') } });
    const { probe } = renderApp(impl, '/aceite');
    await screen.findByRole('heading', { name: 'Antes de começar' });
    fireEvent.click(checkbox());
    fireEvent.click(continueButton());

    expect((await screen.findByRole('alert')).textContent).toBe('Muitas tentativas. Tente novamente mais tarde.');
    expect(probe.pathname).toBe('/aceite');
  });

  it('sends one request for a double click of "Continuar", even when both land in the same task', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { impl, posts } = makeFetch({ pending: ['terms'], hold: { terms: hold } });
    renderApp(impl, '/aceite');
    await screen.findByRole('heading', { name: 'Antes de começar' });
    fireEvent.click(checkbox());

    const form = continueButton().closest('form') as HTMLFormElement;
    // One act: no render between the two, so the state of the first submit is not visible to the second.
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    release();

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Antes de começar' })).toBeNull());
    expect(posts).toEqual(['terms']);
  });

  it('says so when the documents cannot be read, and reads again on "Tentar de novo"', async () => {
    let failing = true;
    const { impl, counts } = makeFetch({ pending: ['terms', 'privacy'], read: () => (failing ? apiError(403, 'FORBIDDEN') : undefined) });
    renderApp(impl, '/aceite');

    expect(await screen.findByText('Não foi possível carregar os documentos. Tente de novo.')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByRole('checkbox')).toBeTruthy();
    expect(counts.read).toBeGreaterThanOrEqual(2);
  });

  it('has nothing to ask of an account that accepted: it goes on through the sign-in screen', async () => {
    const { impl, posts } = makeFetch({ pending: [] });
    const { probe } = renderApp(impl, '/aceite');

    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}`));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(posts).toEqual([]);
  });
});
