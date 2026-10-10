// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { portalClientBody, portalStudyBody } from './portal-fixture.js';
import { PortalTour } from './portal-tour.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

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

const AGENCY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const SECOND_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const SEEN_AT = '2026-10-01T12:00:00.000Z';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sessionBody = { user: { id: USER_ID, name: 'Maria', email: 'maria@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const legalAccepted = {
  documents: [
    { document: 'terms', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false },
    { document: 'privacy', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false }
  ]
};

interface Scenario {
  /** Clients whose tour this person has already seen, by link. */
  readonly seen?: readonly string[];
  /** The person is also a collaborator of the agency of these clients (the "pessoa dupla"). */
  readonly alsoCollaborator?: boolean;
  /** Answers the onboarding POST instead of the real API's 204; consulted per request, in order. */
  readonly seenAnswer?: () => Response | Promise<Response>;
  /** What the logout answers; the real API answers 204, and 401 when the session was already gone. */
  readonly logoutStatus?: 204 | 401;
}

interface Person { readonly id: string; readonly name: string; readonly email: string }
const MARIA: Person = { id: USER_ID, name: 'Maria', email: 'maria@example.test' };
const ANA: Person = { id: '88888888-8888-4888-8888-888888888888', name: 'Ana', email: 'ana@example.test' };

/**
 * The server remembers the seen mark per link, like `client_memberships.onboarding_seen_at`: only a
 * successful POST records it, and every later read of the client carries it.
 */
const makeWorld = (scenario: Scenario = {}) => {
  const names: Record<string, string> = { [CLIENT_ID]: 'Padaria Central', [SECOND_ID]: 'Confeitaria Dois' };
  let person: Person = MARIA;
  let seenAt: Record<string, string | null> = {
    [CLIENT_ID]: scenario.seen?.includes(CLIENT_ID) === true ? SEEN_AT : null,
    [SECOND_ID]: scenario.seen?.includes(SECOND_ID) === true ? SEEN_AT : null
  };
  const calls: string[] = [];

  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}`);
    if (path.endsWith('/auth/session')) return json({ user: person, session: sessionBody.session });
    if (path.endsWith('/auth/logout') && method === 'POST') {
      return scenario.logoutStatus === 401
        ? json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } }, 401)
        : new Response(null, { status: 204 });
    }
    if (path.endsWith('/me/legal-acceptances')) return json(legalAccepted);
    if (path.endsWith('/me/contexts')) {
      return json({
        contexts: [
          ...Object.entries(names).map(([clientId, clientName]) => ({ type: 'client', clientId, clientName, agencyId: AGENCY_ID, agencyName: 'Agência Um', onboardingPending: seenAt[clientId] === null })),
          ...(scenario.alsoCollaborator === true ? [{ type: 'agency', agencyId: AGENCY_ID, agencyName: 'Agência Um', roleKey: 'admin', roleName: 'Admin', isOwner: false }] : [])
        ]
      });
    }
    for (const clientId of Object.keys(names)) {
      if (path === `/clients/${clientId}` && method === 'GET') return json(portalClientBody(clientId, names[clientId]!, seenAt[clientId]!));
      if (path === `/clients/${clientId}/brand-study`) return json(portalStudyBody());
      if (path === `/clients/${clientId}/onboarding/seen` && method === 'POST') {
        const answer = await scenario.seenAnswer?.();
        if (answer !== undefined && !answer.ok) return answer;
        seenAt[clientId] ??= new Date().toISOString();
        return new Response(null, { status: 204 });
      }
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const posts = (): string[] => calls.filter((call) => call.startsWith('POST /clients/'));
  /** Another person takes over the browser: the server remembers the mark per person and link. */
  const signInAs = (next: Person): void => {
    person = next;
    seenAt = { [CLIENT_ID]: null, [SECOND_ID]: null };
  };
  return { impl, calls, posts, get seenAt() { return seenAt; }, signInAs };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface ProbeTarget { pathname: string; navigate: NavigateFunction }

function Probe({ probe }: { probe: ProbeTarget }) {
  const location = useLocation();
  probe.pathname = location.pathname;
  probe.navigate = useNavigate();
  return null;
}

const portalUrl = (slug = 'inicio', clientId = CLIENT_ID) => `/portal/${clientId}/${slug}`;

const renderPortal = (impl: typeof fetch, entry = portalUrl()) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const store = createAuthSessionStore(client);
  const probe: ProbeTarget = { pathname: '', navigate: () => undefined };
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <Probe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { probe, store, unmount: rendered.unmount };
};

const nav = () => screen.getByRole('navigation', { name: 'Navegação do portal' });
const tour = (name: string) => screen.findByRole('dialog', { name });
const queryTour = () => screen.queryByRole('dialog');
const WELCOME = 'Boas-vindas, Maria!';
const targetsOf = (): string[] =>
  within(nav()).getAllByRole('link').filter((link) => link.getAttribute('data-tour-target') === 'true').map((link) => link.textContent ?? '');
const click = (name: string): void => { fireEvent.click(screen.getByRole('button', { name })); };

const openReview = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: /Maria/ }));
  const menu = await screen.findByRole('menu');
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rever o tour' }));
};

const RECORD_FAILURES: ReadonlyArray<readonly [string, () => Response]> = [
  ['a server error', () => json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error.' } }, 500)],
  ['a link that no longer exists', () => json({ error: { code: 'NOT_FOUND', message: 'Client not found.' } }, 404)],
  ['an invalid request', () => json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid.' } }, 400)],
  ['a rejected origin', () => json({ error: { code: 'CSRF_REJECTED', message: 'Request origin is not allowed' } }, 403)],
  ['a network failure', (): Response => { throw new TypeError('network down'); }]
];

describe('portal tour (#144)', () => {
  it('opens on the first entry, welcoming the person by name and naming the client and the agency', async () => {
    const world = makeWorld();
    renderPortal(world.impl);

    const dialog = await tour(WELCOME);
    expect(within(dialog).getByRole('heading', { name: WELCOME })).toBeTruthy();
    expect(within(dialog).getByText('Este é o espaço de Padaria Central com Agência Um.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Pular' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Começar' })).toBeTruthy();
    expect(targetsOf()).toEqual([]);
    expect(world.posts()).toEqual([]);
  });

  it('does not open for a link that already saw it', async () => {
    const world = makeWorld({ seen: [CLIENT_ID] });
    renderPortal(world.impl);

    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(queryTour()).toBeNull();
    expect(world.posts()).toEqual([]);
  });

  it('walks Início, Marca and how to suggest, pointing at the right navigation item, and Concluir records it once', async () => {
    const world = makeWorld();
    renderPortal(world.impl);
    await tour(WELCOME);

    click('Começar');
    let dialog = await tour('Início');
    expect(within(dialog).getByText('Aqui você vê a próxima coisa a fazer, sempre uma só.')).toBeTruthy();
    expect(within(dialog).getByText('passo 1 de 3')).toBeTruthy();
    expect(targetsOf()).toEqual(['Início']);
    expect(within(dialog).queryByRole('button', { name: 'Voltar' })).toBeNull();

    click('Próximo');
    dialog = await tour('Sua marca');
    expect(within(dialog).getByText('Aqui fica o estudo da sua marca, do jeito que a agência entende o seu negócio.')).toBeTruthy();
    expect(within(dialog).getByText('passo 2 de 3')).toBeTruthy();
    expect(targetsOf()).toEqual(['Marca']);

    click('Próximo');
    dialog = await tour('Como sugerir');
    expect(within(dialog).getByText('Se quiser mudar algo, abra a Marca e toque em Sugerir ao lado da parte que você quer ajustar.')).toBeTruthy();
    expect(within(dialog).getByText('passo 3 de 3')).toBeTruthy();
    expect(targetsOf()).toEqual(['Marca']);
    expect(within(dialog).queryByRole('button', { name: 'Próximo' })).toBeNull();

    click('Voltar');
    await tour('Sua marca');
    expect(world.posts()).toEqual([]);
    click('Próximo');
    await tour('Como sugerir');

    click('Concluir');
    await waitFor(() => { expect(queryTour()).toBeNull(); });
    await waitFor(() => { expect(world.posts()).toEqual([`POST /clients/${CLIENT_ID}/onboarding/seen`]); });
    expect(targetsOf()).toEqual([]);
  });

  it('never points at, or talks about, Calendário or Relatórios in any step', async () => {
    const world = makeWorld();
    renderPortal(world.impl);
    const seenTexts: string[] = [];
    seenTexts.push((await tour(WELCOME)).textContent ?? '');
    click('Começar');
    for (const title of ['Início', 'Sua marca', 'Como sugerir']) {
      seenTexts.push((await tour(title)).textContent ?? '');
      expect(targetsOf()).not.toContain('Calendário');
      expect(targetsOf()).not.toContain('Relatórios');
      if (title !== 'Como sugerir') click('Próximo');
    }
    expect(seenTexts).toHaveLength(4);
    for (const text of seenTexts) expect(text).not.toMatch(/Calendário|Relatórios/);
  });

  it('records the mark on Pular, and the tour does not come back by navigating nor on the next entry', async () => {
    const world = makeWorld();
    const first = renderPortal(world.impl);
    await tour(WELCOME);

    click('Pular');
    await waitFor(() => { expect(queryTour()).toBeNull(); });
    await waitFor(() => { expect(world.posts()).toEqual([`POST /clients/${CLIENT_ID}/onboarding/seen`]); });

    fireEvent.click(within(nav()).getByRole('link', { name: 'Marca' }));
    expect(await screen.findByRole('heading', { name: 'Sua marca' })).toBeTruthy();
    fireEvent.click(within(nav()).getByRole('link', { name: 'Início' }));
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(queryTour()).toBeNull();

    first.unmount();
    renderPortal(world.impl);
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(queryTour()).toBeNull();
    expect(world.posts()).toHaveLength(1);
  });

  it('does not flash the tour from the cached client when the portal is entered again after the mark was recorded', async () => {
    const world = makeWorld();
    const { probe } = renderPortal(world.impl);
    await tour(WELCOME);
    click('Pular');
    await waitFor(() => { expect(world.posts()).toHaveLength(1); });
    await waitFor(() => { expect(queryTour()).toBeNull(); });

    act(() => { probe.navigate('/uma-pagina-que-nao-existe'); });
    await waitFor(() => { expect(screen.queryByRole('navigation', { name: 'Navegação do portal' })).toBeNull(); });
    act(() => { probe.navigate(portalUrl()); });
    expect(queryTour()).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(queryTour()).toBeNull();
  });

  it('closes on Esc as a Pular, recording the mark', async () => {
    const world = makeWorld();
    renderPortal(world.impl);
    const dialog = await tour(WELCOME);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => { expect(queryTour()).toBeNull(); });
    await waitFor(() => { expect(world.posts()).toEqual([`POST /clients/${CLIENT_ID}/onboarding/seen`]); });
  });

  it('puts focus on the primary action, keeps it inside the card with Tab and Shift+Tab, and moves it with the steps', async () => {
    const world = makeWorld();
    renderPortal(world.impl);
    const dialog = await tour(WELCOME);

    const start = within(dialog).getByRole('button', { name: 'Começar' });
    const skip = within(dialog).getByRole('button', { name: 'Pular' });
    expect(document.activeElement).toBe(start);
    fireEvent.keyDown(start, { key: 'Tab' });
    expect(document.activeElement).toBe(skip);
    skip.focus();
    fireEvent.keyDown(skip, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(start);

    fireEvent.click(start);
    const next = await within(await tour('Início')).findByRole('button', { name: 'Próximo' });
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    const second = await tour('Sua marca');
    const back = within(second).getByRole('button', { name: 'Voltar' });
    const secondNext = within(second).getByRole('button', { name: 'Próximo' });
    expect(document.activeElement).toBe(secondNext);
    fireEvent.keyDown(secondNext, { key: 'Tab' });
    expect(document.activeElement).toBe(within(second).getByRole('button', { name: 'Pular' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(secondNext);
    expect(back.isConnected).toBe(true);
  });

  it('reviews from the account menu without calling anything, whichever way it is closed', async () => {
    const world = makeWorld({ seen: [CLIENT_ID] });
    renderPortal(world.impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    const before = world.calls.length;

    await openReview();
    await tour(WELCOME);
    click('Pular');
    await waitFor(() => { expect(queryTour()).toBeNull(); });

    await openReview();
    await tour(WELCOME);
    click('Começar');
    await tour('Início');
    click('Próximo');
    await tour('Sua marca');
    click('Próximo');
    await tour('Como sugerir');
    click('Concluir');
    await waitFor(() => { expect(queryTour()).toBeNull(); });

    await openReview();
    fireEvent.keyDown(await tour(WELCOME), { key: 'Escape' });
    await waitFor(() => { expect(queryTour()).toBeNull(); });

    expect(world.posts()).toEqual([]);
    expect(world.calls.slice(before).filter((call) => call.startsWith('POST') || call.startsWith('PUT') || call.startsWith('PATCH'))).toEqual([]);
  });

  it('keeps a review to the client it was asked in, and hands focus back to the account menu when it closes', async () => {
    const world = makeWorld({ seen: [CLIENT_ID, SECOND_ID], alsoCollaborator: true });
    const { probe } = renderPortal(world.impl);
    await screen.findByRole('heading', { name: 'Olá, Maria' });

    await openReview();
    await tour(WELCOME);
    act(() => { probe.navigate(portalUrl('inicio', SECOND_ID)); });
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(queryTour()).toBeNull();

    act(() => { probe.navigate(portalUrl('inicio', CLIENT_ID)); });
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    const trigger = screen.getByRole('button', { name: /Maria/ });
    await openReview();
    fireEvent.keyDown(await tour(WELCOME), { key: 'Escape' });
    await waitFor(() => { expect(queryTour()).toBeNull(); });
    expect(document.activeElement).toBe(trigger);
    expect(world.posts()).toEqual([]);
  });

  it('offers the review only while no tour is open', async () => {
    const world = makeWorld();
    renderPortal(world.impl);
    await tour(WELCOME);

    fireEvent.click(screen.getByRole('button', { name: /Maria/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Rever o tour' })).toBeNull();
  });

  it('shows the tour in each client the first time, and seeing it in one does not mark the other', async () => {
    const world = makeWorld({ alsoCollaborator: true });
    const { probe } = renderPortal(world.impl);
    await tour(WELCOME);

    click('Pular');
    await waitFor(() => { expect(world.posts()).toEqual([`POST /clients/${CLIENT_ID}/onboarding/seen`]); });
    expect(world.seenAt[CLIENT_ID]).not.toBeNull();
    expect(world.seenAt[SECOND_ID]).toBeNull();

    act(() => { probe.navigate(portalUrl('inicio', SECOND_ID)); });
    const dialog = await tour(WELCOME);
    expect(within(dialog).getByText('Este é o espaço de Confeitaria Dois com Agência Um.')).toBeTruthy();

    act(() => { probe.navigate(portalUrl('inicio', CLIENT_ID)); });
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(queryTour()).toBeNull();

    act(() => { probe.navigate(portalUrl('inicio', SECOND_ID)); });
    click('Pular');
    await waitFor(() => { expect(world.posts()).toEqual([`POST /clients/${CLIENT_ID}/onboarding/seen`, `POST /clients/${SECOND_ID}/onboarding/seen`]); });
    expect(world.seenAt[SECOND_ID]).not.toBeNull();
  });

  it('a person who is also a collaborator sees the tour as the client and the agency menu keeps working', async () => {
    const world = makeWorld({ alsoCollaborator: true });
    renderPortal(world.impl);
    await tour(WELCOME);
    click('Começar');
    await tour('Início');

    fireEvent.click(screen.getByRole('button', { name: /Maria/ }));
    const menu = await screen.findByRole('menu');
    expect(await within(menu).findByRole('menuitem', { name: /Trocar de contexto/ })).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Rever o tour' })).toBeNull();
  });

  it.each(RECORD_FAILURES)('closes the tour and leaves the portal usable when recording the mark fails with %s, and brings the tour back on the next entry', async (_label, answer) => {
    const world = makeWorld({ seenAnswer: answer });
    const first = renderPortal(world.impl);
    await tour(WELCOME);

    click('Pular');
    await waitFor(() => { expect(queryTour()).toBeNull(); });
    await waitFor(() => { expect(world.posts()).toHaveLength(1); });

    fireEvent.click(within(nav()).getByRole('link', { name: 'Marca' }));
    expect(await screen.findByRole('heading', { name: 'Sua marca' })).toBeTruthy();
    fireEvent.click(within(nav()).getByRole('link', { name: 'Início' }));
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(queryTour()).toBeNull();
    expect(world.posts()).toHaveLength(1);
    expect(world.seenAt[CLIENT_ID]).toBeNull();

    first.unmount();
    renderPortal(world.impl);
    await tour(WELCOME);
  });

  it('a review after a failed record does not try to record again', async () => {
    const world = makeWorld({ seenAnswer: () => json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error.' } }, 500) });
    renderPortal(world.impl);
    await tour(WELCOME);
    click('Pular');
    await waitFor(() => { expect(world.posts()).toHaveLength(1); });

    await openReview();
    await tour(WELCOME);
    click('Pular');
    await waitFor(() => { expect(queryTour()).toBeNull(); });
    expect(world.posts()).toHaveLength(1);
  });

  it('sends the person to the login when the record answers 401, like any other request', async () => {
    const world = makeWorld({ seenAnswer: () => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } }, 401) });
    const { probe } = renderPortal(world.impl);
    await tour(WELCOME);

    click('Pular');
    await waitFor(() => { expect(probe.pathname).toBe('/entrar'); });
  });

  it('sends one record per closing, even while the answer is still on its way, and a later Esc after leaving sends nothing', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const world = makeWorld({ seenAnswer: async () => { await held; return new Response(null, { status: 204 }); } });
    const { unmount } = renderPortal(world.impl);
    const dialog = await tour(WELCOME);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Pular' }));
    await waitFor(() => { expect(queryTour()).toBeNull(); });
    expect(world.posts()).toEqual([`POST /clients/${CLIENT_ID}/onboarding/seen`]);

    unmount();
    expect(fireEvent.keyDown(document.body, { key: 'Escape' })).toBe(true);
    release();
    await act(async () => { await Promise.resolve(); });
    expect(world.posts()).toHaveLength(1);
  });

  it('closes once however many times the card is told to close while it stays mounted', () => {
    const onClose = vi.fn();
    render(<PortalTour personName="Maria" clientName="Padaria Central" agencyName="Agência Um" onClose={onClose} onTargetChange={() => undefined} />);
    const skip = screen.getByRole('button', { name: 'Pular' });

    fireEvent.click(skip);
    fireEvent.click(skip);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('closes on Esc wherever the focus is, after a click outside the card', async () => {
    const world = makeWorld();
    renderPortal(world.impl);
    await tour(WELCOME);

    const link = within(nav()).getByRole('link', { name: 'Marca' });
    link.focus();
    fireEvent.keyDown(link, { key: 'Escape' });

    await waitFor(() => { expect(queryTour()).toBeNull(); });
    await waitFor(() => { expect(world.posts()).toEqual([`POST /clients/${CLIENT_ID}/onboarding/seen`]); });
  });

  it('closes on an Esc heard on the page itself, with no card focus needed', () => {
    const onClose = vi.fn();
    render(<PortalTour personName="Maria" clientName="Padaria Central" agencyName="Agência Um" onClose={onClose} onTargetChange={() => undefined} />);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('leaves Esc to a native dialog open over the tour, and stops listening once the tour is gone', () => {
    const onClose = vi.fn();
    const { unmount } = render(<>
      <PortalTour personName="Maria" clientName="Padaria Central" agencyName="Agência Um" onClose={onClose} onTargetChange={() => undefined} />
      <dialog open><button type="button">Enviar</button></dialog>
    </>);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Enviar' }), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    unmount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('announces itself as a modal dialog to assistive technology', async () => {
    const world = makeWorld();
    renderPortal(world.impl);
    const dialog = await tour(WELCOME);

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    click('Começar');
    expect((await tour('Início')).getAttribute('aria-modal')).toBe('true');
  });

  it('keeps Esc to itself: a handler of the page around the tour never hears it', () => {
    const outside = vi.fn();
    const onClose = vi.fn();
    render(<div onKeyDown={outside}>
      <PortalTour personName="Maria" clientName="Padaria Central" agencyName="Agência Um" onClose={onClose} onTargetChange={() => undefined} />
    </div>);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledExactlyOnceWith(false);
    expect(outside).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'a' });
    expect(outside).toHaveBeenCalledOnce();
  });

  it('starts the welcome card again when the portal switches to another client with the tour still open', async () => {
    const world = makeWorld({ alsoCollaborator: true });
    const { probe } = renderPortal(world.impl, portalUrl('inicio', SECOND_ID));
    expect(within(await tour(WELCOME)).getByText('Este é o espaço de Confeitaria Dois com Agência Um.')).toBeTruthy();

    // The first client is not loaded yet, so the tour of the second is gone while it loads; the second is cached by now.
    act(() => { probe.navigate(portalUrl('inicio', CLIENT_ID)); });
    expect(within(await tour(WELCOME)).getByText('Este é o espaço de Padaria Central com Agência Um.')).toBeTruthy();
    click('Começar');
    await tour('Início');

    act(() => { probe.navigate(portalUrl('inicio', SECOND_ID)); });
    const dialog = await tour(WELCOME);
    expect(within(dialog).getByText('Este é o espaço de Confeitaria Dois com Agência Um.')).toBeTruthy();
    expect(dialog.getAttribute('data-step')).toBe('welcome');
    expect(world.posts()).toEqual([]);
  });

  it.each(RECORD_FAILURES)('handles the rejection of the record itself when it fails with %s', async (_label, answer) => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const world = makeWorld({ seenAnswer: answer });
      renderPortal(world.impl);
      await tour(WELCOME);

      click('Pular');
      await waitFor(() => { expect(world.posts()).toHaveLength(1); });
      await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('after a 403 CSRF_REJECTED the mark is not kept in the cache: leaving the portal and coming back brings the tour', async () => {
    const world = makeWorld({ seenAnswer: () => json({ error: { code: 'CSRF_REJECTED', message: 'Request origin is not allowed' } }, 403) });
    const { probe } = renderPortal(world.impl);
    await tour(WELCOME);
    click('Pular');
    await waitFor(() => { expect(world.posts()).toHaveLength(1); });
    await waitFor(() => { expect(queryTour()).toBeNull(); });

    act(() => { probe.navigate('/uma-pagina-que-nao-existe'); });
    await waitFor(() => { expect(screen.queryByRole('navigation', { name: 'Navegação do portal' })).toBeNull(); });
    // From the cache alone, before any new read of the client can answer.
    act(() => { probe.navigate(portalUrl()); });
    expect(screen.getByRole('dialog', { name: WELCOME })).toBeTruthy();
    expect(world.posts()).toHaveLength(1);
    expect(world.seenAt[CLIENT_ID]).toBeNull();
  });

  it('rests the card on the bar itself, with no height or width of its own to go stale', async () => {
    const world = makeWorld();
    renderPortal(world.impl);
    const dialog = await tour(WELCOME);
    expect(nav().contains(dialog)).toBe(true);

    const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');
    const rule = (selector: string): string => {
      const start = css.indexOf(`
${selector} {`);
      if (start === -1) throw new Error(`${selector} was not found in globals.css.`);
      return css.slice(start, css.indexOf('}', start));
    };
    expect(rule('.portal-tour')).toMatch(/position:\s*absolute;/);
    expect(rule('.portal-tour')).toMatch(/bottom:\s*100%;/);
    expect(rule('.portal-tour')).toMatch(/width:\s*min\(calc\(100% - 2 \* var\(--space-4\)\), 28rem\);/);
    expect(rule('.portal-tour')).not.toMatch(/max-width/);
    expect(rule('.portal-tour').replace(/width:\s*min\([^;]*;|border:[^;]*;/g, '')).not.toMatch(/\d(\.\d+)?(rem|px)/);
    expect(rule(".portal-tour[data-step='welcome']")).toMatch(/position:\s*fixed;/);
    expect(rule('.portal-nav')).toMatch(/position:\s*sticky;/);
  });

  it.each([
    ['logs out', 204],
    ['finds the session already gone while logging out', 401]
  ] as const)('shows the tour to a second person who arrives in the same browser after the first %s', async (_label, logoutStatus) => {
    const world = makeWorld({ logoutStatus });
    const { probe, store } = renderPortal(world.impl);
    await tour(WELCOME);
    click('Pular');
    await waitFor(() => { expect(world.seenAt[CLIENT_ID]).not.toBeNull(); });
    await waitFor(() => { expect(queryTour()).toBeNull(); });
    await waitFor(() => { expect(world.posts()).toHaveLength(1); });

    fireEvent.click(screen.getByRole('button', { name: /Maria/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Sair' }));
    await waitFor(() => { expect(probe.pathname).toBe('/entrar'); });

    world.signInAs(ANA);
    await act(async () => { await store.refresh(); });
    act(() => { probe.navigate(portalUrl()); });

    // Nothing of the first person's cache shows: the portal waits for its own answer.
    expect(screen.queryByRole('navigation', { name: 'Navegação do portal' })).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'Boas-vindas, Ana!' });
    expect(within(dialog).getByText('Este é o espaço de Padaria Central com Agência Um.')).toBeTruthy();
  });

  it('never paints the review of one client over another, not even for a render, and does not bring it back on return', async () => {
    const world = makeWorld({ seen: [CLIENT_ID, SECOND_ID] });
    const { probe } = renderPortal(world.impl, portalUrl('inicio', SECOND_ID));
    await screen.findByRole('heading', { name: 'Olá, Maria' });
    act(() => { probe.navigate(portalUrl('inicio', CLIENT_ID)); });
    await waitFor(() => { expect(screen.getByRole('heading', { name: 'Olá, Maria' })).toBeTruthy(); });
    await openReview();
    await tour(WELCOME);

    const observer = new MutationObserver(() => undefined);
    observer.observe(document.body, { childList: true, subtree: true });
    let painted: string[];
    try {
      // The second client is already in the cache, so it renders on the very first pass.
      act(() => { probe.navigate(portalUrl('inicio', SECOND_ID)); });
      painted = observer.takeRecords()
        .flatMap((record) => Array.from(record.addedNodes))
        .filter((node): node is Element => node instanceof Element && (node.getAttribute('role') === 'dialog' || node.querySelector('[role="dialog"]') !== null))
        .map((node) => node.textContent ?? '');
    } finally {
      observer.disconnect();
    }
    expect(painted).toEqual([]);
    expect(queryTour()).toBeNull();

    act(() => { probe.navigate(portalUrl('inicio', CLIENT_ID)); });
    expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
    expect(queryTour()).toBeNull();
    expect(world.posts()).toEqual([]);
  });

  it('closes only the account menu when Esc is pressed inside it, keeping the tour', async () => {
    const world = makeWorld();
    renderPortal(world.impl);
    await tour(WELCOME);
    fireEvent.click(screen.getByRole('button', { name: /Maria/ }));
    const item = within(await screen.findByRole('menu')).getAllByRole('menuitem')[0]!;
    item.focus();
    fireEvent.keyDown(item, { key: 'Escape' });

    await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
    expect(screen.queryByRole('dialog', { name: WELCOME })).not.toBeNull();
    expect(world.posts()).toEqual([]);
  });

  it('closes only the logout-all confirmation when Esc is pressed inside it, keeping the tour', async () => {
    const world = makeWorld();
    renderPortal(world.impl);
    await tour(WELCOME);
    fireEvent.click(screen.getByRole('button', { name: /Maria/ }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /todas as sessões/i }));
    const confirm = await screen.findByRole('dialog', { name: /todas as sessões/i });
    fireEvent.keyDown(within(confirm).getByRole('button', { name: 'Cancelar' }), { key: 'Escape' });

    await waitFor(() => { expect(screen.queryByRole('dialog', { name: /todas as sessões/i })).toBeNull(); });
    expect(screen.queryByRole('dialog', { name: WELCOME })).not.toBeNull();
    expect(world.posts()).toEqual([]);
  });
});
