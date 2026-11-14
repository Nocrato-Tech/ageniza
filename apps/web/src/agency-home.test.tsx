// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

/** The Início of the agency (scope redesign igual ao quadro, 4.B): header, no shortcuts, the module-less way out. */

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const OTHER_CLIENT = '44444444-4444-4444-8444-444444444444';
const sessionBody = { user: { id: '11111111-1111-4111-8111-111111111111', name: 'Marina Souza', email: 'marina@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const VIEW = ['cliente.visualizar', 'conteudo.visualizar'];
const ALL = [...VIEW, 'cliente.cadastrar', 'cliente.convidar_usuario', 'conteudo.operar', 'colaborador.visualizar'];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Facts { hasContent: boolean; sentForApproval: boolean; approvedByClient: boolean; published: boolean }

interface Scenario {
  readonly permissions: readonly string[];
  readonly clients?: number;
  readonly facts?: Facts;
  readonly readOnly?: boolean;
  readonly summary?: { awaitingClient: number; overdueAwaitingClient: number };
}

const none: Facts = { hasContent: false, sentForApproval: false, approvedByClient: false, published: false };
const done: Facts = { hasContent: true, sentForApproval: true, approvedByClient: true, published: false };

const makeFetch = (scenario: Scenario): typeof fetch => async (input) => {
  const url = String(input);
  if (url.endsWith('/auth/session')) return json(sessionBody);
  if (url.endsWith(`/agencies/${AGENCY}/me`)) {
    return json({
      agencyId: AGENCY, agencyName: 'Agência Um', isOwner: true, membershipId: null, role: { key: 'admin', name: 'Admin' },
      plan: { kind: 'isenta', trialEndsAt: null, readOnly: scenario.readOnly ?? false }, permissions: scenario.permissions
    });
  }
  if (url.includes(`/agencies/${AGENCY}/clients?`)) {
    const total = scenario.clients ?? 0;
    return json({
      data: total === 0 ? [] : [{ id: CLIENT, name: 'Padaria Central', photoUrl: null, instagramHandle: null, status: 'active', closingDate: null, threadsAwaitingAgency: 0 }],
      meta: { page: 1, pageSize: 1, totalItems: total, totalPages: total }
    });
  }
  if (url.endsWith(`/agencies/${AGENCY}/contents/activation`)) {
    const facts = scenario.facts ?? none;
    return json({ data: { ...facts, steps: { firstClient: null, firstContent: null, firstSent: null, firstApproved: null } } });
  }
  if (url.endsWith(`/agencies/${AGENCY}/contents/summary`)) {
    const { awaitingClient, overdueAwaitingClient } = scenario.summary ?? { awaitingClient: 0, overdueAwaitingClient: 0 };
    return json({ data: { awaitingClient, overdueAwaitingClient, approvedThisMonth: 0, approvedLastMonth: 0, scheduled: { count: 0, lastPublishOn: null } } });
  }
  if (url.endsWith(`/agencies/${AGENCY}/contents/awaiting-client`)) return json({ data: [], meta: { truncated: false } });
  return json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404);
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface Probe { pathname: string; state: unknown }

const STATE = { from: '/agencia/x/clientes?busca=padaria' };

const renderHome = (scenario: Scenario): Probe => {
  const client = new HttpClient('http://127.0.0.1:3001', makeFetch(scenario), { onSessionEnded: () => undefined });
  const store = createAuthSessionStore(client);
  const probe: Probe = { pathname: '', state: undefined };
  function Watch() {
    useCommittedLocation((location) => { probe.pathname = location.pathname; probe.state = location.state; });
    return null;
  }
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[{ pathname: `/agencia/${AGENCY}`, state: STATE }]}>
            <Watch />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return probe;
};

const greetingOf = (): Promise<HTMLElement> => screen.findByRole('heading', { level: 1, name: /^(Bom dia|Boa tarde|Boa noite)/ });

// A link to the new content opens its modal: jsdom has no top layer, so these stubs only model opening and closing.
const dialogDescriptors = ['showModal', 'close'].map((name) => [name, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)] as const);
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
});
afterAll(() => {
  for (const [name, descriptor] of dialogDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    else Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
  }
});

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const at = (instant: string): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(instant));
};

describe('the header: the date, the greeting and the sentence', () => {
  it.each([
    // 01:30Z is still the evening before in São Paulo (UTC-3): 22h30 of Wednesday the 11th.
    ['2026-11-12T01:30:00.000Z', 'Quarta, 11 de novembro', 'Boa noite, Marina'],
    ['2026-11-11T12:00:00.000Z', 'Quarta, 11 de novembro', 'Bom dia, Marina'],
    ['2026-11-11T18:00:00.000Z', 'Quarta, 11 de novembro', 'Boa tarde, Marina'],
    // 02:59Z is 23h59 of Tuesday the 10th there.
    ['2026-11-11T02:59:00.000Z', 'Terça, 10 de novembro', 'Boa noite, Marina']
  ])('at %s it says "%s" and "%s", by the São Paulo clock and the first name', async (instant, date, title) => {
    at(instant);
    renderHome({ permissions: ALL, clients: 1 });
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
    expect(screen.getByText(date)).toBeTruthy();
  });

  it.each([
    ['no client yet', { permissions: ALL }, 'Comece pelo primeiro cliente. Depois dele, a pauta começa a andar.'],
    ['a client and no content', { permissions: ALL, clients: 1 }, 'O cliente já está na carteira. Falta o primeiro post na pauta.'],
    ['a content not sent', { permissions: ALL, clients: 1, facts: { ...none, hasContent: true } }, 'Já há conteúdo na pauta. Falta enviá-lo ao cliente.'],
    ['a content sent and no approval', { permissions: ALL, clients: 1, facts: { ...none, hasContent: true, sentForApproval: true } }, 'Falta só a primeira aprovação. Depois dela, a pauta anda sozinha.'],
    ['one late and the journey done', { permissions: ALL, clients: 1, facts: done, summary: { awaitingClient: 5, overdueAwaitingClient: 1 } }, '1 conteúdo está com a data de publicação vencida e sem aprovação.'],
    ['several late and the journey done', { permissions: ALL, clients: 1, facts: done, summary: { awaitingClient: 5, overdueAwaitingClient: 2 } }, '2 conteúdos estão com a data de publicação vencida e sem aprovação.'],
    ['one waiting and none late', { permissions: ALL, clients: 1, facts: done, summary: { awaitingClient: 1, overdueAwaitingClient: 0 } }, '1 post espera a resposta do cliente.'],
    ['several waiting and none late', { permissions: ALL, clients: 1, facts: done, summary: { awaitingClient: 5, overdueAwaitingClient: 0 } }, '5 posts esperam a resposta do cliente.'],
    ['nothing waiting', { permissions: ALL, clients: 1, facts: done }, 'Nada parado no cliente.']
  ] as const)('says the state in one sentence: %s', async (_name, scenario, sentence) => {
    renderHome(scenario);
    expect(await screen.findByText(sentence)).toBeTruthy();
  });
});

describe('"Novo conteúdo" in the header', () => {
  it('opens the new content of the client when the roster is one, and carries the state of the carteira', async () => {
    const probe = renderHome({ permissions: ALL, clients: 1 });
    await greetingOf();
    const link = await screen.findByRole('link', { name: 'Novo conteúdo' });
    expect(link.getAttribute('href')).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT}/novo`);
    fireEvent.click(link);
    await waitFor(() => { expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT}/novo`); });
    expect(probe.state).toEqual(STATE);
  });

  it('asks which client when there are several', async () => {
    const probe = renderHome({ permissions: ALL, clients: 2 });
    fireEvent.click(await screen.findByRole('link', { name: 'Novo conteúdo' }));
    await waitFor(() => { expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos`); });
    expect(probe.pathname).not.toContain(OTHER_CLIENT);
  });

  it.each([
    ['there is no client', { permissions: ALL }],
    ['the role cannot operate contents', { permissions: VIEW, clients: 1 }],
    ['the plan is read-only', { permissions: ALL, clients: 1, readOnly: true }],
    ['the role cannot see the contents', { permissions: ['cliente.visualizar', 'conteudo.operar'], clients: 1 }]
  ])('is not offered when %s', async (_name, scenario) => {
    renderHome(scenario);
    await greetingOf();
    await waitFor(() => { expect(screen.queryByRole('link', { name: 'Novo conteúdo' })).toBeNull(); });
  });

  it('is a secondary button: the primary of the Início belongs to the journey', async () => {
    renderHome({ permissions: ALL, clients: 1 });
    expect((await screen.findByRole('link', { name: 'Novo conteúdo' })).classList.contains('ui-button--secondary')).toBe(true);
  });
});

describe('no shortcuts to the modules', () => {
  const shortcutTexts = ['Calendário do mês, aprovação e roteiros de stories.', 'Carteira, estudo de marca e conversas.', 'Colaboradores, papéis e convites.'];

  it('shows the menu as the way to the modules and no card of shortcuts in the page', async () => {
    renderHome({ permissions: ALL, clients: 1 });
    await greetingOf();
    const main = screen.getByRole('main');
    for (const text of shortcutTexts) expect(within(main).queryByText(text)).toBeNull();
    expect(within(main).queryByRole('link', { name: /^(Clientes|Equipe|Calendário Editorial)\b/ })).toBeNull();
    expect(within(screen.getByRole('navigation', { name: 'Navegação da agência' })).getByRole('link', { name: 'Clientes' })).toBeTruthy();
  });

  it('gives a person with no module the way out instead of a mute screen', async () => {
    renderHome({ permissions: [] });
    expect(await screen.findByRole('heading', { name: 'Nenhum módulo disponível para o seu papel', level: 2 })).toBeTruthy();
    expect(screen.getByText('Fale com quem administra a agência para liberar o acesso. Se você participa de outra agência, troque de contexto.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Trocar de contexto' }).getAttribute('href')).toBe('/contextos');
  });

  it('does not say "no module" to a person who has one', async () => {
    renderHome({ permissions: ['cliente.visualizar'] });
    await greetingOf();
    expect(screen.queryByText('Nenhum módulo disponível para o seu papel')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Parado no cliente' })).toBeNull();
  });
});
