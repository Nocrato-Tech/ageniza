// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type Location, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateContentRequestSchema } from '@ageniza/contracts';

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
  agencyId, agencyName, isOwner: false, membershipId: null, role: { key: 'custom', name: 'Papel' }, permissions
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
    owner: { membershipId: '99999999-9999-4999-8999-999999999999', name: 'Ana Souza' },
    coverAssetId: null,
    revision: 1,
    publishedOn: null,
    tasksTotal: 0,
    tasksApproved: 0,
    ...overrides,
    // As the API answers: the chosen cover is the file that serves as the cover, unless the test says another.
    thumbnailAssetId: 'thumbnailAssetId' in overrides ? overrides.thumbnailAssetId : (overrides.coverAssetId ?? null)
  };
};

const periodResponse = (contents: readonly unknown[], from: string, to: string): Response =>
  json({ data: { contents, storyScripts: [] }, meta: { from, to, count: contents.length } });

/** The answer of `PATCH .../contents/:contentId`: the whole content, as the API describes it. */
const detailOfContent = (clientId: string, row: ReturnType<typeof contentFixture>) => ({
  id: row.id,
  clientId,
  title: row.title,
  platform: row.platform,
  format: row.format,
  publishOn: row.publishOn,
  publishAtTime: row.publishAtTime,
  caption: null,
  folderId: 'f0f0f0f0-0000-4000-8000-000000000001',
  coverAssetId: row.coverAssetId,
  owner: row.owner,
  status: row.status,
  revision: row.revision,
  approvedBy: null,
  approvedAt: null,
  approvedByAgencyReason: null,
  publishedOn: row.publishedOn,
  cancelledAt: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  media: [],
  tasks: [],
  conversation: { threadId: null, commentCount: 0, lastCommentAt: null }
});

interface Scenario {
  /** The answer of `GET .../media/:assetId/download-url`; the default is a signed address of that asset. */
  readonly cover?: (assetId: string, search: string) => Response | Promise<Response> | undefined;
  /** The answer of `GET .../contents/:contentId` (the hover detail); the default is the bare content. */
  readonly content?: (clientId: string, contentId: string) => Response | Promise<Response> | undefined;
  /** The last comment of the conversation of a content, as `GET .../threads?contentId=` lists it; none by default. */
  readonly lastComment?: (contentId: string) => { side: 'agency' | 'client'; at: string; excerpt: string } | Response | Promise<Response> | undefined;
  /** Overrides the answer of a move, after the guard and the body were checked like the API does. */
  readonly patch?: (clientId: string, contentId: string, body: unknown, call: number) => Response | Promise<Response> | undefined;
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
  const patches: Array<{ clientId: string; contentId: string; body: unknown }> = [];
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
    const media = /\/agencies\/([^/]+)\/media\/([^/]+)\/download-url$/.exec(path);
    if (media !== null && method === 'GET') {
      // Reading a client's media follows conteudo.visualizar (#550); the portal never reaches this route.
      if (!permissions.includes(VISUALIZE)) return forbidden();
      // The API knows three variants; any other value is a 400.
      const variant = url.searchParams.get('variant');
      if (variant !== null && !['original', 'thumbnail', 'preview'].includes(variant)) return invalid();
      const custom = scenario.cover?.(media[2]!, url.search);
      if (custom !== undefined) return custom;
      return json({ url: `https://storage.test/${media[2]}.jpg`, expiresAt: '2026-10-12T01:45:00.000Z' });
    }
    const threads = /\/agencies\/([^/]+)\/clients\/([^/]+)\/threads$/.exec(path);
    if (threads !== null && method === 'GET') {
      // The conversation of a content is read with conteudo.visualizar; one subject is mandatory (#259).
      if (!permissions.includes(VISUALIZE)) return forbidden();
      if (!roster.some((client) => client.id === threads[2])) return notFound();
      const contentId = url.searchParams.get('contentId');
      if (contentId === null || !/^[0-9a-f-]{36}$/i.test(contentId)) return invalid();
      const answer = scenario.lastComment?.(contentId);
      if (answer instanceof Response || answer instanceof Promise) return answer;
      const data = answer === undefined ? [] : [{
        id: 'c1c1c1c1-0000-4000-8000-000000000001', subject: { contentId }, state: 'open',
        openedBy: { name: 'Pessoa', side: 'agency' }, lastComment: answer, commentCount: 3, resolvedBy: null, resolvedAt: null
      }];
      return json({ data, meta: { page: 1, pageSize: 20, totalItems: data.length, totalPages: 1 } });
    }
    const one = /\/agencies\/([^/]+)\/clients\/([^/]+)\/contents\/([^/]+)$/.exec(path);
    if (one !== null && method === 'GET') {
      if (!permissions.includes(VISUALIZE)) return forbidden();
      const custom = scenario.content?.(one[2]!, one[3]!);
      if (custom !== undefined) return custom;
      const row = scenario.contents?.[one[2]!]?.find((candidate) => candidate.id === one[3]);
      return row === undefined ? notFound() : json(detailOfContent(one[2]!, row));
    }
    if (one !== null && method === 'PATCH') {
      // The routes of the API need conteudo.operar and conteudo.visualizar together (decision 2026-10-11).
      if (!permissions.includes('conteudo.operar') || !permissions.includes(VISUALIZE)) return forbidden();
      const clientId = one[2]!;
      const contentId = one[3]!;
      const row = scenario.contents?.[clientId]?.find((candidate) => candidate.id === contentId);
      if (row === undefined) return notFound();
      const body = UpdateContentRequestSchema.safeParse(JSON.parse(String(init?.body)));
      if (!body.success) return invalid();
      patches.push({ clientId, contentId, body: body.data });
      const custom = scenario.patch?.(clientId, contentId, body.data, patches.length);
      if (custom !== undefined) return custom;
      if (row.status === 'published' || row.status === 'cancelled') return json({ error: { code: 'CONTENT_NOT_EDITABLE', message: 'This content can no longer be edited.' } }, 409);
      if (body.data.publishOn !== undefined) row.publishOn = body.data.publishOn;
      return json(detailOfContent(clientId, row));
    }
    const detail = /\/agencies\/([^/]+)\/clients\/([^/]+)$/.exec(path);
    if (detail !== null && method === 'GET') {
      if (!permissions.includes(READ_CLIENTS)) return forbidden();
      const custom = scenario.detail?.(detail[2]!);
      if (custom !== undefined) return custom;
      const client = roster.find((candidate) => candidate.id === detail[2]);
      return client === undefined ? notFound() : json(detailOf(client));
    }
    // The modal of a content reads the folders; only the screens that open it need them, and they answer empty.
    if (/\/media-folders(\/[^/]+\/assets)?$/.test(path) && method === 'GET') {
      return json({ data: [], meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 1 } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls, patches };
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

const render_ = (impl: typeof fetch, entry: string | { pathname: string; search?: string; state: unknown } = `/agencia/${AGENCY_A}/conteudos`) => {
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
    const names = within(nav).getAllByRole('link').map((link) => link.querySelector('.ui-client-strip__name')?.textContent);
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

describe('the ring on the stories (contentIndicators of #261)', () => {
  const indicators = (overrides: Partial<Record<'pending' | 'inReview' | 'overdue' | 'adjusting' | 'dueSoon', number>>) =>
    ({ pending: 0, inReview: 0, overdue: 0, adjusting: 0, dueSoon: 0, ...overrides });
  const withIndicators = (id: string, name: string, contentIndicators?: ReturnType<typeof indicators>) =>
    ({ ...clientFixture(id, name, null), ...(contentIndicators === undefined ? {} : { contentIndicators }) });
  const ringed = (link: HTMLElement): boolean => link.querySelector('.ui-avatar--attention') !== null;

  it.each([
    ['a change asked by the client (adjusting)', { adjusting: 1 }, 'em ajuste'],
    ['a content past its day (overdue)', { overdue: 2 }, 'em atraso'],
    ['a content due in two days (dueSoon)', { dueSoon: 1 }, 'com prazo em dois dias']
  ] as const)('draws the ring, and says why to a screen reader, for %s', async (_name, counts, reason) => {
    const ringedClient = withIndicators('5e5e5e5e-5555-4555-8555-555555555555', 'Cliente com Pedido', indicators(counts));
    const quiet = withIndicators('6f6f6f6f-6666-4666-8666-666666666666', 'Cliente Quieto', indicators({}));
    const { impl } = makeFetch({ roster: [ringedClient, quiet] });
    render_(impl);

    const link = await screen.findByRole('link', { name: new RegExp(`^Cliente com Pedido\\s*,\\s*${reason}$`) });
    expect(ringed(link)).toBe(true);
    expect(ringed(screen.getByRole('link', { name: 'Cliente Quieto' }))).toBe(false);
  });

  it('lists every reason that applies, and nothing for the flow itself (em produção and aguardando aprovação)', async () => {
    const everything = withIndicators('5e5e5e5e-5555-4555-8555-555555555555', 'Tudo Junto', indicators({ adjusting: 1, overdue: 1, dueSoon: 1 }));
    const flowOnly = withIndicators('6f6f6f6f-6666-4666-8666-666666666666', 'Só Fluxo', indicators({ pending: 7, inReview: 3 }));
    const unknown = withIndicators('7a7a7a7a-7777-4777-8777-777777777777', 'Sem Indicadores');
    const { impl } = makeFetch({ roster: [everything, flowOnly, unknown] });
    render_(impl);

    const all = await screen.findByRole('link', { name: /^Tudo Junto\s*,\s*em ajuste, em atraso, com prazo em dois dias$/ });
    expect(ringed(all)).toBe(true);
    expect(ringed(screen.getByRole('link', { name: 'Só Fluxo' }))).toBe(false);
    expect(ringed(screen.getByRole('link', { name: 'Sem Indicadores' }))).toBe(false);
  });

  it('keeps the ring on the client that is open, beside the others', async () => {
    const ringedClient = withIndicators(padaria.id, 'Padaria Central', indicators({ overdue: 1 }));
    const { impl } = makeFetch({ roster: [ringedClient, academia, barbearia, confeitaria] });
    render_(impl, contentsUrl(padaria.id));

    const link = await screen.findByRole('link', { name: /^Padaria Central\s*,\s*em atraso$/ });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(ringed(link)).toBe(true);
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
    expect(within(day).getAllByRole('article').map((card) => within(card).getByText(/./, { selector: '.content-card__link' }).textContent)).toEqual(['Lançamento do pão', 'Bastidores']);
    const launch = within(day).getByText('Lançamento do pão').closest('article')!;
    expect(within(launch).getByText('Carrossel')).toBeTruthy();
    expect(within(launch).getByText('18:00')).toBeTruthy();
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
    expect(container.querySelector('img:not([src^="/brand/"])')).toBeNull();
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

describe('moving a content to another day (drag)', () => {
  const OPERATE = [VISUALIZE, READ_CLIENTS, 'conteudo.operar'];
  const cardOf = (title: string): HTMLElement => {
    const card = screen.getByText(title).closest('article');
    if (card === null) throw new Error(`The card of ${title} was not rendered.`);
    return card;
  };
  const drag = (title: string, day: string): void => {
    fireEvent.dragStart(cardOf(title));
    fireEvent.dragOver(dayCell(day));
    fireEvent.drop(dayCell(day));
  };
  // A refusal to send is only proven after the time a send would take.
  const settle = (): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  const open = (rows: ReturnType<typeof contentFixture>[], scenario: Scenario = {}) => {
    const fake = makeFetch({ permissions: OPERATE, ...scenario, contents: { [padaria.id]: rows } });
    return { ...fake, ...render_(fake.impl, contentsUrl(padaria.id)) };
  };

  it('moves the card that was dragged and not the other one, sending only the new day to that content', async () => {
    const first = contentFixture({ title: 'Primeiro', publishOn: '2026-10-14' });
    const second = contentFixture({ title: 'Segundo', publishOn: '2026-10-14' });
    const { patches } = open([first, second]);
    await screen.findByText('Segundo');

    drag('Segundo', '2026-10-20');
    await waitFor(() => expect(within(dayCell('2026-10-20')).queryByText('Segundo')).not.toBeNull());
    expect(patches).toEqual([{ clientId: padaria.id, contentId: second.id, body: { publishOn: '2026-10-20' } }]);
    // The other one did not move, here or on the server.
    expect(within(dayCell('2026-10-14')).getByText('Primeiro')).toBeTruthy();
    expect(within(dayCell('2026-10-14')).queryByText('Segundo')).toBeNull();
    expect(first.publishOn).toBe('2026-10-14');
    expect(second.publishOn).toBe('2026-10-20');
  });

  it('lands on a day that already has a story script, and the script and its mark stay where they were', async () => {
    const traveller = contentFixture({ title: 'Viajante', publishOn: '2026-10-14' });
    const script = { id: '5c5c5c5c-5555-4555-8555-555555555555', scriptOn: '2026-10-20', status: 'draft' };
    const { patches } = open([traveller], {
      period: (_client, from, to) => {
        const rows = [traveller].filter((row) => row.publishOn >= from && row.publishOn <= to);
        return json({ data: { contents: rows, storyScripts: [script] }, meta: { from, to, count: rows.length + 1 } });
      }
    });
    await screen.findByText('Viajante');
    expect(within(dayCell('2026-10-20')).getByRole('button', { name: 'Stories · Rascunho' })).toBeTruthy();

    drag('Viajante', '2026-10-20');
    await waitFor(() => expect(within(dayCell('2026-10-20')).queryByText('Viajante')).not.toBeNull());
    expect(patches).toEqual([{ clientId: padaria.id, contentId: traveller.id, body: { publishOn: '2026-10-20' } }]);
    expect(within(dayCell('2026-10-20')).getByRole('button', { name: 'Stories · Rascunho' })).toBeTruthy();
    expect(within(dayCell('2026-10-14')).queryByRole('button', { name: /^Stories/ })).toBeNull();
    // The "+" of the day is there for the person who operates, beside the card that landed.
    expect(within(dayCell('2026-10-20')).getByRole('button', { name: /^Adicionar no dia/ })).toBeTruthy();
  });

  it('moves the first of two when the first is the one dragged', async () => {
    const first = contentFixture({ title: 'Primeiro', publishOn: '2026-10-14' });
    const second = contentFixture({ title: 'Segundo', publishOn: '2026-10-14' });
    const { patches } = open([first, second]);
    await screen.findByText('Primeiro');

    drag('Primeiro', '2026-10-21');
    await waitFor(() => expect(within(dayCell('2026-10-21')).queryByText('Primeiro')).not.toBeNull());
    expect(patches.map((patch) => patch.contentId)).toEqual([first.id]);
    expect(second.publishOn).toBe('2026-10-14');
  });

  it.each([['published', 'Publicado'], ['cancelled', 'Cancelado']] as const)('does not let a %s content be dragged, and lets the open one next to it', async (status, label) => {
    const closed = contentFixture({ title: 'Encerrado', publishOn: '2026-10-14', status, publishedOn: status === 'published' ? '2026-10-14' : null });
    const openOne = contentFixture({ title: 'Aberto', publishOn: '2026-10-14', status: 'approved' });
    const { patches } = open([closed, openOne]);
    await screen.findByText('Aberto');

    expect(within(cardOf('Encerrado')).getByText(label)).toBeTruthy();
    expect(cardOf('Encerrado').getAttribute('draggable')).toBe('false');
    expect(cardOf('Aberto').getAttribute('draggable')).toBe('true');
    drag('Encerrado', '2026-10-20');
    await settle();
    expect(patches).toEqual([]);
    expect(within(dayCell('2026-10-14')).getByText('Encerrado')).toBeTruthy();

    drag('Aberto', '2026-10-20');
    await waitFor(() => expect(patches.map((patch) => patch.contentId)).toEqual([openOne.id]));
  });

  it('lets each of the four open states be dragged', async () => {
    const rows = (['in_production', 'awaiting_approval', 'adjusting', 'approved'] as const).map((status) => contentFixture({ title: `Post ${status}`, publishOn: '2026-10-14', status }));
    open(rows);
    await screen.findByText('Post approved');
    for (const row of rows) expect(cardOf(row.title).getAttribute('draggable'), String(row.status)).toBe('true');
  });

  it('moves nothing for a person who can read but not operate contents', async () => {
    const row = contentFixture({ title: 'Só leitura', publishOn: '2026-10-14' });
    const { patches } = open([row], { permissions: [VISUALIZE, READ_CLIENTS] });
    await screen.findByText('Só leitura');

    expect(cardOf('Só leitura').getAttribute('draggable')).toBe('false');
    drag('Só leitura', '2026-10-20');
    await settle();
    expect(patches).toEqual([]);
    expect(within(dayCell('2026-10-14')).getByText('Só leitura')).toBeTruthy();
  });

  it('moves nothing on an archived client, and says the calendar is read only', async () => {
    const archived = clientFixture('5e5e5e5e-5555-4555-8555-555555555555', 'Cliente Arquivado', null, 'archived');
    const row = contentFixture({ title: 'Do arquivado', publishOn: '2026-10-14' });
    const fake = makeFetch({ permissions: OPERATE, roster: [...ROSTER, archived], contents: { [archived.id]: [row] } });
    render_(fake.impl, contentsUrl(archived.id));
    await screen.findByText('Do arquivado');

    expect(await screen.findByText('Cliente arquivado: o calendário é só leitura.')).toBeTruthy();
    expect(cardOf('Do arquivado').getAttribute('draggable')).toBe('false');
    drag('Do arquivado', '2026-10-20');
    await settle();
    expect(fake.patches).toEqual([]);
  });

  it('does not ask for anything when the card is dropped on its own day, or the drag is cancelled', async () => {
    const { patches } = open([contentFixture({ title: 'Parado', publishOn: '2026-10-14' })]);
    await screen.findByText('Parado');

    drag('Parado', '2026-10-14');
    fireEvent.dragStart(cardOf('Parado'));
    fireEvent.dragEnd(cardOf('Parado'));
    fireEvent.drop(dayCell('2026-10-20'));
    await settle();
    expect(patches).toEqual([]);
  });

  it('ignores a drop that no card of the calendar started', async () => {
    const { patches } = open([contentFixture({ title: 'Parado', publishOn: '2026-10-14' })]);
    await screen.findByText('Parado');

    fireEvent.dragOver(dayCell('2026-10-20'));
    fireEvent.drop(dayCell('2026-10-20'));
    await settle();
    expect(patches).toEqual([]);
  });

  it('moves once for one drag: a second drop that no new drag started moves nothing', async () => {
    const { patches } = open([contentFixture({ title: 'Uma vez', publishOn: '2026-10-14' })]);
    await screen.findByText('Uma vez');

    drag('Uma vez', '2026-10-20');
    await waitFor(() => expect(within(dayCell('2026-10-20')).queryByText('Uma vez')).not.toBeNull());
    fireEvent.dragOver(dayCell('2026-10-22'));
    fireEvent.drop(dayCell('2026-10-22'));
    await settle();
    expect(patches).toHaveLength(1);
  });

  it('accepts a day of the neighbouring month shown in the grid', async () => {
    const row = contentFixture({ title: 'Para novembro', publishOn: '2026-10-14' });
    const { patches } = open([row]);
    await screen.findByText('Para novembro');

    drag('Para novembro', '2026-11-01');
    await waitFor(() => expect(patches).toEqual([{ clientId: padaria.id, contentId: row.id, body: { publishOn: '2026-11-01' } }]));
  });

  it('holds every card still, and says it is moving, until the new period was read', async () => {
    const held = deferred<Response>();
    const rows = [contentFixture({ title: 'Em movimento', publishOn: '2026-10-14' }), contentFixture({ title: 'Ao lado', publishOn: '2026-10-15' })];
    const { patches } = open(rows, { patch: () => held.promise });
    await screen.findByText('Em movimento');

    drag('Em movimento', '2026-10-20');
    expect(await screen.findByText('Movendo conteúdo…')).toBeTruthy();
    expect(cardOf('Em movimento').getAttribute('aria-busy')).toBe('true');
    // One move at a time: nothing else can be picked up meanwhile.
    expect(cardOf('Ao lado').getAttribute('draggable')).toBe('false');
    expect(cardOf('Ao lado').getAttribute('aria-busy')).toBeNull();
    drag('Ao lado', '2026-10-21');
    await settle();
    expect(patches).toHaveLength(1);

    held.resolve(json(detailOfContent(padaria.id, rows[0]!)));
    await waitFor(() => expect(screen.queryByText('Movendo conteúdo…')).toBeNull());
    expect(cardOf('Ao lado').getAttribute('draggable')).toBe('true');
  });

  it('reads the period again after a move, so the card is where the server put it', async () => {
    const row = contentFixture({ title: 'Relido', publishOn: '2026-10-14' });
    const { calls } = open([row]);
    await screen.findByText('Relido');
    const before = periodCalls(calls).length;

    drag('Relido', '2026-10-20');
    await waitFor(() => expect(periodCalls(calls).length).toBe(before + 1));
    await waitFor(() => expect(within(dayCell('2026-10-20')).queryByText('Relido')).not.toBeNull());
  });

  it.each([
    ['409 CONTENT_NOT_EDITABLE', 409, 'CONTENT_NOT_EDITABLE', 'Este conteúdo já foi publicado ou cancelado e não pode mudar de data.'],
    ['409 CLIENT_ARCHIVED', 409, 'CLIENT_ARCHIVED', 'Este cliente está arquivado: o calendário é só leitura.'],
    ['403', 403, 'FORBIDDEN', 'Você não tem permissão para mover conteúdos.'],
    ['404', 404, 'NOT_FOUND', 'Este conteúdo não existe mais.'],
    ['500', 500, 'INTERNAL_ERROR', 'Não foi possível mover o conteúdo. Tente de novo.']
  ])('answers %s with its own words, keeps the card on its day and never shows the server text', async (_name, status, code, message) => {
    const row = contentFixture({ title: 'Recusado', publishOn: '2026-10-14' });
    open([row], { patch: () => json({ error: { code, message: '<b>texto do servidor</b>' } }, status) });
    await screen.findByText('Recusado');

    drag('Recusado', '2026-10-20');
    expect(await screen.findByText(message, undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText(/texto do servidor/)).toBeNull();
    expect(within(dayCell('2026-10-14')).getByText('Recusado')).toBeTruthy();
    expect(within(dayCell('2026-10-20')).queryByText('Recusado')).toBeNull();
  });

  it('clears the refusal when the period changes', async () => {
    const row = contentFixture({ title: 'Recusado', publishOn: '2026-10-14' });
    open([row], { patch: () => json({ error: { code: 'FORBIDDEN', message: 'no' } }, 403) });
    await screen.findByText('Recusado');
    drag('Recusado', '2026-10-20');
    await screen.findByText('Você não tem permissão para mover conteúdos.');

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await waitFor(() => expect(screen.queryByText('Você não tem permissão para mover conteúdos.')).toBeNull());
  });
});

const ASSET_A = 'a1a1a1a1-0000-4000-8000-000000000001';
const ASSET_B = 'a2a2a2a2-0000-4000-8000-000000000002';

/** Controls what the observer reports: nothing is on screen until a test says so. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: IntersectionObserverCallback) { FakeIntersectionObserver.instances.push(this); }
  observe(element: Element): void { this.observed.push(element); }
  unobserve(): void { /* unused */ }
  disconnect(): void { this.disconnected = true; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
  show(element: Element): void { this.callback([{ isIntersecting: true, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
  hide(element: Element): void { this.callback([{ isIntersecting: false, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
}

describe('the cover of a card', () => {
  const coverCalls = (calls: readonly string[]): string[] => calls.filter((call) => /\/download-url/.test(call));
  const cardOf = (title: string): HTMLElement => {
    const card = screen.getByText(title).closest('article');
    if (card === null) throw new Error(`The card of ${title} was not rendered.`);
    return card;
  };

  it('reads the thumbnail address of the cover of its own asset, never the original, and draws it without a text of its own', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Com capa', publishOn: '2026-10-14', coverAssetId: ASSET_A })] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Com capa');

    await waitFor(() => expect(cardOf('Com capa').querySelector('img')).not.toBeNull());
    expect(cardOf('Com capa').querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET_A}.jpg`);
    expect(cardOf('Com capa').querySelector('img')?.getAttribute('alt')).toBe('');
    expect(coverCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET_A}/download-url?variant=thumbnail`]);
  });

  it('draws the first media of a post that has no chosen cover, as the thumbnail of that asset (issue #606)', async () => {
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Post de imagem', publishOn: '2026-10-14', format: 'image', thumbnailAssetId: ASSET_A })] }
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Post de imagem');

    await waitFor(() => expect(cardOf('Post de imagem').querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET_A}.jpg`));
    expect(coverCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET_A}/download-url?variant=thumbnail`]);
  });

  it('asks for the frame of a reels that has no chosen cover as the thumbnail, never the video itself (issue #606)', async () => {
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Filme sem capa', publishOn: '2026-10-14', format: 'reels', coverAssetId: null, thumbnailAssetId: ASSET_B })] }
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Filme sem capa');

    await waitFor(() => expect(cardOf('Filme sem capa').querySelector('img')).not.toBeNull());
    expect(coverCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET_B}/download-url?variant=thumbnail`]);
  });

  it('keeps the shape of the format for a video that has no frame yet, and asks once (issue #606)', async () => {
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Sem quadro', publishOn: '2026-10-14', format: 'reels', thumbnailAssetId: ASSET_A })] },
      cover: () => json({ error: { code: 'VARIANT_NOT_READY', message: 'This variant has not been generated yet.' } }, 409)
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Sem quadro');

    await waitFor(() => expect(coverCalls(calls)).toHaveLength(1));
    await waitFor(() => expect(cardOf('Sem quadro').querySelector('.content-card__cover--placeholder')?.textContent).toBe('▶'));
    expect(cardOf('Sem quadro').querySelector('img')).toBeNull();
  });

  it('asks for nothing when the chosen cover was removed and no other media is left (thumbnail null with a cover id)', async () => {
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Capa removida', publishOn: '2026-10-14', format: 'reels', coverAssetId: ASSET_A, thumbnailAssetId: null })] }
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Capa removida');

    expect(cardOf('Capa removida').querySelector('.content-card__cover--placeholder')?.textContent).toBe('▶');
    expect(coverCalls(calls)).toEqual([]);
  });

  it('asks for nothing and shows the shape of the format when the content has no cover', async () => {
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Sem capa', publishOn: '2026-10-14', format: 'carousel' }), contentFixture({ title: 'Filme', publishOn: '2026-10-15', format: 'reels' })] }
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Sem capa');

    expect(cardOf('Sem capa').querySelector('img')).toBeNull();
    expect(cardOf('Sem capa').querySelector('.content-card__cover--placeholder')?.textContent).toBe('▤');
    expect(cardOf('Filme').querySelector('.content-card__cover--placeholder')?.textContent).toBe('▶');
    expect(coverCalls(calls)).toEqual([]);
  });

  it('keeps the placeholder, and the rest of the card, when the route says there is no thumbnail', async () => {
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Sem miniatura', publishOn: '2026-10-14', coverAssetId: ASSET_A, status: 'approved' })] },
      cover: () => json({ error: { code: 'VARIANT_NOT_READY', message: 'This variant has not been generated yet.' } }, 409)
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Sem miniatura');

    await waitFor(() => expect(cardOf('Sem miniatura').querySelector('.content-card__cover--placeholder')).not.toBeNull());
    expect(cardOf('Sem miniatura').querySelector('img')).toBeNull();
    expect(within(cardOf('Sem miniatura')).getByText('Pronto para publicar')).toBeTruthy();
  });

  it.each([[403, 'FORBIDDEN'], [404, 'NOT_FOUND']] as const)('keeps the placeholder when the route answers %s', async (status, code) => {
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Recusada', publishOn: '2026-10-14', coverAssetId: ASSET_A })] },
      cover: () => json({ error: { code, message: 'no' } }, status)
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Recusada');
    await waitFor(() => expect(cardOf('Recusada').querySelector('.content-card__cover--placeholder')).not.toBeNull());
    expect(cardOf('Recusada').querySelector('.content-card__cover--placeholder')?.textContent).toBe('▶');
    expect(cardOf('Recusada').querySelector('img')).toBeNull();
  });

  it('gives each card the cover of its own asset, and reads an asset used by two cards once', async () => {
    const { impl, calls } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ title: 'Um', publishOn: '2026-10-14', coverAssetId: ASSET_A }),
          contentFixture({ title: 'Dois', publishOn: '2026-10-15', coverAssetId: ASSET_B }),
          contentFixture({ title: 'Três', publishOn: '2026-10-16', coverAssetId: ASSET_A })
        ]
      }
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Três');

    await waitFor(() => expect(document.querySelectorAll('.content-card img')).toHaveLength(3));
    expect(cardOf('Um').querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET_A}.jpg`);
    expect(cardOf('Dois').querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET_B}.jpg`);
    expect(cardOf('Três').querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET_A}.jpg`);
    expect(coverCalls(calls).sort()).toEqual([
      `GET /agencies/${AGENCY_A}/media/${ASSET_A}/download-url?variant=thumbnail`,
      `GET /agencies/${AGENCY_A}/media/${ASSET_B}/download-url?variant=thumbnail`
    ]);
  });

  it('does not read an address again when the person leaves the period and comes back before it expires', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Volta', publishOn: '2026-10-14', coverAssetId: ASSET_A })] } });
    render_(impl, contentsUrl(padaria.id));
    await waitFor(() => expect(document.querySelector('.content-card img')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await screen.findByRole('heading', { name: 'Novembro 2026' });
    await waitFor(() => expect(document.querySelector('.content-card')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
    await waitFor(() => expect(document.querySelector('.content-card img')).not.toBeNull());
    expect(coverCalls(calls)).toHaveLength(1);
  });

  it('reads an expired address again', async () => {
    let issued = 0;
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Vencida', publishOn: '2026-10-14', coverAssetId: ASSET_A })] },
      // Expired a minute before "now" (2026-10-12T01:30:00Z): there is nothing left to cache.
      cover: () => { issued += 1; return json({ url: `https://storage.test/${issued}.jpg`, expiresAt: '2026-10-12T01:29:00.000Z' }); }
    });
    render_(impl, contentsUrl(padaria.id));
    await waitFor(() => expect(document.querySelector('.content-card img')).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await screen.findByRole('heading', { name: 'Novembro 2026' });
    await waitFor(() => expect(document.querySelector('.content-card')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
    await waitFor(() => expect(coverCalls(calls)).toHaveLength(2));
  });

  it('never makes an address that is not http(s), or a picture that fails to load, a cover', async () => {
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Script', publishOn: '2026-10-14', coverAssetId: ASSET_A }), contentFixture({ title: 'Quebrada', publishOn: '2026-10-15', coverAssetId: ASSET_B })] },
      cover: (assetId) => assetId === ASSET_A
        ? json({ url: 'data:text/html;base64,PHNjcmlwdD4=', expiresAt: '2026-10-12T01:45:00.000Z' })
        : undefined
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Quebrada');

    await waitFor(() => expect(cardOf('Quebrada').querySelector('img')).not.toBeNull());
    expect(cardOf('Script').querySelector('img')).toBeNull();
    expect(cardOf('Script').querySelector('.content-card__cover--placeholder')).not.toBeNull();
    fireEvent.error(cardOf('Quebrada').querySelector('img')!);
    await waitFor(() => expect(cardOf('Quebrada').querySelector('img')).toBeNull());
    expect(cardOf('Quebrada').querySelector('.content-card__cover--placeholder')).not.toBeNull();
  });

  describe('with an observer of what is on screen', () => {
    const original = globalThis.IntersectionObserver;
    beforeEach(() => {
      FakeIntersectionObserver.instances = [];
      globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    });
    afterEach(() => { globalThis.IntersectionObserver = original; });

    it('reads the address only once the card is on screen, and only for that card', async () => {
      const { impl, calls } = makeFetch({
        contents: { [padaria.id]: [contentFixture({ title: 'À vista', publishOn: '2026-10-14', coverAssetId: ASSET_A }), contentFixture({ title: 'Fora da tela', publishOn: '2026-10-15', coverAssetId: ASSET_B })] }
      });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Fora da tela');
      await waitFor(() => expect(FakeIntersectionObserver.instances.length).toBeGreaterThanOrEqual(2));
      expect(coverCalls(calls)).toEqual([]);

      const visible = FakeIntersectionObserver.instances.find((observer) => cardOf('À vista').contains(observer.observed[0] ?? null))!;
      // A report that the card is out of the screen is not sight.
      act(() => visible.hide(visible.observed[0]!));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
      expect(coverCalls(calls)).toEqual([]);
      act(() => visible.show(visible.observed[0]!));
      await waitFor(() => expect(coverCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET_A}/download-url?variant=thumbnail`]));
      expect(cardOf('Fora da tela').querySelector('img')).toBeNull();
    });

    it('stops observing a card once it was seen, and when the screen goes away', async () => {
      const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Observada', publishOn: '2026-10-14', coverAssetId: ASSET_A })] } });
      const { unmount } = render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Observada');
      await waitFor(() => expect(FakeIntersectionObserver.instances.length).toBeGreaterThanOrEqual(1));
      const observer = FakeIntersectionObserver.instances.at(-1)!;
      expect(observer.disconnected).toBe(false);

      act(() => observer.show(observer.observed[0]!));
      await waitFor(() => expect(observer.disconnected).toBe(true));
      unmount();
      expect(FakeIntersectionObserver.instances.every((instance) => instance.disconnected)).toBe(true);
    });
  });
});

describe('the detail on a card (hover and focus)', () => {
  const cardOf = (title: string): HTMLElement => {
    const card = screen.getByText(title).closest('article');
    if (card === null) throw new Error(`The card of ${title} was not rendered.`);
    return card;
  };
  const detailCalls = (calls: readonly string[]): string[] => calls.filter((call) => /\/contents\/[^/?]+$/.test(call) && call.startsWith('GET'));
  const withDetail = (row: ReturnType<typeof contentFixture>, extra: Record<string, unknown>) => (_client: string, id: string) =>
    id === row.id ? json({ ...detailOfContent(padaria.id, row), ...extra }) : undefined;

  it('reads nothing until a card is pointed at, then shows the start of the caption, the subtasks and the conversation', async () => {
    const row = contentFixture({ title: 'Lançamento', publishOn: '2026-10-14', tasksTotal: 4, tasksApproved: 2 });
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [row] },
      content: withDetail(row, {
        caption: 'Hoje tem pão quente na padaria!',
        tasks: ['approved', 'approved', 'delivered', 'pending'].map((status, index) => ({
          id: `b0b0b0b0-0000-4000-8000-00000000000${index}`, title: `Tarefa ${index}`, description: null, assignee: row.owner, dueOn: '2026-10-13', status, returnComment: null, approvedBy: null, approvedAt: null
        })),
        conversation: { threadId: 'c1c1c1c1-0000-4000-8000-000000000001', commentCount: 3, lastCommentAt: '2026-10-12T01:30:00.000Z' }
      }),
      lastComment: () => ({ side: 'client', at: '2026-10-12T01:30:00.000Z', excerpt: 'Podemos trocar a foto da capa?' })
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Lançamento');
    expect(detailCalls(calls)).toEqual([]);
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseEnter(cardOf('Lançamento'));
    const tooltip = await screen.findByRole('tooltip');
    expect(await within(tooltip).findByText('Hoje tem pão quente na padaria!')).toBeTruthy();
    expect(within(tooltip).getByText('Legenda')).toBeTruthy();
    expect(within(tooltip).getByText('2 de 4 aprovadas · 1 entregue · 1 pendente')).toBeTruthy();
    // 01:30Z of the 12th is still the 11th in São Paulo.
    expect(within(tooltip).getByText('3 comentários · último em 11/10')).toBeTruthy();
    expect(await within(tooltip).findByText('Cliente: “Podemos trocar a foto da capa?” · 11/10')).toBeTruthy();
    expect(calls).toContain(`GET /agencies/${AGENCY_A}/clients/${padaria.id}/threads?contentId=${row.id}`);
    expect(cardOf('Lançamento').getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(detailCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/clients/${padaria.id}/contents/${row.id}`]);

    fireEvent.mouseLeave(cardOf('Lançamento'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(cardOf('Lançamento').getAttribute('aria-describedby')).toBeNull();
  });

  const withComments = (row: ReturnType<typeof contentFixture>, count = 2) =>
    withDetail(row, { conversation: { threadId: 'c1c1c1c1-0000-4000-8000-000000000001', commentCount: count, lastCommentAt: '2026-10-12T01:30:00.000Z' } });
  const threadCalls = (calls: readonly string[]): string[] => calls.filter((call) => /\/threads\?/.test(call));

  it('asks for the last message only of the content that was pointed at, and only when it has comments', async () => {
    const withTalk = contentFixture({ title: 'Com conversa', publishOn: '2026-10-14' });
    const quiet = contentFixture({ title: 'Sem conversa', publishOn: '2026-10-15' });
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [withTalk, quiet] },
      content: withComments(withTalk),
      lastComment: () => ({ side: 'agency', at: '2026-10-12T12:00:00.000Z', excerpt: 'Enviamos a arte nova.' })
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Com conversa');
    expect(threadCalls(calls)).toEqual([]);

    fireEvent.mouseEnter(cardOf('Sem conversa'));
    await within(await screen.findByRole('tooltip')).findByText('Sem comentários');
    expect(threadCalls(calls)).toEqual([]);
    fireEvent.mouseLeave(cardOf('Sem conversa'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());

    fireEvent.mouseEnter(cardOf('Com conversa'));
    const tooltip = await screen.findByRole('tooltip');
    expect(await within(tooltip).findByText('Agência: “Enviamos a arte nova.” · 12/10')).toBeTruthy();
    expect(threadCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/clients/${padaria.id}/threads?contentId=${withTalk.id}`]);
  });

  it('shows the message of the card that was pointed at, not of another card', async () => {
    const first = contentFixture({ title: 'Primeiro', publishOn: '2026-10-14' });
    const second = contentFixture({ title: 'Segundo', publishOn: '2026-10-15' });
    const { impl } = makeFetch({
      contents: { [padaria.id]: [first, second] },
      content: (client, id) => withComments(id === first.id ? first : second)(client, id),
      lastComment: (contentId) => ({ side: 'client', at: '2026-10-12T12:00:00.000Z', excerpt: contentId === first.id ? 'Fala do primeiro' : 'Fala do segundo' })
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Segundo');

    // The first card is read before, so a cache that ignored the content would answer the second with its message.
    fireEvent.mouseEnter(cardOf('Primeiro'));
    expect(await within(await screen.findByRole('tooltip')).findByText(/Fala do primeiro/)).toBeTruthy();
    fireEvent.mouseLeave(cardOf('Primeiro'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());

    fireEvent.mouseEnter(cardOf('Segundo'));
    const tooltip = await screen.findByRole('tooltip');
    expect(await within(tooltip).findByText(/Fala do segundo/)).toBeTruthy();
    expect(within(tooltip).queryByText(/Fala do primeiro/)).toBeNull();
  });

  it('says "carregando" while the message is read, and keeps the rest of the detail when the route refuses', async () => {
    const row = contentFixture({ title: 'Texto', publishOn: '2026-10-14' });
    const answer = deferred<Response>();
    const { impl } = makeFetch({
      contents: { [padaria.id]: [row] },
      content: withComments(row),
      lastComment: () => answer.promise
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Texto');

    fireEvent.mouseEnter(cardOf('Texto'));
    const tooltip = await screen.findByRole('tooltip');
    expect(await within(tooltip).findByText('Carregando…')).toBeTruthy();
    await act(async () => { answer.resolve(json({ error: { code: 'FORBIDDEN', message: 'Forbidden <b>x</b>' } }, 403)); });
    expect(await within(tooltip).findByText('Não foi possível carregar a última mensagem.')).toBeTruthy();
    expect(within(tooltip).getByText('2 comentários · último em 11/10')).toBeTruthy();
    expect(tooltip.textContent).not.toContain('Forbidden');
  });

  it('never turns the text of a message into markup', async () => {
    const row = contentFixture({ title: 'Marcação', publishOn: '2026-10-14' });
    const { impl } = makeFetch({
      contents: { [padaria.id]: [row] },
      content: withComments(row),
      lastComment: () => ({ side: 'client', at: '2026-10-12T12:00:00.000Z', excerpt: '<img src=x onerror=alert(1)> <b>oi</b>' })
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Marcação');

    fireEvent.mouseEnter(cardOf('Marcação'));
    const tooltip = await screen.findByRole('tooltip');
    expect(await within(tooltip).findByText(/<img src=x onerror=alert\(1\)> <b>oi<\/b>/)).toBeTruthy();
    expect(tooltip.querySelector('img')).toBeNull();
    expect(tooltip.querySelector('b')).toBeNull();
  });

  it('says the empty cases in words: no caption, no subtasks, no comments', async () => {
    const row = contentFixture({ title: 'Vazio', publishOn: '2026-10-14' });
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Vazio');

    fireEvent.mouseEnter(cardOf('Vazio'));
    const tooltip = await screen.findByRole('tooltip');
    expect(await within(tooltip).findByText('Sem legenda')).toBeTruthy();
    expect(within(tooltip).getByText('Sem subtarefas')).toBeTruthy();
    expect(within(tooltip).getByText('Sem comentários')).toBeTruthy();
  });

  it('cuts a long caption at 140 characters and keeps the singular of one comment and one subtask', async () => {
    const row = contentFixture({ title: 'Longa', publishOn: '2026-10-14' });
    const { impl } = makeFetch({
      contents: { [padaria.id]: [row] },
      content: withDetail(row, {
        caption: `${'a'.repeat(140)}b\n\nfim`,
        tasks: [{ id: 'b0b0b0b0-0000-4000-8000-000000000001', title: 'T', description: null, assignee: row.owner, dueOn: '2026-10-13', status: 'pending', returnComment: null, approvedBy: null, approvedAt: null }],
        conversation: { threadId: 'c1c1c1c1-0000-4000-8000-000000000001', commentCount: 1, lastCommentAt: null }
      })
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Longa');

    fireEvent.mouseEnter(cardOf('Longa'));
    const tooltip = await screen.findByRole('tooltip');
    expect(await within(tooltip).findByText(`${'a'.repeat(140)}…`)).toBeTruthy();
    expect(within(tooltip).getByText('0 de 1 aprovadas · 1 pendente')).toBeTruthy();
    expect(within(tooltip).getByText('1 comentário')).toBeTruthy();
  });

  it('shows the detail of the card pointed at, not of its neighbour, and reads each content once', async () => {
    const first = contentFixture({ title: 'Primeira', publishOn: '2026-10-14' });
    const second = contentFixture({ title: 'Segunda', publishOn: '2026-10-14' });
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [first, second] },
      content: (_client, id) => json({ ...detailOfContent(padaria.id, id === first.id ? first : second), caption: id === first.id ? 'Legenda da primeira' : 'Legenda da segunda' })
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Segunda');

    fireEvent.mouseEnter(cardOf('Segunda'));
    expect(await screen.findByText('Legenda da segunda')).toBeTruthy();
    expect(screen.queryByText('Legenda da primeira')).toBeNull();
    fireEvent.mouseLeave(cardOf('Segunda'));
    fireEvent.mouseEnter(cardOf('Primeira'));
    expect(await screen.findByText('Legenda da primeira')).toBeTruthy();
    expect(screen.queryByText('Legenda da segunda')).toBeNull();
    // Back on the first one: it was read already.
    fireEvent.mouseLeave(cardOf('Primeira'));
    fireEvent.mouseEnter(cardOf('Segunda'));
    expect(await screen.findByText('Legenda da segunda')).toBeTruthy();
    expect(detailCalls(calls).sort()).toEqual([
      `GET /agencies/${AGENCY_A}/clients/${padaria.id}/contents/${first.id}`,
      `GET /agencies/${AGENCY_A}/clients/${padaria.id}/contents/${second.id}`
    ].sort());
  });

  it('opens with the keyboard focus too, and closes with Escape', async () => {
    const row = contentFixture({ title: 'Teclado', publishOn: '2026-10-14' });
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Teclado');

    expect(cardOf('Teclado').getAttribute('tabindex')).toBe('0');
    fireEvent.focus(cardOf('Teclado'));
    expect(await screen.findByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(cardOf('Teclado'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    fireEvent.focus(cardOf('Teclado'));
    await screen.findByRole('tooltip');
    fireEvent.blur(cardOf('Teclado'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('says it is loading, and says when it could not load', async () => {
    const held = deferred<Response>();
    const row = contentFixture({ title: 'Lenta', publishOn: '2026-10-14' });
    const slow = makeFetch({ contents: { [padaria.id]: [row] }, content: () => held.promise });
    const first = render_(slow.impl, contentsUrl(padaria.id));
    await screen.findByText('Lenta');
    fireEvent.mouseEnter(cardOf('Lenta'));
    expect(await screen.findByText('Carregando detalhes…')).toBeTruthy();
    held.resolve(json(detailOfContent(padaria.id, row)));
    expect(await screen.findByText('Sem legenda')).toBeTruthy();
    first.unmount();

    const failing = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Falha', publishOn: '2026-10-14' })] }, content: () => notFound() });
    render_(failing.impl, contentsUrl(padaria.id));
    await screen.findByText('Falha');
    fireEvent.mouseEnter(cardOf('Falha'));
    expect(await screen.findByText('Não foi possível carregar os detalhes.')).toBeTruthy();
  });

  it('renders the caption as text, never as markup', async () => {
    const row = contentFixture({ title: 'Hostil', publishOn: '2026-10-14' });
    const hostile = '<img src=x onerror="document.title=1"><b>negrito</b>';
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] }, content: withDetail(row, { caption: hostile }) });
    const { container } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Hostil');

    fireEvent.mouseEnter(cardOf('Hostil'));
    expect(await screen.findByText(hostile)).toBeTruthy();
    expect(container.querySelector('.content-card__detail b')).toBeNull();
    expect(container.querySelector('.content-card__detail img')).toBeNull();
  });

  it('closes the detail when the card is picked up to be dragged', async () => {
    const row = contentFixture({ title: 'Levantada', publishOn: '2026-10-14' });
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS, 'conteudo.operar'], contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Levantada');

    fireEvent.mouseEnter(cardOf('Levantada'));
    await screen.findByRole('tooltip');
    fireEvent.dragStart(cardOf('Levantada'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  it('shows the name of the responsible of the card that is pointed at, never the link behind it (#552)', async () => {
    const ana = contentFixture({ title: 'Da Ana', publishOn: '2026-10-14' });
    const paulo = contentFixture({ title: 'Do Paulo', publishOn: '2026-10-14', owner: { membershipId: 'e0e0e0e0-0000-4000-8000-000000000002', name: 'Paulo Lima' } });
    const { impl } = makeFetch({ contents: { [padaria.id]: [ana, paulo] } });
    const { container } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Do Paulo');

    fireEvent.mouseEnter(cardOf('Do Paulo'));
    const detail = await screen.findByRole('tooltip');
    expect(await within(detail).findByText('Responsável')).toBeTruthy();
    expect(within(detail).getByText('Paulo Lima')).toBeTruthy();
    expect(within(detail).queryByText('Ana Souza')).toBeNull();
    expect(container.textContent).not.toContain('e0e0e0e0-0000-4000-8000-000000000002');
    fireEvent.mouseLeave(cardOf('Do Paulo'));

    fireEvent.mouseEnter(cardOf('Da Ana'));
    expect(await within(await screen.findByRole('tooltip')).findByText('Ana Souza')).toBeTruthy();
  });

  it('shows no responsible for a content whose person has no link to the agency (owner null)', async () => {
    const row = contentFixture({ title: 'Sem vínculo', publishOn: '2026-10-14', owner: null });
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Sem vínculo');

    fireEvent.mouseEnter(cardOf('Sem vínculo'));
    await screen.findByText('Sem legenda');
    expect(screen.queryByText('Responsável')).toBeNull();
  });
});

describe('the Conteúdos tab of the client (#272)', () => {
  const tabUrl = (search = '') => `/agencia/${AGENCY_A}/clientes/${padaria.id}/conteudos${search}`;
  const tabNav = (): HTMLElement => screen.getByRole('navigation', { name: 'Seções do cliente' });
  const treino = () => contentFixture({ title: 'Treino da semana', publishOn: '2026-10-14' });
  const ROSTER_ADDRESS = `/agencia/${AGENCY_A}/clientes?search=padaria&page=2`;
  const OPERATOR = [VISUALIZE, READ_CLIENTS, 'conteudo.operar'];

  it('gives the tab to who reads contents, and opens the calendar of that client with no stories and no second client header', async () => {
    const row = treino();
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [row] } });
    const { probe } = render_(impl, `/agencia/${AGENCY_A}/clientes/${padaria.id}/geral`);

    const link = await within(await screen.findByRole('navigation', { name: 'Seções do cliente' })).findByRole('link', { name: 'Conteúdos' });
    fireEvent.click(link);
    await waitFor(() => expect(probe.pathname).toBe(tabUrl()));
    expect(await screen.findByText('Treino da semana')).toBeTruthy();
    expect(within(tabNav()).getByRole('link', { name: 'Conteúdos' }).getAttribute('aria-current')).toBe('page');
    expect(calls).toContain(periodCall(padaria.id, OCTOBER.from, OCTOBER.to));
    expect(screen.queryByRole('navigation', { name: 'Clientes' })).toBeNull();
    expect(calls.filter((call) => /\/clients\?/.test(call))).toEqual([]);
    expect(screen.getAllByRole('heading', { name: 'Padaria Central' })).toHaveLength(1);
    expect(screen.getByRole('complementary', { name: 'Prévia do feed' })).toBeTruthy();
    expect(document.title).toBe('Padaria Central — Ageniza');
  });

  it('draws the skeleton while the period loads and the empty state when it has nothing, as the screen does', async () => {
    const gate = deferred<Response>();
    const { impl } = makeFetch({ period: () => gate.promise });
    render_(impl, tabUrl());
    await screen.findByRole('heading', { name: 'Padaria Central' });
    await waitFor(() => expect(document.querySelector('.contents__skeleton')?.getAttribute('aria-hidden')).toBe('true'));
    expect(screen.queryByText('Nenhum conteúdo planejado neste período.')).toBeNull();
    gate.resolve(periodResponse([], OCTOBER.from, OCTOBER.to));
    expect(await screen.findByText('Nenhum conteúdo planejado neste período.')).toBeTruthy();
    expect(document.querySelector('.contents__skeleton')).toBeNull();
  });

  it('keeps the client of the address fixed while the views change: feed, week and back', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [treino()] } });
    const { probe } = render_(impl, tabUrl());
    await screen.findByText('Treino da semana');

    fireEvent.click(screen.getByRole('tab', { name: 'Feed' }));
    await waitFor(() => expect(probe.search).toBe('?vista=feed'));
    expect(probe.pathname).toBe(tabUrl());
    expect(await screen.findByRole('region', { name: 'Prévia do feed' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Calendário' }));
    fireEvent.click(screen.getByRole('button', { name: 'Semana' }));
    await waitFor(() => expect(probe.search).toBe('?visao=semana'));
    expect(probe.pathname).toBe(tabUrl());
    await waitFor(() => expect(periodCalls(calls).some((call) => call.includes('from=2026-10-05&to=2026-10-11'))).toBe(true));
    expect(periodCalls(calls).every((call) => call.includes(`/clients/${padaria.id}/`))).toBe(true);
  });

  // Vendas and Financeiro hold neither content permission; each row is a role with permissions that never include conteudo.visualizar.
  it.each([
    ['cliente.visualizar only (Vendas)', [READ_CLIENTS]],
    ['conteudo.operar, without visualizar', [READ_CLIENTS, 'conteudo.operar']],
    ['cliente.visualizar and financeiro.visualizar (Financeiro)', [READ_CLIENTS, 'financeiro.visualizar']]
  ])('has no tab, and every address of it is "não encontrado" without the client behind it: %s', async (_name, permissions) => {
    const row = treino();
    const { impl, calls } = makeFetch({ permissions, contents: { [padaria.id]: [row] } });
    const { unmount } = render_(impl, `/agencia/${AGENCY_A}/clientes/${padaria.id}/geral`);
    await screen.findByRole('heading', { name: 'Padaria Central' });
    expect(within(tabNav()).queryByRole('link', { name: 'Conteúdos' })).toBeNull();
    expect(within(tabNav()).getAllByRole('link').map((item) => item.textContent)).toEqual(['Geral', 'Tarefas', 'Estudo de marca', 'Relatórios']);
    unmount();

    for (const address of [tabUrl(), `${tabUrl()}/novo`, `${tabUrl()}/${row.id}`, tabUrl('?vista=pastas')]) {
      const view = render_(impl, address);
      expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Padaria Central' })).toBeNull();
      view.unmount();
    }
    expect(calls.filter((call) => /\/contents|\/media-folders|\/threads/.test(call))).toEqual([]);
  });

  it('goes to the screen of Conteúdos and back keeping the client, the period and the roster address', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [treino()] } });
    const { probe } = render_(impl, { pathname: tabUrl(), search: '?visao=semana&data=2026-10-14', state: { clientListUrl: ROSTER_ADDRESS } });
    await screen.findByText('Treino da semana');
    const back = (): HTMLElement => screen.getByRole('link', { name: '← Clientes' });
    expect(back().getAttribute('href')).toBe(ROSTER_ADDRESS);

    const toScreen = screen.getByRole('link', { name: 'Abrir na tela de Conteúdos' });
    expect(toScreen.getAttribute('href')).toBe(`${contentsUrl(padaria.id)}?visao=semana&data=2026-10-14`);
    fireEvent.click(toScreen);
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(padaria.id)));
    expect(probe.search).toBe('?visao=semana&data=2026-10-14');
    expect(probe.state).toEqual({ clientListUrl: ROSTER_ADDRESS });
    expect(await screen.findByRole('navigation', { name: 'Clientes' })).toBeTruthy();
    expect(await screen.findByText('Treino da semana')).toBeTruthy();

    const toTab = screen.getByRole('link', { name: 'Abrir no cadastro do cliente' });
    expect(toTab.getAttribute('href')).toBe(`${tabUrl()}?visao=semana&data=2026-10-14`);
    fireEvent.click(toTab);
    await waitFor(() => expect(probe.pathname).toBe(tabUrl()));
    expect(probe.search).toBe('?visao=semana&data=2026-10-14');
    expect(probe.state).toEqual({ clientListUrl: ROSTER_ADDRESS });
    expect((await screen.findByRole('link', { name: '← Clientes' })).getAttribute('href')).toBe(ROSTER_ADDRESS);
  });

  it('opens a content inside the tab, and closing it comes back to the same tab, period and roster address', async () => {
    const row = treino();
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] } });
    const { probe } = render_(impl, { pathname: tabUrl(), search: '?visao=semana&data=2026-10-14', state: { clientListUrl: ROSTER_ADDRESS } });

    const card = await screen.findByRole('link', { name: 'Treino da semana' });
    expect(card.getAttribute('href')).toBe(`${tabUrl()}/${row.id}?visao=semana&data=2026-10-14`);
    fireEvent.click(card);
    await waitFor(() => expect(probe.pathname).toBe(`${tabUrl()}/${row.id}`));
    expect(probe.search).toBe('?visao=semana&data=2026-10-14');
    expect(probe.state).toEqual({ clientListUrl: ROSTER_ADDRESS });

    fireEvent.click(await screen.findByRole('button', { name: 'Fechar conteúdo' }));
    await waitFor(() => expect(probe.pathname).toBe(tabUrl()));
    expect(probe.search).toBe('?visao=semana&data=2026-10-14');
    expect(probe.state).toEqual({ clientListUrl: ROSTER_ADDRESS });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('creates a content from the tab, on an address of the tab, and closing comes back to it', async () => {
    const { impl } = makeFetch({ permissions: OPERATOR, contents: { [padaria.id]: [treino()] } });
    const { probe } = render_(impl, { pathname: tabUrl(), search: '?data=2026-10-14', state: { clientListUrl: ROSTER_ADDRESS } });
    await screen.findByText('Treino da semana');

    fireEvent.click(await screen.findByRole('button', { name: 'Nova publicação' }));
    await waitFor(() => expect(probe.pathname).toBe(`${tabUrl()}/novo`));
    // The form of a new content, not the reading of a content called "novo": the route of the creation is in the tab.
    const modal = await screen.findByRole('dialog', { name: 'Novo conteúdo' });
    expect(await within(modal).findByRole('button', { name: 'Criar conteúdo' })).toBeTruthy();
    expect((within(modal).getByLabelText('Título') as HTMLInputElement).value).toBe('');
    expect(new URLSearchParams(probe.search).get('dia')).toBe(TODAY);
    expect(new URLSearchParams(probe.search).get('data')).toBe('2026-10-14');
    expect(probe.state).toEqual({ clientListUrl: ROSTER_ADDRESS });

    fireEvent.click(await screen.findByRole('button', { name: 'Fechar conteúdo' }));
    await waitFor(() => expect(probe.pathname).toBe(tabUrl()));
    expect(new URLSearchParams(probe.search).get('dia')).toBeNull();
    expect(probe.state).toEqual({ clientListUrl: ROSTER_ADDRESS });
  });

  it('keeps the screen of Conteúdos on its own addresses: the card and the modal stay in /conteudos', async () => {
    const row = treino();
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] } });
    const { probe } = render_(impl, contentsUrl(padaria.id));
    const card = await screen.findByRole('link', { name: 'Treino da semana' });
    expect(card.getAttribute('href')).toBe(`${contentsUrl(padaria.id)}/${row.id}`);
    fireEvent.click(card);
    await waitFor(() => expect(probe.pathname).toBe(`${contentsUrl(padaria.id)}/${row.id}`));
    fireEvent.click(await screen.findByRole('button', { name: 'Fechar conteúdo' }));
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(padaria.id)));
  });
});

describe('the header and the grid of the calendar', () => {
  it('names the screen with a large title and says what it is for, and keeps "Conteúdos" as the heading of the page', async () => {
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS, 'conteudo.operar'] });
    render_(impl, contentsUrl(padaria.id));
    await calendarReady();

    expect(screen.getByRole('heading', { name: 'Calendário Editorial' })).toBeTruthy();
    expect(screen.getByText('Planeje, agende e acompanhe todas as publicações.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Conteúdos' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Nova publicação' })).toBeTruthy();
  });

  describe('the card of a post', () => {
    const cardTitled = (title: string): HTMLElement => screen.getByText(title).closest('article')!;

    it.each([
      ['carousel', 'carousel', 'Carrossel'], ['reels', 'reels', 'Reels'], ['image', 'static', 'Imagem'], ['long_video', 'static', 'Vídeo longo'], ['vsl', 'static', 'VSL']
    ] as const)('tints a %s card as %s and names the format in front of the title and in a filled tag', async (format, tone, label) => {
      const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Um post', publishOn: '2026-10-20', format })] } });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Um post');

      const card = cardTitled('Um post');
      expect(card.getAttribute('data-format')).toBe(tone);
      expect(card.querySelector('.content-card__title')?.textContent).toBe(`${label}: Um post`);
      expect(card.querySelector(`.ui-format-tag--${tone}`)?.textContent).toBe(label);
    });

    it.each([
      ['in_production', 'production', 'Em produção'], ['awaiting_approval', 'waiting', 'Aguardando aprovação'], ['adjusting', 'adjust', 'Em ajuste'],
      ['approved', 'ready', 'Pronto para publicar'], ['published', 'published', 'Publicado'], ['cancelled', 'production', 'Cancelado']
    ] as const)('draws the state %s as an outlined tag of the %s kind, with its words', async (status, kind, label) => {
      const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Estado', publishOn: '2026-10-25', status })] } });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Estado');

      const tag = cardTitled('Estado').querySelector(`.ui-status-tag--${kind}`);
      expect(tag?.textContent).toBe(label);
      expect(tag?.querySelector('svg')).not.toBeNull();
    });

    it('puts the solid "Atrasado" block, and the red edge, only on a late card, and keeps its state tag', async () => {
      const { impl } = makeFetch({
        contents: { [padaria.id]: [
          contentFixture({ title: 'Passou', publishOn: '2026-10-10', status: 'approved' }),
          contentFixture({ title: 'Em dia', publishOn: '2026-10-25', status: 'approved' }),
          contentFixture({ title: 'Publicado antigo', publishOn: '2026-10-05', status: 'published' }),
          contentFixture({ title: 'Quase lá', publishOn: '2026-10-13', status: 'in_production' })
        ] }
      });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Passou');

      const late = cardTitled('Passou');
      expect(late.getAttribute('data-late')).toBe('true');
      expect(late.querySelector('.ui-late-badge')?.textContent).toBe('Atrasado');
      expect(within(late).getByText('Pronto para publicar')).toBeTruthy();
      for (const title of ['Em dia', 'Publicado antigo', 'Quase lá']) {
        expect(cardTitled(title).getAttribute('data-late')).toBeNull();
        expect(cardTitled(title).querySelector('.ui-late-badge')).toBeNull();
      }
    });

    it('is text only when the post has no media, and keeps the cover when it has one', async () => {
      const { impl } = makeFetch({
        contents: { [padaria.id]: [
          contentFixture({ title: 'Sem mídia', publishOn: '2026-10-20', format: 'carousel' }),
          contentFixture({ title: 'Com mídia', publishOn: '2026-10-21', format: 'carousel', coverAssetId: ASSET_A })
        ] }
      });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Sem mídia');

      expect(cardTitled('Sem mídia').querySelector('.content-card__cover--bare')).not.toBeNull();
      expect(cardTitled('Com mídia').querySelector('.content-card__cover--bare')).toBeNull();
      expect(cardTitled('Com mídia').querySelector('.content-card__cover')).not.toBeNull();
    });

    it('shows the time of a post on its own line, and nothing when it has none', async () => {
      const { impl } = makeFetch({
        contents: { [padaria.id]: [contentFixture({ title: 'Com hora', publishOn: '2026-10-20', publishAtTime: '09:30' }), contentFixture({ title: 'Sem hora', publishOn: '2026-10-21' })] }
      });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Com hora');

      expect(cardTitled('Com hora').querySelector('.content-card__meta')?.textContent).toBe('09:30');
      expect(cardTitled('Sem hora').querySelector('.content-card__meta')).toBeNull();
    });
  });

  describe('CSS contract', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
      selectors: match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((selector) => selector.trim()),
      body: match[2]!
    }));
    const body = (selector: string): string => rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body).join('\n');

    it('fills only the number of today with the action colour and says "hoje" beside it', () => {
      expect(body(".content-day--today .content-day__number span[aria-hidden='true']")).toMatch(/background:\s*var\(--action-primary-bg\)/);
      expect(body('.content-day--today .content-day__number::after')).toMatch(/content:\s*' hoje'/);
      expect(body('.content-day__number')).not.toMatch(/--action-primary-bg/);
    });

    it('shows the "+" of the day on hover and on focus, and always where there is no hover', () => {
      expect(body('.content-day__tools .ui-menu__trigger')).toMatch(/opacity:\s*0;/);
      const shown = rules.find((rule) => rule.selectors.includes('.content-day:hover .ui-menu__trigger') && rule.selectors.includes('.content-day:focus-within .ui-menu__trigger'));
      expect(shown?.body).toMatch(/opacity:\s*1;/);
      expect(css).toMatch(/@media \(hover: none\)\s*\{\s*\.content-day__tools \.ui-menu__trigger\s*\{\s*opacity:\s*1;/);
    });

    it('lets the grid scroll inside the panel at phone width: the panel track shrinks and only the grid keeps its width', () => {
      expect(body('.contents__panel')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
      expect(body('.contents__panel')).toMatch(/overflow:\s*hidden;/);
      expect(body('.content-calendar')).toMatch(/overflow-x:\s*auto;/);
      expect(body('.content-calendar')).toMatch(/min-width:\s*0;/);
      expect(body('.content-calendar')).not.toMatch(/min-width:\s*42rem/);
      expect(body('.content-calendar__days')).toMatch(/min-width:\s*42rem;/);
    });

    it('tints the card and its title by format with the format tokens, and keeps the late edge red', () => {
      for (const [tone, name] of [['carousel', 'carousel'], ['reels', 'reels'], ['static', 'static']] as const) {
        expect(body(`.content-card[data-format='${tone}']`)).toContain(`background: var(--format-${name}-bg);`);
        expect(body(`.content-card[data-format='${tone}']`)).toContain(`--content-card-title: var(--format-${name}-fg);`);
      }
      expect(body('.content-card[data-late]')).toMatch(/border-color:\s*var\(--status-late-fg\)/);
    });

    it('cuts the title at four lines, hides the cover of a post with no media, and lets a day shrink its cards', () => {
      expect(body('.content-card__title')).toMatch(/-webkit-line-clamp:\s*4;/);
      expect(body('.content-card__cover--bare')).toMatch(/display:\s*none;/);
      expect(body('.content-day')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
    });

    it('lets the card shrink to its day: one shrinking column, or the longest word of a tag widens it past the day', () => {
      expect(body('.content-card')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
    });

    it('opens the detail of a card of the last row of the month upward, so the scrolling calendar does not clip it', () => {
      const rule = body(".content-calendar[data-view='month'] .content-day:nth-last-child(-n + 7) .content-card__detail");
      expect(rule).toMatch(/bottom:\s*100%;/);
      expect(rule).toMatch(/top:\s*auto;/);
    });

    it('puts no shadow on the profile preview (only what floats has one) and sets the tile state in the scale', () => {
      expect(body('.contents__feed')).not.toMatch(/box-shadow/);
      expect(body('.content-feed__status')).toMatch(/font:\s*var\(--caption\);/);
    });
  });
});
