// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type Location, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { useCommittedLocation } from './location-probe-fixture.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 01:30Z of the 12th is 22:30 of the 11th (a Sunday) in São Paulo: a day computed in UTC is the wrong one. */
const NOW = new Date('2026-10-12T01:30:00Z');
const TODAY = '2026-10-11';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const AGENCY_B = '22222222-2222-4222-8222-222222222222';
const sessionBody = { user: { id: '99999999-9999-4999-8999-999999999999', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const unauthenticated = (): Response => json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' } }, 401);
const forbidden = (): Response => json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, 403);
const notFound = (): Response => json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
const invalid = (): Response => json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' } }, 400);

const VISUALIZE = 'conteudo.visualizar';
/** A role per row, each with a single permission: the menu and the guard answer to that one only. */
const READ_CLIENTS = 'cliente.visualizar';

const agencyMe = (agencyId: string, agencyName: string, permissions: readonly string[]) => ({
  agencyId, agencyName, isOwner: false, role: { key: 'custom', name: 'Papel' }, permissions
});

const clientFixture = (id: string, name: string, handle: string | null, status: 'active' | 'archived' = 'active') => ({
  id, name, photoUrl: null, instagramHandle: handle, status, closingDate: null, threadsAwaitingAgency: 0
});

// Not alphabetical on purpose: the server's `sort=attention` order is the order of the stories.
const padaria = clientFixture('1a1a1a1a-1111-4111-8111-111111111111', 'Padaria Central', 'padariacentral');
const academia = clientFixture('2b2b2b2b-2222-4222-8222-222222222222', 'Academia Corpo', 'academiacorpo');
const confeitaria = clientFixture('4d4d4d4d-4444-4444-8444-444444444444', 'Confeitaria Doce', null);
const barbearia = clientFixture('3c3c3c3c-3333-4333-8333-333333333333', 'Barbearia Lima', 'barbearialima', 'archived');
const ROSTER = [padaria, academia, barbearia, confeitaria];

const detailOf = (client: ReturnType<typeof clientFixture>) => ({
  id: client.id,
  name: client.name,
  status: client.status,
  photoUrl: client.photoUrl,
  instagramHandle: client.instagramHandle,
  legalName: null,
  taxId: null,
  segment: null,
  website: null,
  contactName: null,
  contactPhone: null,
  contactEmail: null,
  closingDate: null,
  archivedAt: null,
  summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 0 }
});

let idCounter = 0;
const contentFixture = (overrides: Record<string, unknown> = {}) => {
  idCounter += 1;
  return {
    id: `c0c0c0c0-0000-4000-8000-${String(idCounter).padStart(12, '0')}`,
    title: `Conteúdo ${idCounter}`,
    platform: 'instagram',
    format: 'reels',
    publishOn: '2026-10-20',
    publishAtTime: null,
    status: 'in_production',
    ownerUserId: '99999999-9999-4999-8999-999999999999',
    coverAssetId: null,
    revision: 1,
    publishedOn: null,
    tasksTotal: 0,
    tasksApproved: 0,
    ...overrides
  };
};

const periodResponse = (contents: readonly unknown[], from: string, to: string): Response =>
  json({ data: { contents, storyScripts: [] }, meta: { from, to, count: contents.length } });

interface Scenario {
  readonly permissions?: readonly string[];
  readonly roster?: readonly ReturnType<typeof clientFixture>[];
  readonly clients?: (query: URLSearchParams) => Response | Promise<Response>;
  /** Contents of one client, by its id; the fake filters them by the period like the API does. */
  readonly contents?: Readonly<Record<string, readonly ReturnType<typeof contentFixture>[]>>;
  readonly period?: (clientId: string, from: string, to: string, call: number) => Response | Promise<Response> | undefined;
  readonly detail?: (clientId: string) => Response | Promise<Response> | undefined;
}

const DAY_MS = 86_400_000;
const dayCount = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
const isDay = (value: string | null): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Behaves like the real API: 401 without a session, 403 from the guard, 400 for a bad period, 404 for a client out of reach. */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  let periodCalls = 0;
  const permissions = scenario.permissions ?? [VISUALIZE, READ_CLIENTS];
  const roster = scenario.roster ?? ROSTER;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}${url.search}`);
    if (path.endsWith('/auth/session')) return json(sessionBody);
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) return json(agencyMe(me[1]!, me[1] === AGENCY_B ? 'Agência Dois' : 'Agência Um', permissions));
    const list = /\/agencies\/([^/]+)\/clients$/.exec(path);
    if (list !== null && method === 'GET') {
      if (!permissions.includes(READ_CLIENTS)) return forbidden();
      if (scenario.clients !== undefined) return scenario.clients(url.searchParams);
      const status = url.searchParams.get('status') ?? 'active';
      const rows = roster.filter((client) => client.status === status);
      const pageSize = Number(url.searchParams.get('pageSize') ?? '20');
      return json({ data: rows.slice(0, pageSize), meta: { page: 1, pageSize, totalItems: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)) } });
    }
    const contents = /\/agencies\/([^/]+)\/clients\/([^/]+)\/contents$/.exec(path);
    if (contents !== null && method === 'GET') {
      if (!permissions.includes(VISUALIZE)) return forbidden();
      const clientId = contents[2]!;
      if (!roster.some((client) => client.id === clientId)) return notFound();
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!isDay(from) || !isDay(to) || from > to || dayCount(from, to) > 93) return invalid();
      periodCalls += 1;
      const custom = scenario.period?.(clientId, from, to, periodCalls);
      if (custom !== undefined) return custom;
      const rows = (scenario.contents?.[clientId] ?? []).filter((content) => content.publishOn >= from && content.publishOn <= to);
      return periodResponse(rows, from, to);
    }
    const detail = /\/agencies\/([^/]+)\/clients\/([^/]+)$/.exec(path);
    if (detail !== null && method === 'GET') {
      if (!permissions.includes(READ_CLIENTS)) return forbidden();
      const custom = scenario.detail?.(detail[2]!);
      if (custom !== undefined) return custom;
      const client = roster.find((candidate) => candidate.id === detail[2]);
      return client === undefined ? notFound() : json(detailOf(client));
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface Probe {
  pathname: string;
  search: string;
  state: unknown;
  navigate: NavigateFunction;
}

function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location: Location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.state = location.state;
    probe.navigate = navigate;
  });
  return null;
}

const render_ = (impl: typeof fetch, entry: string | { pathname: string; state: unknown } = `/agencia/${AGENCY_A}/conteudos`) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: Probe = { pathname: '', search: '', state: undefined, navigate: () => undefined };
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <LocationProbe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { ...rendered, probe, queryClient };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const contentsUrl = (clientId: string, search = '') => `/agencia/${AGENCY_A}/conteudos/${clientId}${search}`;
const periodCall = (clientId: string, from: string, to: string) => `GET /agencies/${AGENCY_A}/clients/${clientId}/contents?from=${from}&to=${to}`;
const periodCalls = (calls: readonly string[]): string[] => calls.filter((call) => /\/contents\?/.test(call));

/** The day cell that holds a `<time dateTime>`. */
const dayCell = (day: string): HTMLElement => {
  const time = document.querySelector(`time[datetime="${day}"]`);
  const cell = time?.closest('li');
  if (cell === null || cell === undefined) throw new Error(`The day ${day} was not rendered.`);
  return cell;
};

const OCTOBER = { from: '2026-09-28', to: '2026-11-01' };

/** The grid exists only once the period answered: the title above it is there from the first render. */
const calendarReady = (): Promise<HTMLElement> => waitFor(() => {
  const calendar = document.querySelector<HTMLElement>('.content-calendar');
  if (calendar === null) throw new Error('The calendar has not rendered yet.');
  return calendar;
});

describe('the Conteúdos item and the guard', () => {
  it('gives the item to whoever has conteudo.visualizar, linked to the selector', async () => {
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS] });
    render_(impl, `/agencia/${AGENCY_A}`);

    const link = await screen.findByRole('link', { name: 'Conteúdos' });
    expect(link.getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos`);
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { name: 'Conteúdos' })).toBeTruthy();
    expect(await screen.findByText('Escolha um cliente para ver o calendário editorial.')).toBeTruthy();
  });

  // Vendas and Financeiro hold neither content permission; each row below is a role with one permission.
  it.each([
    ['cliente.visualizar', [READ_CLIENTS]],
    ['conteudo.operar, sem visualizar', ['conteudo.operar', READ_CLIENTS]],
    ['conteudo.publicar, sem visualizar', ['conteudo.publicar', READ_CLIENTS]],
    ['cliente.visualizar e financeiro.visualizar', [READ_CLIENTS, 'financeiro.visualizar']]
  ])('hides the item and answers "não encontrado" to both addresses: %s', async (_name, permissions) => {
    const { impl, calls } = makeFetch({ permissions });
    const { unmount } = render_(impl, `/agencia/${AGENCY_A}`);
    await screen.findByRole('link', { name: 'Início' });
    expect(screen.queryByRole('link', { name: 'Conteúdos' })).toBeNull();
    unmount();

    for (const address of [`/agencia/${AGENCY_A}/conteudos`, contentsUrl(padaria.id)]) {
      const view = render_(impl, address);
      expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
      expect(screen.queryByText('Padaria Central')).toBeNull();
      view.unmount();
    }
    // Nothing about contents or the roster left the browser for a person who cannot read them.
    expect(calls.filter((call) => /\/contents|\/clients/.test(call))).toEqual([]);
  });

  // The picker is the roster (decision of 2026-10-11): reading contents without reading clients is not a way in.
  it('hides the item and answers "não encontrado" to both addresses when the person reads contents but not the roster', async () => {
    const { impl, calls } = makeFetch({ permissions: [VISUALIZE] });
    const { unmount } = render_(impl, `/agencia/${AGENCY_A}`);
    await screen.findByRole('link', { name: 'Início' });
    expect(screen.queryByRole('link', { name: 'Conteúdos' })).toBeNull();
    unmount();

    for (const address of [`/agencia/${AGENCY_A}/conteudos`, contentsUrl(padaria.id)]) {
      const view = render_(impl, address);
      expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
      view.unmount();
    }
    expect(calls.filter((call) => /\/contents|\/clients/.test(call))).toEqual([]);
  });
});

describe('the stories (/agencia/:agenciaId/conteudos)', () => {
  it('lists the active clients in the order of the roster, with their names, and asks for no order of its own', async () => {
    const { impl, calls } = makeFetch();
    render_(impl);

    const nav = await screen.findByRole('navigation', { name: 'Clientes' });
    const names = within(nav).getAllByRole('link').map((link) => link.querySelector('.content-story__name')?.textContent);
    // The archived client is not here, and the order is the server's, not alphabetical.
    expect(names).toEqual(['Padaria Central', 'Academia Corpo', 'Confeitaria Doce']);
    expect(screen.queryByText('Barbearia Lima')).toBeNull();
    expect(calls).toContain(`GET /agencies/${AGENCY_A}/clients?page=1&pageSize=100`);
    expect(calls.filter((call) => /\/clients\?/.test(call))).toHaveLength(1);
  });

  it('says how many clients are not shown when the roster is longer than one page', async () => {
    const { impl } = makeFetch({
      clients: (query) => json({
        data: [padaria, academia],
        meta: { page: 1, pageSize: Number(query.get('pageSize')), totalItems: 130, totalPages: 2 }
      })
    });
    render_(impl);
    expect(await screen.findByText('Mostrando 2 de 130 clientes.')).toBeTruthy();
  });

  it('says so when there is no active client', async () => {
    const { impl } = makeFetch({ roster: [barbearia] });
    render_(impl);
    expect(await screen.findByText('Nenhum cliente ativo ainda.')).toBeTruthy();
    expect(screen.queryByText('Escolha um cliente para ver o calendário editorial.')).toBeNull();
  });

  it('shows a skeleton on the first load, then the clients', async () => {
    const held = deferred<Response>();
    const { impl } = makeFetch({ clients: () => held.promise });
    const { container } = render_(impl);

    await screen.findByRole('heading', { name: 'Conteúdos' });
    await waitFor(() => expect(container.querySelector('.content-stories__skeleton')).not.toBeNull());
    expect(screen.queryByRole('navigation', { name: 'Clientes' })).toBeNull();

    held.resolve(json({ data: [padaria], meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } }));
    expect(await screen.findByRole('link', { name: 'Padaria Central' })).toBeTruthy();
    expect(container.querySelector('.content-stories__skeleton')).toBeNull();
  });

  it('shows the error with "Tentar de novo", and the retry brings the clients back', async () => {
    let attempts = 0;
    const { impl } = makeFetch({
      clients: (query) => {
        attempts += 1;
        return attempts <= 2
          ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500)
          : json({ data: [padaria], meta: { page: 1, pageSize: Number(query.get('pageSize')), totalItems: 1, totalPages: 1 } });
      }
    });
    render_(impl);

    // The query retries a 5xx once before it gives up.
    expect(await screen.findByText('Não foi possível carregar os clientes. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('link', { name: 'Padaria Central' })).toBeTruthy();
    expect(screen.queryByText('Não foi possível carregar os clientes. Tente de novo.')).toBeNull();
  });

  it('puts the client in the address when it is clicked, and the calendar of that client opens', async () => {
    const { impl, calls } = makeFetch({ contents: { [academia.id]: [contentFixture({ title: 'Treino da semana', publishOn: '2026-10-14' })] } });
    const { probe } = render_(impl);

    fireEvent.click(await screen.findByRole('link', { name: 'Academia Corpo' }));
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(academia.id)));
    expect(await screen.findByText('Treino da semana')).toBeTruthy();
    expect(calls).toContain(periodCall(academia.id, OCTOBER.from, OCTOBER.to));
  });

  it('keeps the navigation state on every story link', async () => {
    const roster = `/agencia/${AGENCY_A}/clientes?search=padaria&page=2`;
    const { impl } = makeFetch();
    const { probe } = render_(impl, { pathname: `/agencia/${AGENCY_A}/conteudos`, state: { clientListUrl: roster } });

    fireEvent.click(await screen.findByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(padaria.id)));
    expect(probe.state).toEqual({ clientListUrl: roster });
    fireEvent.click(await screen.findByRole('link', { name: 'Academia Corpo' }));
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(academia.id)));
    expect(probe.state).toEqual({ clientListUrl: roster });
  });
});

describe('the client in the address', () => {
  it('survives a reload: the same address opens the same client, with its name and handle', async () => {
    const { impl, calls } = makeFetch({ contents: { [academia.id]: [contentFixture({ title: 'Treino da semana', publishOn: '2026-10-14' })] } });
    const first = render_(impl);
    fireEvent.click(await screen.findByRole('link', { name: 'Academia Corpo' }));
    await waitFor(() => expect(first.probe.pathname).toBe(contentsUrl(academia.id)));
    await screen.findByText('Treino da semana');
    const reloadAt = first.probe.pathname + first.probe.search;
    first.unmount();

    render_(impl, reloadAt);
    expect(await screen.findByRole('heading', { name: 'Academia Corpo' })).toBeTruthy();
    expect(await screen.findByText('@academiacorpo')).toBeTruthy();
    expect(await screen.findByText('Treino da semana')).toBeTruthy();
    // No other client's calendar was asked for.
    expect(periodCalls(calls).every((call) => call.includes(`/clients/${academia.id}/`))).toBe(true);
  });

  it('marks the chosen story as the current page, and only that one', async () => {
    const { impl } = makeFetch();
    render_(impl, contentsUrl(academia.id));

    const chosen = await screen.findByRole('link', { name: 'Academia Corpo' });
    await waitFor(() => expect(chosen.getAttribute('aria-current')).toBe('page'));
    expect(screen.getByRole('link', { name: 'Padaria Central' }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('link', { name: 'Confeitaria Doce' }).getAttribute('aria-current')).toBeNull();
  });

  it('switches client from the stories without keeping the previous client\'s contents on screen', async () => {
    const held = deferred<Response>();
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Pão de queijo', publishOn: '2026-10-14' })] },
      period: (clientId, from, to) => clientId === academia.id ? held.promise.then(() => periodResponse([], from, to)) : undefined
    });
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Pão de queijo');

    fireEvent.click(screen.getByRole('link', { name: 'Academia Corpo' }));
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(academia.id)));
    // While the new calendar loads, the old client's card is gone: never under another client's name.
    expect(screen.queryByText('Pão de queijo')).toBeNull();
    held.resolve(json({}));
    expect(await screen.findByText('Nenhum conteúdo planejado neste período.')).toBeTruthy();
  });

  it.each([
    ['a client that does not exist', '9f9f9f9f-9999-4999-8999-999999999999'],
    ['an id that is not an id', 'nao-e-um-id']
  ])('answers "não encontrado" for %s', async (_name, clientId) => {
    const { impl, calls } = makeFetch();
    render_(impl, contentsUrl(clientId));
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    if (clientId === 'nao-e-um-id') expect(periodCalls(calls)).toEqual([]);
  });

  it('answers "não encontrado" when the API hides the client (404 of the detail or of the period)', async () => {
    const hiddenDetail = makeFetch({ detail: () => notFound() });
    const first = render_(hiddenDetail.impl, contentsUrl(padaria.id));
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
    first.unmount();

    const hiddenPeriod = makeFetch({ period: () => notFound() });
    render_(hiddenPeriod.impl, contentsUrl(padaria.id));
    expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
  });
});

describe('the month calendar', () => {
  it('asks for whole weeks around the month of today in São Paulo, and marks that day', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, contentsUrl(padaria.id));

    expect(await screen.findByRole('heading', { name: 'Outubro 2026' })).toBeTruthy();
    await calendarReady();
    expect(periodCalls(calls)).toEqual([periodCall(padaria.id, OCTOBER.from, OCTOBER.to)]);
    // Today is the 11th in São Paulo (the 12th in UTC).
    expect(dayCell(TODAY).getAttribute('aria-current')).toBe('date');
    expect(dayCell('2026-10-12').getAttribute('aria-current')).toBeNull();
    expect(document.querySelectorAll('[aria-current="date"]')).toHaveLength(1);
    // Whole weeks: the 28th of September opens the grid and the 1st of November closes it.
    expect(dayCell('2026-09-28')).toBeTruthy();
    expect(dayCell('2026-11-01')).toBeTruthy();
    expect(document.querySelectorAll('.content-day')).toHaveLength(35);
    expect(screen.getByText('domingo, 11 de outubro de 2026')).toBeTruthy();
    for (const weekday of ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']) expect(screen.getByText(weekday)).toBeTruthy();
  });

  it('is still October on the last evening of October, when UTC is already November', async () => {
    vi.setSystemTime(new Date('2026-11-01T01:30:00Z'));
    const { impl, calls } = makeFetch();
    render_(impl, contentsUrl(padaria.id));

    expect(await screen.findByRole('heading', { name: 'Outubro 2026' })).toBeTruthy();
    await calendarReady();
    expect(periodCalls(calls)).toEqual([periodCall(padaria.id, OCTOBER.from, OCTOBER.to)]);
    expect(dayCell('2026-10-31').getAttribute('aria-current')).toBe('date');
  });

  it('dims the days of the neighbouring months', async () => {
    const { impl } = makeFetch();
    render_(impl, contentsUrl(padaria.id));
    await calendarReady();

    expect(dayCell('2026-09-28').className).toContain('content-day--outside');
    expect(dayCell('2026-11-01').className).toContain('content-day--outside');
    expect(dayCell('2026-10-15').className).not.toContain('content-day--outside');
  });

  it('puts each card on the day it is planned for, and says so in text for every field of the card', async () => {
    const { impl } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ title: 'Lançamento do pão', publishOn: '2026-10-14', publishAtTime: '18:00', format: 'carousel', status: 'awaiting_approval', tasksTotal: 4, tasksApproved: 2 }),
          contentFixture({ title: 'Bastidores', publishOn: '2026-10-14', format: 'image', status: 'adjusting' }),
          contentFixture({ title: 'Receita longa', publishOn: '2026-10-30', format: 'long_video', status: 'approved' }),
          contentFixture({ title: 'Sorteio', publishOn: '2026-10-31', format: 'vsl', status: 'cancelled' })
        ]
      }
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Lançamento do pão');

    const day = dayCell('2026-10-14');
    expect(within(day).getAllByRole('article').map((card) => within(card).getByText(/./, { selector: '.content-card__title' }).textContent)).toEqual(['Lançamento do pão', 'Bastidores']);
    const launch = within(day).getByText('Lançamento do pão').closest('article')!;
    expect(within(launch).getByText('Carrossel · 18:00')).toBeTruthy();
    expect(within(launch).getByText('Aguardando aprovação')).toBeTruthy();
    expect(within(launch).getByText('50% das subtarefas')).toBeTruthy();
    const behind = within(day).getByText('Bastidores').closest('article')!;
    expect(within(behind).getByText('Imagem')).toBeTruthy();
    expect(within(behind).getByText('Em ajuste')).toBeTruthy();
    // No subtasks: no percentage at all, not "0%".
    expect(within(behind).queryByText(/subtarefas/)).toBeNull();
    expect(within(dayCell('2026-10-30')).getByText('Vídeo longo')).toBeTruthy();
    expect(within(dayCell('2026-10-30')).getByText('Pronto para publicar')).toBeTruthy();
    expect(within(dayCell('2026-10-31')).getByText('VSL')).toBeTruthy();
    expect(within(dayCell('2026-10-31')).getByText('Cancelado')).toBeTruthy();
    // Nothing leaks into the neighbours.
    expect(within(dayCell('2026-10-15')).queryByRole('article')).toBeNull();
  });

  it('labels the six states of a content', async () => {
    const statuses = [
      ['in_production', 'Em produção'], ['awaiting_approval', 'Aguardando aprovação'], ['adjusting', 'Em ajuste'],
      ['approved', 'Pronto para publicar'], ['published', 'Publicado'], ['cancelled', 'Cancelado']
    ] as const;
    const { impl } = makeFetch({
      contents: { [padaria.id]: statuses.map(([status], index) => contentFixture({ title: `Post ${status}`, status, publishOn: `2026-10-${String(20 + index).padStart(2, '0')}` })) }
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Post in_production');

    for (const [status, label] of statuses) {
      expect(within(screen.getByText(`Post ${status}`).closest('article')!).getByText(label)).toBeTruthy();
    }
  });

  it('flags the overdue and the near deadline, and only for what is still open', async () => {
    const { impl } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ title: 'Passou', publishOn: '2026-10-10', status: 'approved' }),
          contentFixture({ title: 'Para hoje', publishOn: '2026-10-11', status: 'in_production' }),
          contentFixture({ title: 'Em dois dias', publishOn: '2026-10-13', status: 'adjusting' }),
          contentFixture({ title: 'Em três dias', publishOn: '2026-10-14', status: 'in_production' }),
          contentFixture({ title: 'Já publicado', publishOn: '2026-10-05', status: 'published' }),
          contentFixture({ title: 'Cancelado antigo', publishOn: '2026-10-06', status: 'cancelled' })
        ]
      }
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Passou');

    const alertsOf = (title: string): (string | null)[] => Array.from(screen.getByText(title).closest('article')!.querySelectorAll('.content-card__badge--overdue, .content-card__badge--due-soon')).map((badge) => badge.textContent);
    expect(alertsOf('Passou')).toEqual(['Atrasado']);
    expect(alertsOf('Para hoje')).toEqual(['Prazo em dois dias']);
    expect(alertsOf('Em dois dias')).toEqual(['Prazo em dois dias']);
    expect(alertsOf('Em três dias')).toEqual([]);
    expect(alertsOf('Já publicado')).toEqual([]);
    expect(alertsOf('Cancelado antigo')).toEqual([]);
  });

  it('renders what the server wrote as text, never as markup', async () => {
    const hostile = '<img src=x onerror="document.title=1"><b>negrito</b>';
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: hostile, publishOn: '2026-10-14' })] } });
    const { container } = render_(impl, contentsUrl(padaria.id));

    expect(await screen.findByText(hostile)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.content-card b')).toBeNull();
  });

  it('shows the empty state in the grid when the period has nothing, and not while it has something', async () => {
    const empty = makeFetch();
    const first = render_(empty.impl, contentsUrl(padaria.id));
    expect(await screen.findByText('Nenhum conteúdo planejado neste período.')).toBeTruthy();
    expect(document.querySelectorAll('.content-day')).toHaveLength(35);
    first.unmount();

    const filled = makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-14' })] } });
    render_(filled.impl, contentsUrl(padaria.id));
    await screen.findByRole('article');
    expect(screen.queryByText('Nenhum conteúdo planejado neste período.')).toBeNull();
  });

  it('shows a skeleton on the first load and no calendar numbers behind it', async () => {
    const held = deferred<Response>();
    const { impl } = makeFetch({ period: () => held.promise });
    const { container } = render_(impl, contentsUrl(padaria.id));

    await screen.findByRole('heading', { name: 'Outubro 2026' });
    await waitFor(() => expect(container.querySelector('.contents__skeleton')).not.toBeNull());
    expect(container.querySelector('.content-calendar')).toBeNull();
    expect(screen.queryByText('Nenhum conteúdo planejado neste período.')).toBeNull();

    held.resolve(periodResponse([], OCTOBER.from, OCTOBER.to));
    await screen.findByText('Nenhum conteúdo planejado neste período.');
    expect(container.querySelector('.contents__skeleton')).toBeNull();
  });

  it('shows the error with "Tentar de novo", and the retry brings the calendar back', async () => {
    const { impl, calls } = makeFetch({
      period: (_client, from, to, call) => call <= 2 ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) : periodResponse([contentFixture({ title: 'Voltou', publishOn: '2026-10-14' })], from, to)
    });
    render_(impl, contentsUrl(padaria.id));

    expect(await screen.findByText('Não foi possível carregar os conteúdos. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('Nenhum conteúdo planejado neste período.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Voltou')).toBeTruthy();
    expect(screen.queryByText('Não foi possível carregar os conteúdos. Tente de novo.')).toBeNull();
    expect(periodCalls(calls).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the previous period on screen while the next one loads, saying it is updating', async () => {
    const held = deferred<Response>();
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Do fim de outubro', publishOn: '2026-10-30' })] },
      period: (_client, from, to) => from === '2026-10-26' ? held.promise.then(() => periodResponse([], from, to)) : undefined
    });
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Do fim de outubro');

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await waitFor(() => expect(probe.search).toBe('?data=2026-11-01'));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByText('Atualizando…')).toBeTruthy();
    // The card stays in its own day while the grid already shows November.
    expect(within(dayCell('2026-10-30')).getByText('Do fim de outubro')).toBeTruthy();
    expect(screen.queryByText('Nenhum conteúdo planejado neste período.')).toBeNull();

    held.resolve(json({}));
    expect(await screen.findByText('Nenhum conteúdo planejado neste período.')).toBeTruthy();
    expect(screen.queryByText('Atualizando…')).toBeNull();
  });
});

describe('the period controls and the URL', () => {
  it('moves by month with the arrows and back to today, writing the day to the URL and asking for the right days', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByRole('heading', { name: 'Outubro 2026' });

    fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
    const title = await screen.findByRole('heading', { name: 'Setembro 2026' });
    // The new period is announced to a screen reader without moving the focus.
    expect(title.getAttribute('aria-live')).toBe('polite');
    expect(probe.search).toBe('?data=2026-09-01');
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-08-31', '2026-10-04')));

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Próximo mês' }));
    expect(await screen.findByRole('heading', { name: 'Novembro 2026' })).toBeTruthy();
    expect(probe.search).toBe('?data=2026-11-01');
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-10-26', '2026-12-06')));

    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }));
    expect(await screen.findByRole('heading', { name: 'Outubro 2026' })).toBeTruthy();
    expect(probe.search).toBe('');
  });

  it('switches to the week and back, and moves by week', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByRole('heading', { name: 'Outubro 2026' });
    expect(screen.getByRole('button', { name: 'Mês' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Semana' }).getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Semana' }));
    expect(await screen.findByRole('heading', { name: '5 a 11 de outubro de 2026' })).toBeTruthy();
    expect(probe.search).toBe('?visao=semana');
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-10-05', '2026-10-11')));
    expect(document.querySelectorAll('.content-day')).toHaveLength(7);
    expect(screen.getByRole('button', { name: 'Semana' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Próxima semana' }));
    expect(await screen.findByRole('heading', { name: '12 a 18 de outubro de 2026' })).toBeTruthy();
    expect(probe.search).toBe('?visao=semana&data=2026-10-18');
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-10-12', '2026-10-18')));

    fireEvent.click(screen.getByRole('button', { name: 'Semana anterior' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Semana anterior' }));
    expect(await screen.findByRole('heading', { name: '28 de setembro a 4 de outubro de 2026' })).toBeTruthy();
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-09-28', '2026-10-04')));

    fireEvent.click(screen.getByRole('button', { name: 'Mês' }));
    // The anchor was Sunday the 4th: the month that holds it is October, and the day stays in the URL.
    expect(await screen.findByRole('heading', { name: 'Outubro 2026' })).toBeTruthy();
    expect(probe.search).toBe('?data=2026-10-04');
  });

  it('reads the view and the day from the URL, so a reload lands on the same period', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, contentsUrl(padaria.id, '?visao=semana&data=2026-10-14'));

    expect(await screen.findByRole('heading', { name: '12 a 18 de outubro de 2026' })).toBeTruthy();
    expect(periodCalls(calls)).toEqual([periodCall(padaria.id, '2026-10-12', '2026-10-18')]);
  });

  it.each([
    ['a day that does not exist', '?data=2026-02-30'],
    ['text', '?data=amanha'],
    ['a view that does not exist', '?visao=ano']
  ])('falls back to this month for %s in the URL', async (_name, search) => {
    const { impl, calls } = makeFetch();
    render_(impl, contentsUrl(padaria.id, search));

    expect(await screen.findByRole('heading', { name: 'Outubro 2026' })).toBeTruthy();
    expect(periodCalls(calls)).toEqual([periodCall(padaria.id, OCTOBER.from, OCTOBER.to)]);
  });

  it('changing the period keeps the client in the address and asks for that client only', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = render_(impl, contentsUrl(academia.id));
    await screen.findByRole('heading', { name: 'Outubro 2026' });

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await screen.findByRole('heading', { name: 'Novembro 2026' });
    expect(probe.pathname).toBe(contentsUrl(academia.id));
    expect(periodCalls(calls).every((call) => call.includes(`/clients/${academia.id}/`))).toBe(true);
  });
});

describe('the places left for the next parts', () => {
  it('has Calendário selected, the feed open at its side and the Pastas tab open', async () => {
    const { impl } = makeFetch();
    render_(impl, contentsUrl(padaria.id));
    await screen.findByRole('heading', { name: 'Outubro 2026' });

    expect(screen.getByRole('tab', { name: 'Calendário' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Feed' }).getAttribute('aria-selected')).toBe('false');
    expect((screen.getByRole('tab', { name: 'Feed' }) as HTMLButtonElement).disabled).toBe(false);
    const pastas = screen.getByRole('tab', { name: 'Pastas' }) as HTMLButtonElement;
    expect(pastas.disabled).toBe(false);
    expect(pastas.getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('complementary', { name: 'Prévia do feed' })).toBeTruthy();
  });
});

describe('every request goes through apiPath', () => {
  it('sends only well-formed paths with the ids percent-encoded as one segment', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, contentsUrl(padaria.id.toUpperCase()));
    await calendarReady();

    const agencyCalls = calls.filter((call) => call.includes('/agencies/'));
    expect(agencyCalls.length).toBeGreaterThan(2);
    for (const call of agencyCalls) expect(call).toMatch(new RegExp(`^GET /agencies/${AGENCY_A}/(me|clients(/${padaria.id}(/contents\\?from=\\d{4}-\\d{2}-\\d{2}&to=\\d{4}-\\d{2}-\\d{2})?|\\?page=1&pageSize=100)?)$`));
    // The id in the address is lower-cased before it becomes a request: the API compares it as is.
    expect(calls.some((call) => call.includes(padaria.id.toUpperCase()))).toBe(false);
  });

  it('never revalidates the shell of another agency into this one', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, `/agencia/${AGENCY_B}/conteudos`);
    await screen.findByRole('link', { name: 'Padaria Central' });
    expect(calls.filter((call) => /\/agencies\//.test(call)).every((call) => call.includes(`/agencies/${AGENCY_B}/`))).toBe(true);
    expect(calls.some((call) => call.includes(AGENCY_A))).toBe(false);
  });
});

describe('the session', () => {
  it('does not render a calendar for a person without a session', async () => {
    const unauth: typeof fetch = async () => unauthenticated();
    const { container } = render_(unauth, contentsUrl(padaria.id));
    await waitFor(() => expect(container.querySelector('.content-calendar')).toBeNull());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Padaria Central')).toBeNull();
  });
});
