// @vitest-environment jsdom

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type Location, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateContentRequestSchema } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { clientRegistrationExtras } from './client-registration-fixture.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { readGlobalCss } from './styles/read-css';

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

const agencyMe = (agencyId: string, agencyName: string, permissions: readonly string[], readOnly = false) => ({
  agencyId, agencyName, isOwner: false, membershipId: null, role: { key: 'custom', name: 'Papel' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly }, permissions
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
  ...clientRegistrationExtras,
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
    approval: null,
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
  approval: null,
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
  /** The plan is read-only: the writes are blocked with a reason. */
  readonly readOnly?: boolean;
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
    if (me !== null) return json(agencyMe(me[1]!, me[1] === AGENCY_B ? 'Agência Dois' : 'Agência Um', permissions, scenario.readOnly));
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
        openedBy: { name: 'Pessoa', side: 'agency' }, lastComment: answer, commentCount: 3, resolvedBy: null, resolvedAt: null, dueOn: null, title: null
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
  hash: string;
  state: unknown;
  navigate: NavigateFunction;
}

function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location: Location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.hash = location.hash;
    probe.state = location.state;
    probe.navigate = navigate;
  });
  return null;
}

const render_ = (impl: typeof fetch, entry: string | { pathname: string; search?: string; hash?: string; state: unknown } = `/agencia/${AGENCY_A}/conteudos`) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: Probe = { pathname: '', search: '', hash: '', state: undefined, navigate: () => undefined };
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
  const time = document.querySelector(`.content-day time[datetime="${day}"], .content-agenda__day time[datetime="${day}"]`);
  const cell = time?.closest('li');
  if (cell === null || cell === undefined) throw new Error(`The day ${day} was not rendered.`);
  return cell;
};

// October 2026 starts on a Thursday and ends on a Saturday: with the week starting on Sunday the grid is five rows, 27 September to 31 October.
const OCTOBER = { from: '2026-09-27', to: '2026-10-31' };

/** The grid exists only once the period answered: the title above it is there from the first render. */
const calendarReady = (): Promise<HTMLElement> => waitFor(() => {
  const calendar = document.querySelector<HTMLElement>('.content-calendar');
  if (calendar === null) throw new Error('The calendar has not rendered yet.');
  return calendar;
});

/** The lucide icon that draws the shape of a format: the name lucide-react gives the class of its svg. */
/** Opens the client switch of the header and picks another client from the roster it lists. */
const switchClient = async (from: string, to: string): Promise<void> => {
  fireEvent.click(await screen.findByRole('button', { name: `Trocar de cliente, ${from}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(`^${to}`) }));
};

const shapeOf = (cover: Element | null | undefined): string | null => {
  const names = (cover?.querySelector('.format-shape > svg')?.getAttribute('class') ?? '').split(' ').filter((name) => name.startsWith('lucide-'));
  return names.length === 0 ? null : names[0]!.slice('lucide-'.length);
};

describe('the Calendário Editorial item and the guard', () => {
  it('carries the filter of the address (`estado`) from the picker to the calendar of the client chosen', async () => {
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS] });
    const { probe } = render_(impl, { pathname: `/agencia/${AGENCY_A}/conteudos`, search: '?estado=aprovado', state: { clientListUrl: '/agencia/x/clientes' } });

    const link = await screen.findByRole('link', { name: /Padaria Central/ });
    expect(link.getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos/${padaria.id}?estado=aprovado`);
    fireEvent.click(link);
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/conteudos/${padaria.id}`));
    expect(probe.search).toBe('?estado=aprovado');
    expect(probe.state).toEqual({ clientListUrl: '/agencia/x/clientes' });
    expect(await screen.findByRole('button', { name: /Aprovado/, pressed: true })).toBeTruthy();
  });

  it('gives the item to whoever has conteudo.visualizar, linked to the selector', async () => {
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS] });
    render_(impl, `/agencia/${AGENCY_A}`);

    const link = await screen.findByRole('link', { name: 'Calendário Editorial' });
    expect(link.getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos`);
    fireEvent.click(link);
    expect(await screen.findByRole('heading', { level: 1, name: 'Calendário Editorial' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Padaria Central' })).toBeTruthy();
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
    expect(screen.queryByRole('link', { name: 'Calendário Editorial' })).toBeNull();
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
    expect(screen.queryByRole('link', { name: 'Calendário Editorial' })).toBeNull();
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
    const names = within(nav).getAllByRole('link').map((link) => link.querySelector('.content-clients__name')?.textContent);
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
    // Without the permission to register there is nothing to offer: only the words.
    expect(screen.queryByRole('link', { name: 'Cadastrar cliente' })).toBeNull();
    expect(screen.queryByText('Cadastre o primeiro para começar o calendário dele.')).toBeNull();
  });

  it('shows the register button blocked, with its reason, when the plan is read-only', async () => {
    const { impl } = makeFetch({ roster: [barbearia], permissions: [VISUALIZE, READ_CLIENTS, 'cliente.cadastrar'], readOnly: true });
    render_(impl);
    expect(await screen.findByText('Nenhum cliente ativo ainda.')).toBeTruthy();
    expect(screen.getByText('Cadastre o primeiro para começar o calendário dele.')).toBeTruthy();
    const button = screen.getByRole('button', { name: /Cadastrar cliente/ });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Cadastrar cliente' })).toBeNull();
  });

  it('invites whoever can register to start from the first client, carrying the navigation state', async () => {
    const { impl } = makeFetch({ roster: [barbearia], permissions: [VISUALIZE, READ_CLIENTS, 'cliente.cadastrar'] });
    const { probe } = render_(impl, { pathname: `/agencia/${AGENCY_A}/conteudos`, state: { clientListUrl: `/agencia/${AGENCY_A}/clientes?status=archived` } });
    expect(await screen.findByText('Nenhum cliente ativo ainda.')).toBeTruthy();
    expect(screen.getByText('Cadastre o primeiro para começar o calendário dele.')).toBeTruthy();
    const empty = screen.getByText('Nenhum cliente ativo ainda.').closest('.ui-empty-state') as HTMLElement;
    expect(empty.classList.contains('ui-empty-state--good-news')).toBe(false);
    expect(empty.classList.contains('ui-empty-state--failure')).toBe(false);
    fireEvent.click(within(empty).getByRole('link', { name: 'Cadastrar cliente' }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes`));
    expect(probe.state).toEqual({ clientListUrl: `/agencia/${AGENCY_A}/clientes?status=archived` });
  });

  it('shows a skeleton on the first load, then the clients', async () => {
    const held = deferred<Response>();
    const { impl } = makeFetch({ clients: () => held.promise });
    const { container } = render_(impl);

    await screen.findByRole('heading', { name: 'Calendário Editorial' });
    await waitFor(() => expect(container.querySelector('.content-clients__skeleton')).not.toBeNull());
    expect(screen.queryByRole('navigation', { name: 'Clientes' })).toBeNull();

    held.resolve(json({ data: [padaria], meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } }));
    expect(await screen.findByRole('link', { name: 'Padaria Central' })).toBeTruthy();
    expect(container.querySelector('.content-clients__skeleton')).toBeNull();
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
    // The failure kind: the roster did not answer, so "nenhum cliente ativo" is not said.
    expect(screen.getByRole('alert').classList.contains('ui-empty-state--failure')).toBe(true);
    expect(screen.queryByText('Nenhum cliente ativo ainda.')).toBeNull();
    const attemptsBeforeRetry = attempts;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('link', { name: 'Padaria Central' })).toBeTruthy();
    expect(attempts).toBeGreaterThan(attemptsBeforeRetry);
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

  it('keeps the navigation state on every story link and on the client switch of the header', async () => {
    const roster = `/agencia/${AGENCY_A}/clientes?search=padaria&page=2`;
    const { impl } = makeFetch();
    const { probe } = render_(impl, { pathname: `/agencia/${AGENCY_A}/conteudos`, state: { clientListUrl: roster } });

    fireEvent.click(await screen.findByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(padaria.id)));
    expect(probe.state).toEqual({ clientListUrl: roster });
    await switchClient('Padaria Central', 'Academia Corpo');
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(academia.id)));
    expect(probe.state).toEqual({ clientListUrl: roster });
  });
});

describe('the signals of each client on the picker (contentIndicators of #261)', () => {
  const indicators = (overrides: Partial<Record<'pending' | 'inReview' | 'overdue' | 'adjusting' | 'dueSoon', number>>) =>
    ({ pending: 0, inReview: 0, overdue: 0, adjusting: 0, dueSoon: 0, ...overrides });
  const withIndicators = (id: string, name: string, contentIndicators?: ReturnType<typeof indicators>) =>
    ({ ...clientFixture(id, name, null), ...(contentIndicators === undefined ? {} : { contentIndicators }) });
  const itemOf = async (name: string): Promise<HTMLElement> => (await screen.findByText(name)).closest('a')!;
  const signalsOf = (item: HTMLElement): (string | null)[] => Array.from(item.querySelectorAll('.content-clients__signal')).map((signal) => signal.textContent);

  it.each([
    ['a change asked by the client (adjusting)', { adjusting: 1 }, '1 em ajuste'],
    ['a content past its day (overdue)', { overdue: 2 }, '2 em atraso'],
    ['a content due in two days (dueSoon)', { dueSoon: 1 }, '1 com prazo em dois dias']
  ] as const)('says the reason in words, beside the name, for %s', async (_name, counts, reason) => {
    const flagged = withIndicators('5e5e5e5e-5555-4555-8555-555555555555', 'Cliente com Pedido', indicators(counts));
    const quiet = withIndicators('6f6f6f6f-6666-4666-8666-666666666666', 'Cliente Quieto', indicators({}));
    const { impl } = makeFetch({ roster: [flagged, quiet] });
    render_(impl);

    expect(signalsOf(await itemOf('Cliente com Pedido'))).toEqual([reason]);
    const calm = await itemOf('Cliente Quieto');
    expect(signalsOf(calm)).toEqual([]);
    expect(calm.querySelector('.content-clients__signals--calm')?.textContent).toBe('Em dia');
  });

  it('lists every reason that applies, late first, and nothing for the flow itself (em produção and aguardando aprovação)', async () => {
    const everything = withIndicators('5e5e5e5e-5555-4555-8555-555555555555', 'Tudo Junto', indicators({ adjusting: 1, overdue: 1, dueSoon: 1 }));
    const flowOnly = withIndicators('6f6f6f6f-6666-4666-8666-666666666666', 'Só Fluxo', indicators({ pending: 7, inReview: 3 }));
    const unknown = withIndicators('7a7a7a7a-7777-4777-8777-777777777777', 'Sem Indicadores');
    const { impl } = makeFetch({ roster: [everything, flowOnly, unknown] });
    render_(impl);

    expect(signalsOf(await itemOf('Tudo Junto'))).toEqual(['1 em atraso', '1 com prazo em dois dias', '1 em ajuste']);
    expect(signalsOf(await itemOf('Só Fluxo'))).toEqual([]);
    expect((await itemOf('Só Fluxo')).textContent).toContain('Em dia');
    // Without the indicators (a caller who cannot read contents) no line is drawn at all.
    expect((await itemOf('Sem Indicadores')).querySelector('.content-clients__signals')).toBeNull();
  });

  it('lists the reasons beside the name in the client switch of the header, and marks the client that is open', async () => {
    const flagged = withIndicators(padaria.id, 'Padaria Central', indicators({ overdue: 1 }));
    const { impl } = makeFetch({ roster: [flagged, academia, barbearia, confeitaria] });
    render_(impl, contentsUrl(padaria.id));

    fireEvent.click(await screen.findByRole('button', { name: 'Trocar de cliente, Padaria Central' }));
    await screen.findByRole('menuitem', { name: /^Padaria Central/ });
    const items = screen.getAllByRole('menuitem');
    const open = items.find((item) => item.textContent?.startsWith('Padaria Central'))!;
    expect(open.getAttribute('aria-current')).toBe('true');
    expect(open.textContent).toBe('Padaria Central1 em atraso');
    expect(items.filter((item) => item.getAttribute('aria-current') === 'true')).toHaveLength(1);
    expect(items.map((item) => item.textContent?.replace(/\d+ em atraso$/, ''))).toEqual(['Padaria Central', 'Academia Corpo', 'Confeitaria Doce', 'Abrir no cadastro do cliente']);
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
    expect(await screen.findByRole('button', { name: 'Trocar de cliente, Academia Corpo' })).toBeTruthy();
    expect(await screen.findByText('Treino da semana')).toBeTruthy();
    // No other client's calendar was asked for.
    expect(periodCalls(calls).every((call) => call.includes(`/clients/${academia.id}/`))).toBe(true);
  });

  it('marks the chosen client as the current one in the switch, and only that one', async () => {
    const { impl } = makeFetch();
    render_(impl, contentsUrl(academia.id));

    fireEvent.click(await screen.findByRole('button', { name: 'Trocar de cliente, Academia Corpo' }));
    await screen.findByRole('menuitem', { name: /^Academia Corpo/ });
    const items = screen.getAllByRole('menuitem');
    expect(items.map((item) => [item.textContent, item.getAttribute('aria-current')])).toEqual([
      ['Padaria Central', null], ['Academia Corpo', 'true'], ['Confeitaria Doce', null], ['Abrir no cadastro do cliente', null]
    ]);
  });

  it('switches client from the stories without keeping the previous client\'s contents on screen', async () => {
    const held = deferred<Response>();
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Pão de queijo', publishOn: '2026-10-14' })] },
      period: (clientId, from, to) => clientId === academia.id ? held.promise.then(() => periodResponse([], from, to)) : undefined
    });
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Pão de queijo');

    await switchClient('Padaria Central', 'Academia Corpo');
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
    // Whole weeks, Sunday to Saturday: the 27th of September (a Sunday) opens the grid and the 31st of October (a Saturday) closes it.
    expect(document.querySelectorAll('.content-day')).toHaveLength(35);
    const days = Array.from(document.querySelectorAll('.content-day time')).map((time) => time.getAttribute('datetime'));
    expect(days[0]).toBe('2026-09-27');
    expect(days.at(-1)).toBe('2026-10-31');
    expect(document.querySelector('.content-day time[datetime="2026-11-01"]')).toBeNull();
    expect(screen.getByText('domingo, 11 de outubro de 2026')).toBeTruthy();
    expect(Array.from(document.querySelectorAll('.content-calendar__weekdays li')).map((header) => header.textContent)).toEqual(['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']);
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

    expect(dayCell('2026-09-27').className).toContain('content-day--outside');
    expect(dayCell('2026-09-30').className).toContain('content-day--outside');
    expect(dayCell('2026-10-01').className).not.toContain('content-day--outside');
    expect(dayCell('2026-10-31').className).not.toContain('content-day--outside');
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
    expect(within(day).getAllByRole('article').map((card) => card.querySelector('.content-card__title')?.textContent)).toEqual(['Lançamento do pão', 'Bastidores']);
    const launch = within(day).getByText('Lançamento do pão').closest('article')!;
    // Title, one support line (format and time) and the state: the subtask percentage lives in the floating card.
    expect(within(launch).getByText('Carrossel · 18:00')).toBeTruthy();
    expect(within(launch).getByText('Aguardando')).toBeTruthy();
    expect(within(launch).queryByText(/subtarefas/)).toBeNull();
    const behind = within(day).getByText('Bastidores').closest('article')!;
    expect(within(behind).getByText('Estático')).toBeTruthy();
    expect(within(behind).queryByText(/·/)).toBeNull();
    expect(within(behind).getByText('Em ajuste')).toBeTruthy();
    // No subtasks: no percentage at all, not "0%".
    expect(within(behind).queryByText(/subtarefas/)).toBeNull();
    expect(within(dayCell('2026-10-30')).getByText('Vídeo longo')).toBeTruthy();
    expect(within(dayCell('2026-10-30')).getByText('Aprovado')).toBeTruthy();
    expect(within(dayCell('2026-10-31')).getByText('VSL')).toBeTruthy();
    expect(within(dayCell('2026-10-31')).getByText('Cancelado')).toBeTruthy();
    // Nothing leaks into the neighbours.
    expect(within(dayCell('2026-10-15')).queryByRole('article')).toBeNull();
  });

  it('labels the six states of a content', async () => {
    const statuses = [
      ['in_production', 'Em produção'], ['awaiting_approval', 'Aguardando'], ['adjusting', 'Em ajuste'],
      ['approved', 'Aprovado'], ['published', 'Publicado'], ['cancelled', 'Cancelado']
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

    const alertsOf = (title: string): (string | null)[] => Array.from(screen.getByText(title).closest('article')!.querySelectorAll('.ui-late-badge')).map((badge) => badge.textContent);
    // Only lateness is the state of the card; the near deadline moved to the floating card.
    expect(alertsOf('Passou')).toEqual(['Atrasado']);
    expect(alertsOf('Para hoje')).toEqual([]);
    expect(screen.queryByText('Prazo em dois dias')).toBeNull();
    expect(alertsOf('Em dois dias')).toEqual([]);
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
    expect(screen.getByRole('alert').classList.contains('ui-empty-state--failure')).toBe(true);
    // The story scripts come with the same answer: no empty list is drawn for them either.
    expect(screen.queryByText('Nenhum roteiro de stories neste período')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('Voltou')).toBeTruthy();
    expect(screen.queryByText('Não foi possível carregar os conteúdos. Tente de novo.')).toBeNull();
    expect(periodCalls(calls).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the previous period on screen while the next one loads, saying it is updating', async () => {
    const held = deferred<Response>();
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Do começo de outubro', publishOn: '2026-10-01' })] },
      period: (_client, from, to) => from === '2026-08-30' ? held.promise.then(() => periodResponse([], from, to)) : undefined
    });
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Do começo de outubro');

    fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
    await waitFor(() => expect(probe.search).toBe('?data=2026-09-01'));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByText('Atualizando…')).toBeTruthy();
    // The card stays in its own day while the grid already shows September (whose last row still holds the 1st of October).
    expect(within(dayCell('2026-10-01')).getByText('Do começo de outubro')).toBeTruthy();
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
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-08-30', '2026-10-03')));

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Próximo mês' }));
    expect(await screen.findByRole('heading', { name: 'Novembro 2026' })).toBeTruthy();
    expect(probe.search).toBe('?data=2026-11-01');
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-11-01', '2026-12-05')));

    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }));
    expect(await screen.findByRole('heading', { name: 'Outubro 2026' })).toBeTruthy();
    expect(probe.search).toBe('');
  });

  it('switches to the week and back, and moves by week', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByRole('heading', { name: 'Outubro 2026' });
    expect(screen.getByRole('radio', { name: 'Mês' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Semana' }).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('radio', { name: 'Semana' }));
    expect(await screen.findByRole('heading', { name: '11 a 17 de outubro de 2026' })).toBeTruthy();
    expect(probe.search).toBe('?visao=semana');
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-10-11', '2026-10-17')));
    expect(document.querySelectorAll('.content-day')).toHaveLength(7);
    expect(screen.getByRole('radio', { name: 'Semana' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Próxima semana' }));
    expect(await screen.findByRole('heading', { name: '18 a 24 de outubro de 2026' })).toBeTruthy();
    expect(probe.search).toBe('?visao=semana&data=2026-10-18');
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-10-18', '2026-10-24')));

    fireEvent.click(screen.getByRole('button', { name: 'Semana anterior' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Semana anterior' }));
    expect(await screen.findByRole('heading', { name: '4 a 10 de outubro de 2026' })).toBeTruthy();
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-10-04', '2026-10-10')));

    fireEvent.click(screen.getByRole('radio', { name: 'Mês' }));
    // The anchor was Sunday the 4th: the month that holds it is October, and the day stays in the URL.
    expect(await screen.findByRole('heading', { name: 'Outubro 2026' })).toBeTruthy();
    expect(probe.search).toBe('?data=2026-10-04');
  });

  it('chooses the view as a group of three options with the arrow keys, one tab stop, and not as buttons', async () => {
    const { impl } = makeFetch();
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByRole('heading', { name: 'Outubro 2026' });

    const group = screen.getByRole('radiogroup', { name: 'Visão' });
    expect(within(group).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Mês', 'Semana', 'Feed']);
    expect(screen.queryByRole('button', { name: 'Semana' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Visão' })).toBeNull();
    const month = within(group).getByRole('radio', { name: 'Mês' });
    const week = within(group).getByRole('radio', { name: 'Semana' });
    expect([month.getAttribute('tabindex'), week.getAttribute('tabindex')]).toEqual(['0', '-1']);

    month.focus();
    fireEvent.keyDown(month, { key: 'ArrowRight' });

    expect(await screen.findByRole('heading', { name: '11 a 17 de outubro de 2026' })).toBeTruthy();
    expect(probe.search).toBe('?visao=semana');
    expect(document.activeElement).toBe(week);
    expect([month.getAttribute('tabindex'), week.getAttribute('tabindex')]).toEqual(['-1', '0']);
  });

  it('moves the period with icon buttons that keep their names, and draws no character in place of an icon', async () => {
    const { impl } = makeFetch();
    render_(impl, contentsUrl(padaria.id));
    await screen.findByRole('heading', { name: 'Outubro 2026' });

    const period = within(screen.getByRole('group', { name: 'Período' }));
    for (const name of ['Mês anterior', 'Próximo mês']) {
      const button = period.getByRole('button', { name });
      expect(button.classList.contains('ui-icon-button'), name).toBe(true);
      expect(button.textContent, name).toBe('');
      expect(button.querySelector('svg')?.getAttribute('aria-hidden'), name).toBe('true');
    }
    expect(period.getByRole('button', { name: 'Hoje' }).textContent).toBe('Hoje');
  });

  it('reads the view and the day from the URL, so a reload lands on the same period', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, contentsUrl(padaria.id, '?visao=semana&data=2026-10-14'));

    expect(await screen.findByRole('heading', { name: '11 a 17 de outubro de 2026' })).toBeTruthy();
    expect(periodCalls(calls)).toEqual([periodCall(padaria.id, '2026-10-11', '2026-10-17')]);
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
  it('has the calendar with the three views in one selector, no phone beside it, and the folders in the Mídias tab', async () => {
    const { impl } = makeFetch();
    render_(impl, contentsUrl(padaria.id));
    await screen.findByRole('heading', { name: 'Outubro 2026' });
    await calendarReady();

    for (const name of ['Calendário', 'Pastas']) {
      expect(screen.queryByRole('tab', { name }), `tab ${name}`).toBeNull();
      expect(screen.queryByRole('radio', { name }), `radio ${name}`).toBeNull();
      expect(screen.queryByRole('button', { name }), `button ${name}`).toBeNull();
    }
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Visão do cliente' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Prévia do feed' })).toBeNull();
    expect(document.querySelector('.content-phone')).toBeNull();
    expect(document.querySelector('.content-calendar')).not.toBeNull();
  });
});

describe('every request goes through apiPath', () => {
  it('sends only well-formed paths with the ids percent-encoded as one segment', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, contentsUrl(padaria.id.toUpperCase()));
    await calendarReady();

    const agencyCalls = calls.filter((call) => call.includes('/agencies/'));
    expect(agencyCalls.length).toBeGreaterThan(2);
    for (const call of agencyCalls) expect(call).toMatch(new RegExp(`^GET /agencies/${AGENCY_A}/(me|notifications/unread-count|clients(/${padaria.id}(/contents(\\?from=\\d{4}-\\d{2}-\\d{2}&to=\\d{4}-\\d{2}-\\d{2}|/feed))?|\\?page=1&pageSize=100)?)$`));
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
    const script = { id: '5c5c5c5c-5555-4555-8555-555555555555', scriptOn: '2026-10-20', status: 'draft', sceneCount: 2 };
    const { patches } = open([traveller], {
      period: (_client, from, to) => {
        const rows = [traveller].filter((row) => row.publishOn >= from && row.publishOn <= to);
        return json({ data: { contents: rows, storyScripts: [script] }, meta: { from, to, count: rows.length + 1 } });
      }
    });
    await screen.findByText('Viajante');
    expect(within(dayCell('2026-10-20')).getByRole('button', { name: /^Stories.*Rascunho$/ })).toBeTruthy();

    drag('Viajante', '2026-10-20');
    await waitFor(() => expect(within(dayCell('2026-10-20')).queryByText('Viajante')).not.toBeNull());
    expect(patches).toEqual([{ clientId: padaria.id, contentId: traveller.id, body: { publishOn: '2026-10-20' } }]);
    expect(within(dayCell('2026-10-20')).getByRole('button', { name: /^Stories.*Rascunho$/ })).toBeTruthy();
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
    const rows = (['in_production', 'awaiting_approval', 'adjusting', 'approved'] as const).map((status, index) => contentFixture({ title: `Post ${status}`, publishOn: `2026-10-${15 + index}`, status }));
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
    const row = contentFixture({ title: 'Para setembro', publishOn: '2026-10-14' });
    const { patches } = open([row]);
    await screen.findByText('Para setembro');

    drag('Para setembro', '2026-09-27');
    await waitFor(() => expect(patches).toEqual([{ clientId: padaria.id, contentId: row.id, body: { publishOn: '2026-09-27' } }]));
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

describe('the cover of a card of the calendar', () => {
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
    await waitFor(() => expect(shapeOf(cardOf('Sem quadro').querySelector('.content-card__cover--placeholder'))).toBe('clapperboard'));
    expect(cardOf('Sem quadro').querySelector('img')).toBeNull();
  });

  it('asks for nothing when the chosen cover was removed and no other media is left (thumbnail null with a cover id)', async () => {
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Capa removida', publishOn: '2026-10-14', format: 'reels', coverAssetId: ASSET_A, thumbnailAssetId: null })] }
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Capa removida');

    expect(shapeOf(cardOf('Capa removida').querySelector('.content-card__cover--placeholder'))).toBe('clapperboard');
    expect(coverCalls(calls)).toEqual([]);
  });

  it('asks for nothing and shows the shape of the format when the content has no cover', async () => {
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Sem capa', publishOn: '2026-10-14', format: 'carousel' }), contentFixture({ title: 'Filme', publishOn: '2026-10-15', format: 'reels' })] }
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Sem capa');

    expect(cardOf('Sem capa').querySelector('img')).toBeNull();
    expect(shapeOf(cardOf('Sem capa').querySelector('.content-card__cover--placeholder'))).toBe('gallery-vertical');
    expect(shapeOf(cardOf('Filme').querySelector('.content-card__cover--placeholder'))).toBe('clapperboard');
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
    expect(within(cardOf('Sem miniatura')).getByText('Aprovado')).toBeTruthy();
  });

  it.each([[403, 'FORBIDDEN'], [404, 'NOT_FOUND']] as const)('keeps the placeholder when the route answers %s', async (status, code) => {
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Recusada', publishOn: '2026-10-14', coverAssetId: ASSET_A })] },
      cover: () => json({ error: { code, message: 'no' } }, status)
    });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Recusada');
    await waitFor(() => expect(cardOf('Recusada').querySelector('.content-card__cover--placeholder')).not.toBeNull());
    expect(shapeOf(cardOf('Recusada').querySelector('.content-card__cover--placeholder'))).toBe('clapperboard');
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

  it('does not read an address again when the person leaves for another client and comes back before it expires', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Volta', publishOn: '2026-10-14', coverAssetId: ASSET_A })] } });
    render_(impl, contentsUrl(padaria.id));
    await waitFor(() => expect(document.querySelector('.content-card img')).not.toBeNull());

    await switchClient('Padaria Central', 'Confeitaria Doce');
    await waitFor(() => expect(document.querySelector('.content-card')).toBeNull());
    await switchClient('Confeitaria Doce', 'Padaria Central');
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

    await switchClient('Padaria Central', 'Confeitaria Doce');
    await waitFor(() => expect(document.querySelector('.content-card')).toBeNull());
    await switchClient('Confeitaria Doce', 'Padaria Central');
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
  // A mouse that rests: the card opens after 300 ms, and closes a moment after the mouse leaves.
  const pointer = (type: 'pointerOver' | 'pointerOut', element: HTMLElement): void => {
    const event = createEvent[type](element, { bubbles: true });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    fireEvent(element, event);
  };
  const point = (element: HTMLElement): void => pointer('pointerOver', element);
  const unpoint = (element: HTMLElement): void => pointer('pointerOut', element);
  const detailCalls = (calls: readonly string[]): string[] => calls.filter((call) => /\/contents\/(?!feed$)[^/?]+$/.test(call) && call.startsWith('GET'));
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
    expect(screen.queryByRole('dialog')).toBeNull();

    point(cardOf('Lançamento'));
    const tooltip = await screen.findByRole('dialog');
    expect(await within(tooltip).findByText('Hoje tem pão quente na padaria!')).toBeTruthy();
    expect(within(tooltip).getByText('Legenda')).toBeTruthy();
    expect(within(tooltip).getByText('2 de 4 aprovadas · 1 entregue · 1 pendente')).toBeTruthy();
    expect(within(tooltip).queryByText(/das subtarefas/)).toBeNull();
    // 01:30Z of the 12th is still the 11th in São Paulo.
    expect(within(tooltip).getByText('3 comentários · último em 11/10')).toBeTruthy();
    expect(await within(tooltip).findByText('Cliente: “Podemos trocar a foto da capa?” · 11/10')).toBeTruthy();
    expect(calls).toContain(`GET /agencies/${AGENCY_A}/clients/${padaria.id}/threads?contentId=${row.id}`);
    expect(within(cardOf('Lançamento')).getByRole('link', { name: /Lançamento/ }).getAttribute('aria-controls')).toBe(tooltip.id);
    expect(within(cardOf('Lançamento')).getByRole('link').getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(detailCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/clients/${padaria.id}/contents/${row.id}`]);

    unpoint(cardOf('Lançamento'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(within(cardOf('Lançamento')).getByRole('link', { name: /Lançamento/ }).hasAttribute('aria-controls')).toBe(false);
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

    point(cardOf('Sem conversa'));
    await within(await screen.findByRole('dialog')).findByText('Sem comentários');
    expect(threadCalls(calls)).toEqual([]);
    unpoint(cardOf('Sem conversa'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    point(cardOf('Com conversa'));
    const tooltip = await screen.findByRole('dialog');
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
    point(cardOf('Primeiro'));
    expect(await within(await screen.findByRole('dialog')).findByText(/Fala do primeiro/)).toBeTruthy();
    unpoint(cardOf('Primeiro'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    point(cardOf('Segundo'));
    const tooltip = await screen.findByRole('dialog');
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

    point(cardOf('Texto'));
    const tooltip = await screen.findByRole('dialog');
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

    point(cardOf('Marcação'));
    const tooltip = await screen.findByRole('dialog');
    expect(await within(tooltip).findByText(/<img src=x onerror=alert\(1\)> <b>oi<\/b>/)).toBeTruthy();
    expect(tooltip.querySelector('img')).toBeNull();
    expect(tooltip.querySelector('b')).toBeNull();
  });

  it('says the empty cases in words: no caption, no subtasks, no comments', async () => {
    const row = contentFixture({ title: 'Vazio', publishOn: '2026-10-14' });
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Vazio');

    point(cardOf('Vazio'));
    const tooltip = await screen.findByRole('dialog');
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

    point(cardOf('Longa'));
    const tooltip = await screen.findByRole('dialog');
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

    point(cardOf('Segunda'));
    expect(await screen.findByText('Legenda da segunda')).toBeTruthy();
    expect(screen.queryByText('Legenda da primeira')).toBeNull();
    unpoint(cardOf('Segunda'));
    point(cardOf('Primeira'));
    expect(await screen.findByText('Legenda da primeira')).toBeTruthy();
    expect(screen.queryByText('Legenda da segunda')).toBeNull();
    // Back on the first one: it was read already.
    unpoint(cardOf('Primeira'));
    point(cardOf('Segunda'));
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

    const link = within(cardOf('Teclado')).getByRole('link');
    // The card has one stop, its link: a real focus, which the browser marks as keyboard focus, opens the floating card at once.
    expect(cardOf('Teclado').getAttribute('tabindex')).toBeNull();
    act(() => { link.focus(); });
    expect(await screen.findByRole('dialog', { name: 'Detalhes de Teclado' })).toBeTruthy();
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Closed by Escape, the focus stays where it was: the card does not reopen by itself.
    expect(document.activeElement).toBe(link);
    act(() => { link.blur(); });
    act(() => { link.focus(); });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    // Moving from the card into its own floating card keeps it open; leaving both closes it.
    act(() => { (document.activeElement as HTMLElement).blur(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('keeps the near deadline and the late mark in the floating card, since the card itself shows only the state', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Em dois dias', publishOn: '2026-10-13', status: 'adjusting' }), contentFixture({ title: 'Passou', publishOn: '2026-10-10', status: 'approved' })] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Em dois dias');

    point(cardOf('Em dois dias'));
    expect(await within(await screen.findByRole('dialog')).findByText('Prazo em dois dias')).toBeTruthy();
    unpoint(cardOf('Em dois dias'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    point(cardOf('Passou'));
    expect(within(await screen.findByRole('dialog')).getByText('Atrasado')).toBeTruthy();
  });

  it('stays open when the mouse crosses from the card onto the floating card, and closes when it leaves both (WCAG 1.4.13)', async () => {
    const row = contentFixture({ title: 'Travessia', publishOn: '2026-10-14' });
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Travessia');

    point(cardOf('Travessia'));
    const hover = await screen.findByRole('dialog');
    unpoint(cardOf('Travessia'));
    point(hover);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.queryByRole('dialog')).toBe(hover);

    unpoint(hover);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('does not open on a touch, not even after resting', async () => {
    const row = contentFixture({ title: 'Toque', publishOn: '2026-10-14' });
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Toque');

    const event = createEvent.pointerOver(cardOf('Toque'), { bubbles: true });
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    fireEvent(cardOf('Toque'), event);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(detailCalls(calls)).toEqual([]);
  });

  it('waits the 300 ms before opening on a mouse', async () => {
    const row = contentFixture({ title: 'Parado', publishOn: '2026-10-14' });
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Parado');

    point(cardOf('Parado'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('shows the cover, the whole title, the day and the network, both tags and the hint to drag, in the floating card', async () => {
    const long = `${'Título muito longo '.repeat(8)}fim`;
    const row = contentFixture({ title: long, publishOn: '2026-10-03', format: 'carousel', status: 'awaiting_approval', coverAssetId: ASSET_A });
    const { impl, calls } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS, 'conteudo.operar'], contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText(long);

    point(cardOf(long));
    const hover = await screen.findByRole('dialog', { name: `Detalhes de ${long}` });
    expect(within(hover).getByText(`Carrossel: ${long}`)).toBeTruthy();
    expect(within(hover).getByText('03 de out. · Instagram')).toBeTruthy();
    expect(within(hover).getByText('Carrossel')).toBeTruthy();
    expect(within(hover).getByText('Aguardando aprovação')).toBeTruthy();
    expect(within(hover).getByText('Arraste para outro dia')).toBeTruthy();
    await waitFor(() => expect(hover.querySelector('.content-hover__cover img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET_A}.jpg`));
    // The card and its floating card share the cover: pointing at it asks for nothing more.
    expect(calls.filter((call) => /\/download-url/.test(call))).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET_A}/download-url?variant=thumbnail`]);
  });

  it('says "arraste para outro dia" only for a card that can be dragged', async () => {
    const open = contentFixture({ title: 'Aberto', publishOn: '2026-10-14' });
    const done = contentFixture({ title: 'Já foi ao ar', publishOn: '2026-10-15', status: 'published' });
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS, 'conteudo.operar'], contents: { [padaria.id]: [open, done] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Já foi ao ar');

    point(cardOf('Já foi ao ar'));
    await within(await screen.findByRole('dialog')).findByText('Sem legenda');
    expect(screen.queryByText('Arraste para outro dia')).toBeNull();
    unpoint(cardOf('Já foi ao ar'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    point(cardOf('Aberto'));
    expect(await screen.findByText('Arraste para outro dia')).toBeTruthy();
  });

  it('says it is loading, and says when it could not load', async () => {
    const held = deferred<Response>();
    const row = contentFixture({ title: 'Lenta', publishOn: '2026-10-14' });
    const slow = makeFetch({ contents: { [padaria.id]: [row] }, content: () => held.promise });
    const first = render_(slow.impl, contentsUrl(padaria.id));
    await screen.findByText('Lenta');
    point(cardOf('Lenta'));
    expect(await screen.findByText('Carregando detalhes…')).toBeTruthy();
    held.resolve(json(detailOfContent(padaria.id, row)));
    expect(await screen.findByText('Sem legenda')).toBeTruthy();
    first.unmount();

    const failing = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Falha', publishOn: '2026-10-14' })] }, content: () => notFound() });
    render_(failing.impl, contentsUrl(padaria.id));
    await screen.findByText('Falha');
    point(cardOf('Falha'));
    expect(await screen.findByText('Não foi possível carregar os detalhes.')).toBeTruthy();
  });

  it('renders the caption as text, never as markup', async () => {
    const row = contentFixture({ title: 'Hostil', publishOn: '2026-10-14' });
    const hostile = '<img src=x onerror="document.title=1"><b>negrito</b>';
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] }, content: withDetail(row, { caption: hostile }) });
    const { container } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Hostil');

    point(cardOf('Hostil'));
    expect(await screen.findByText(hostile)).toBeTruthy();
    expect(container.querySelector('.content-hover b')).toBeNull();
    expect(container.querySelector('.content-hover img')).toBeNull();
  });

  it('closes the detail when the card is picked up to be dragged', async () => {
    const row = contentFixture({ title: 'Levantada', publishOn: '2026-10-14' });
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS, 'conteudo.operar'], contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Levantada');

    point(cardOf('Levantada'));
    await screen.findByRole('dialog');
    fireEvent.dragStart(cardOf('Levantada'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows the name of the responsible of the card that is pointed at, never the link behind it (#552)', async () => {
    const ana = contentFixture({ title: 'Da Ana', publishOn: '2026-10-14' });
    const paulo = contentFixture({ title: 'Do Paulo', publishOn: '2026-10-14', owner: { membershipId: 'e0e0e0e0-0000-4000-8000-000000000002', name: 'Paulo Lima' } });
    const { impl } = makeFetch({ contents: { [padaria.id]: [ana, paulo] } });
    const { container } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Do Paulo');

    point(cardOf('Do Paulo'));
    const detail = await screen.findByRole('dialog');
    expect(await within(detail).findByText('Responsável')).toBeTruthy();
    expect(within(detail).getByText('Paulo Lima')).toBeTruthy();
    expect(within(detail).queryByText('Ana Souza')).toBeNull();
    expect(container.textContent).not.toContain('e0e0e0e0-0000-4000-8000-000000000002');
    unpoint(cardOf('Do Paulo'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    point(cardOf('Da Ana'));
    expect(await within(await screen.findByRole('dialog')).findByText('Ana Souza')).toBeTruthy();
  });

  it('shows no responsible for a content whose person has no link to the agency (owner null)', async () => {
    const row = contentFixture({ title: 'Sem vínculo', publishOn: '2026-10-14', owner: null });
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Sem vínculo');

    point(cardOf('Sem vínculo'));
    await screen.findByText('Sem legenda');
    expect(screen.queryByText('Responsável')).toBeNull();
  });
});

describe('where the floating card of a calendar card opens', () => {
  const cardOf = (title: string): HTMLElement => {
    const card = screen.getByText(title).closest('article');
    if (card === null) throw new Error(`The card of ${title} was not rendered.`);
    return card;
  };
  const open = async (title: string): Promise<string | null> => {
    const event = createEvent.pointerOver(cardOf(title), { bubbles: true });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    fireEvent(cardOf(title), event);
    const dialog = await screen.findByRole('dialog', { name: `Detalhes de ${title}` });
    // On the screen, not inside the calendar: its scrolling container would clip a card placed inside it.
    expect(dialog.className).toContain('ui-popover--fixed');
    const placement = dialog.getAttribute('data-placement');
    const out = createEvent.pointerOut(cardOf(title), { bubbles: true });
    Object.defineProperty(out, 'pointerType', { value: 'mouse' });
    fireEvent(cardOf(title), out);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    return placement;
  };
  // October 2026 starts on a Thursday: the grid runs from Sunday 27 September to Saturday 31 October (35 days, 5 rows).
  const month = [
    contentFixture({ title: 'Quarta', publishOn: '2026-10-14' }),
    contentFixture({ title: 'Sexta', publishOn: '2026-10-09' }),
    contentFixture({ title: 'Sábado', publishOn: '2026-10-10' }),
    contentFixture({ title: 'Domingo', publishOn: '2026-10-11' }),
    contentFixture({ title: 'Domingo da última linha', publishOn: '2026-10-25' }),
    contentFixture({ title: 'Segunda da última linha', publishOn: '2026-10-26' }),
    contentFixture({ title: 'Sexta da última linha', publishOn: '2026-10-30' }),
    contentFixture({ title: 'Sábado da última linha', publishOn: '2026-10-31' })
  ];

  it('opens towards the inside of the month: sexta and sábado to the left, the last row upwards', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: month } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Quarta');

    expect(await open('Quarta')).toBe('bottom-start');
    expect(await open('Domingo')).toBe('bottom-start');
    expect(await open('Sexta')).toBe('bottom-end');
    expect(await open('Sábado')).toBe('bottom-end');
    expect(await open('Domingo da última linha')).toBe('top-start');
    expect(await open('Segunda da última linha')).toBe('top-start');
    expect(await open('Sexta da última linha')).toBe('top-end');
    expect(await open('Sábado da última linha')).toBe('top-end');
  });

  it('opens upwards on every day of the week view, and to the left on sábado and domingo', async () => {
    const week = [
      contentFixture({ title: 'Segunda', publishOn: '2026-10-12' }),
      contentFixture({ title: 'Sábado', publishOn: '2026-10-17' })
    ];
    const { impl } = makeFetch({ contents: { [padaria.id]: week } });
    render_(impl, contentsUrl(padaria.id, '?visao=semana&data=2026-10-14'));
    await screen.findByText('Segunda');

    expect(await open('Segunda')).toBe('top-start');
    expect(await open('Sábado')).toBe('top-end');
  });
});

describe('the calendar lives only on the screen of Conteúdos, and the profile leads to it (decision 2026-11-04)', () => {
  const oldTab = (suffix = '', search = '') => `/agencia/${AGENCY_A}/clientes/${padaria.id}/conteudos${suffix}${search}`;
  const treino = () => contentFixture({ title: 'Treino da semana', publishOn: '2026-10-14' });
  const ROSTER_ADDRESS = `/agencia/${AGENCY_A}/clientes?search=padaria&page=2`;
  const OPERATOR = [VISUALIZE, READ_CLIENTS, 'conteudo.operar'];

  it('redirects the old tab address to the screen, keeping the query and the roster address, replacing the history entry', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [treino()] } });
    const { probe } = render_(impl, { pathname: oldTab(), search: '?visao=semana&data=2026-10-14', state: { clientListUrl: ROSTER_ADDRESS } });
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(padaria.id)));
    expect(probe.search).toBe('?visao=semana&data=2026-10-14');
    expect(probe.state).toEqual({ clientListUrl: ROSTER_ADDRESS });
    expect(await screen.findByText('Treino da semana')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: '11 a 17 de outubro de 2026' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Você está em' })).getByRole('link', { name: 'Calendário Editorial' }).getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos`);
  });

  it('keeps the hash of the old tab address too', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [treino()] } });
    const { probe } = render_(impl, { pathname: oldTab(), search: '?visao=semana', hash: '#feed', state: { clientListUrl: ROSTER_ADDRESS } });
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(padaria.id)));
    expect(probe.hash).toBe('#feed');
  });

  it('redirects the old modal and creation addresses to the equivalents on the screen, with the query', async () => {
    const row = treino();
    const { impl } = makeFetch({ permissions: OPERATOR, contents: { [padaria.id]: [row] } });
    const opened = render_(impl, { pathname: oldTab(`/${row.id}`), search: '?visao=semana&data=2026-10-14', state: { clientListUrl: ROSTER_ADDRESS } });
    await waitFor(() => expect(opened.probe.pathname).toBe(`${contentsUrl(padaria.id)}/${row.id}`));
    expect(opened.probe.search).toBe('?visao=semana&data=2026-10-14');
    expect(opened.probe.state).toEqual({ clientListUrl: ROSTER_ADDRESS });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    opened.unmount();

    const created = render_(impl, { pathname: oldTab('/novo'), search: '?data=2026-10-14&dia=2026-10-20', state: { clientListUrl: ROSTER_ADDRESS } });
    await waitFor(() => expect(created.probe.pathname).toBe(`${contentsUrl(padaria.id)}/novo`));
    expect(created.probe.search).toBe('?data=2026-10-14&dia=2026-10-20');
    expect(created.probe.state).toEqual({ clientListUrl: ROSTER_ADDRESS });
    expect(await screen.findByRole('dialog', { name: 'Novo conteúdo' })).toBeTruthy();
  });

  it('sends the old folders address through the screen to the Mídias tab, with the folder it had open', async () => {
    const { impl } = makeFetch({});
    const { probe } = render_(impl, oldTab('', '?vista=pastas&pasta=abc'));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes/${padaria.id}/midias`));
    expect(probe.search).toBe('?pasta=abc');
  });

  // Vendas and Financeiro hold neither content permission; each row is a role with permissions that never include conteudo.visualizar.
  it.each([
    ['cliente.visualizar only (Vendas)', [READ_CLIENTS]],
    ['conteudo.operar, without visualizar', [READ_CLIENTS, 'conteudo.operar']],
    ['cliente.visualizar and financeiro.visualizar (Financeiro)', [READ_CLIENTS, 'financeiro.visualizar']]
  ])('keeps every old address "não encontrado" without the client behind it: %s', async (_name, permissions) => {
    const row = treino();
    const { impl, calls } = makeFetch({ permissions, contents: { [padaria.id]: [row] } });
    for (const address of [oldTab(), oldTab('/novo'), oldTab(`/${row.id}`), oldTab('', '?vista=pastas')]) {
      const view = render_(impl, address);
      expect(await screen.findByRole('heading', { name: 'Página não encontrada' })).toBeTruthy();
      expect(screen.queryByRole('heading', { name: 'Padaria Central' })).toBeNull();
      expect(view.probe.pathname).toBe(address.split('?')[0]);
      view.unmount();
    }
    expect(calls.filter((call) => /\/contents|\/media-folders|\/threads/.test(call))).toEqual([]);
  });

  it('links the calendar to the profile from the client switch, keeping the roster address, so "← Clientes" still returns to the search', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [treino()] } });
    const { probe } = render_(impl, { pathname: contentsUrl(padaria.id), search: '?visao=semana&data=2026-10-14', state: { clientListUrl: ROSTER_ADDRESS } });
    await screen.findByText('Treino da semana');
    fireEvent.click(screen.getByRole('button', { name: 'Trocar de cliente, Padaria Central' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abrir no cadastro do cliente' }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/clientes/${padaria.id}/geral`));
    expect(probe.state).toEqual({ clientListUrl: ROSTER_ADDRESS });
    expect((await within(await screen.findByRole('navigation', { name: 'Você está em' })).findByRole('link', { name: 'Clientes' })).getAttribute('href')).toBe(ROSTER_ADDRESS);
    expect(screen.queryByRole('link', { name: 'Abrir na tela do Calendário Editorial' })).toBeNull();
  });

  it('opens a content on the screen and closing it comes back to the screen', async () => {
    const row = treino();
    const { impl } = makeFetch({ contents: { [padaria.id]: [row] } });
    const { probe } = render_(impl, contentsUrl(padaria.id));
    const card = (await screen.findAllByRole('link', { name: /Treino da semana/ })).find((link) => link.classList.contains('content-card__link'))!;
    expect(card.getAttribute('href')).toBe(`${contentsUrl(padaria.id)}/${row.id}`);
    fireEvent.click(card);
    await waitFor(() => expect(probe.pathname).toBe(`${contentsUrl(padaria.id)}/${row.id}`));
    fireEvent.click(await screen.findByRole('button', { name: 'Fechar conteúdo' }));
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(padaria.id)));
  });
});

describe('the header and the grid of the calendar', () => {
  it('names the screen in the trail and the period as its one title, and offers one primary action that follows the view', async () => {
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS, 'conteudo.operar'] });
    render_(impl, contentsUrl(padaria.id));
    await calendarReady();

    expect(screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent)).toEqual(['Outubro 2026']);
    expect(screen.queryByText('Planeje, agende e acompanhe todas as publicações.')).toBeNull();
    const trail = screen.getByRole('navigation', { name: 'Você está em' });
    expect(within(trail).getByRole('link', { name: 'Calendário Editorial' }).getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos`);
    expect(within(trail).getByRole('button', { name: 'Trocar de cliente, Padaria Central' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Novo conteúdo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Nova publicação' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Feed' }));
    expect(await screen.findByRole('button', { name: 'Nova publicação' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Novo conteúdo' })).toBeNull();
  });

  describe('the list of days of a phone', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('lists in the month only the days that have a content, and keeps the seven days of the week', async () => {
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
      const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS, 'conteudo.operar'], contents: { [padaria.id]: [
        contentFixture({ title: 'Um', publishOn: '2026-10-14' }),
        contentFixture({ title: 'Dois', publishOn: '2026-10-20' })
      ] } });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Um');

      expect([...document.querySelectorAll('.content-agenda__day')].map((day) => day.getAttribute('data-day'))).toEqual(['2026-10-14', '2026-10-20']);
      expect(document.querySelector('.content-agenda__day--empty')).toBeNull();
      expect(screen.getByRole('button', { name: 'Novo conteúdo' })).toBeTruthy();

      fireEvent.click(screen.getByRole('radio', { name: 'Semana' }));
      await waitFor(() => expect(document.querySelectorAll('.content-agenda__day')).toHaveLength(7));
    });
  });

  describe('the card of a post', () => {
    const cardTitled = (title: string): HTMLElement => screen.getByText(title).closest('article')!;

    it.each([
      ['carousel', 'carousel', 'Carrossel'], ['reels', 'reels', 'Reels'], ['image', 'static', 'Estático'], ['long_video', 'static', 'Vídeo longo'], ['vsl', 'static', 'VSL']
    ] as const)('names a %s card by its icon and short name in front of the title, and keeps its tone %s', async (format, tone, label) => {
      const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Um post', publishOn: '2026-10-20', format })] } });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Um post');

      const card = cardTitled('Um post');
      expect(card.getAttribute('data-format')).toBe(tone);
      expect(card.querySelector('.content-card__title')?.textContent).toBe('Um post');
      expect(card.querySelector('.content-card__support')?.textContent).toBe(label);
      expect(card.querySelector('.content-card__support svg')).not.toBeNull();
    });

    it.each([
      ['in_production', 'production', 'Em produção'], ['awaiting_approval', 'waiting', 'Aguardando'], ['adjusting', 'adjust', 'Em ajuste'],
      ['approved', 'ready', 'Aprovado'], ['published', 'published', 'Publicado'], ['cancelled', 'production', 'Cancelado']
    ] as const)('draws the state %s as a tag of the %s kind, with its icon and its words', async (status, kind, label) => {
      const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Estado', publishOn: '2026-10-25', status })] } });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Estado');

      const tag = cardTitled('Estado').querySelector(`.ui-status-tag--${kind}`);
      expect(tag?.textContent).toBe(label);
      expect(tag?.querySelector('svg')).not.toBeNull();
    });

    it('puts the solid "Atrasado" block, with no red outline, only on a late card, in place of its state tag (one tag a card)', async () => {
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
      expect(late.querySelector('.ui-late-badge')?.textContent).toBe('Atrasado');
      expect(late.querySelector('.ui-status-tag')).toBeNull();
      expect(late.getAttribute('data-state')).toBe('late');
      for (const title of ['Em dia', 'Publicado antigo', 'Quase lá']) {
        expect(cardTitled(title).getAttribute('data-state')).not.toBe('late');
        expect(cardTitled(title).querySelector('.ui-late-badge')).toBeNull();
      }
    });

    it('draws the cover inside the card: the thumbnail when there is media, the shape of the format when there is none', async () => {
      const { impl } = makeFetch({
        contents: { [padaria.id]: [
          contentFixture({ title: 'Sem mídia', publishOn: '2026-10-20', format: 'carousel' }),
          contentFixture({ title: 'Com mídia', publishOn: '2026-10-21', format: 'carousel', coverAssetId: ASSET_A })
        ] }
      });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Sem mídia');

      expect(shapeOf(cardTitled('Sem mídia').querySelector('.content-card__cover--placeholder'))).toBe('gallery-vertical');
      await waitFor(() => expect(cardTitled('Com mídia').querySelector('.content-card__cover img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET_A}.jpg`));
      expect(cardTitled('Com mídia').querySelector('.content-card__cover--placeholder')).toBeNull();
    });

    it('shows "Agendado" for an approved post with an hour that has not come, and "Aprovado" once the hour passed, on the São Paulo day (01:30Z is still the 11th)', async () => {
      const { impl } = makeFetch({
        contents: { [padaria.id]: [
          contentFixture({ title: 'Hoje à noite', publishOn: '2026-10-11', publishAtTime: '23:00', status: 'approved' }),
          contentFixture({ title: 'Hoje cedo', publishOn: '2026-10-11', publishAtTime: '09:00', status: 'approved' }),
          contentFixture({ title: 'Amanhã', publishOn: '2026-10-12', publishAtTime: '08:00', status: 'approved' }),
          contentFixture({ title: 'Amanhã sem hora', publishOn: '2026-10-12', status: 'approved' })
        ] }
      });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Hoje à noite');

      const stateOf = (title: string): [string | null, string | undefined] => [cardTitled(title).getAttribute('data-state'), cardTitled(title).querySelector('.ui-status-tag')?.textContent ?? undefined];
      expect(stateOf('Hoje à noite')).toEqual(['scheduled', 'Agendado']);
      expect(cardTitled('Hoje à noite').querySelector('.ui-status-tag--scheduled')).not.toBeNull();
      expect(stateOf('Amanhã')).toEqual(['scheduled', 'Agendado']);
      expect(stateOf('Hoje cedo')).toEqual(['approved', 'Aprovado']);
      expect(stateOf('Amanhã sem hora')).toEqual(['approved', 'Aprovado']);
      expect(cardTitled('Hoje à noite').getAttribute('data-state')).not.toBe('late');
    });

    it('shows the time of a post on the support line after the format, and nothing when it has none', async () => {
      const { impl } = makeFetch({
        contents: { [padaria.id]: [contentFixture({ title: 'Com hora', publishOn: '2026-10-20', publishAtTime: '09:30' }), contentFixture({ title: 'Sem hora', publishOn: '2026-10-21' })] }
      });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Com hora');

      expect(cardTitled('Com hora').querySelector('.content-card__support')?.textContent).toBe('Reels · 09:30');
      expect(cardTitled('Sem hora').querySelector('.content-card__support')?.textContent).toBe('Reels');
    });
  });

  describe('CSS contract', () => {
    const css = readGlobalCss();
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

    it('lets the cells shrink to the grid, which clips at the surface and never widens the page', () => {
      expect(body('.content-calendar')).toMatch(/min-width:\s*0;/);
      expect(body('.content-calendar')).toMatch(/overflow:\s*hidden;/);
      expect(body('.content-calendar__days')).toMatch(/grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\);/);
    });

    it('tints the card by its format (the state is the tag at its foot), and does not outline it, not even when it is late', () => {
      expect(body('.content-card')).toMatch(/border:\s*1px solid transparent;/);
      for (const format of ['carousel', 'reels']) {
        expect(body(`.content-card[data-format='${format}']`)).toContain(`--content-card-bg: var(--format-${format}-bg);`);
      }
      expect(body('.content-card')).toContain('--content-card-bg: var(--format-static-bg);');
      expect(css).not.toMatch(/\.content-card\[data-late\]|content-card-tone/);
      expect(body('.content-card')).not.toMatch(/gradient|backdrop-filter|box-shadow/);
    });

    it('cuts the title at two lines, and lets a day and the link of the card shrink', () => {
      expect(body('.content-card__title')).toMatch(/-webkit-line-clamp:\s*2;/);
      expect(body('.content-day')).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\);/);
      expect(body('.content-card__link')).toMatch(/grid-template-columns:\s*2\.25rem minmax\(0, 1fr\);/);
    });

    it('places the floating card on the screen, so the scrolling calendar cannot clip it, and gives the card no shadow of its own', () => {
      expect(body('.ui-popover--fixed')).toMatch(/position:\s*fixed;/);
      expect(body('.ui-popover--fixed')).toMatch(/max-height:\s*calc\(100vh - var\(--space-4\)\);/);
      expect(body('.ui-popover')).toMatch(/box-shadow:\s*var\(--shadow-floating\);/);
      expect(body('.ui-popover')).toMatch(/background:\s*var\(--bg-elevated\);/);
      expect(body('.content-card')).not.toMatch(/box-shadow/);
      expect(body('.content-hover')).not.toMatch(/box-shadow/);
    });

    it('keeps the floating card to text, tags and the hint: no link, no danger text, no field on the elevated surface', () => {
      const hover = rules.filter((rule) => rule.selectors.some((selector) => selector.startsWith('.content-hover'))).map((rule) => rule.body).join(' ');
      expect(hover).not.toMatch(/--text-link|--text-danger|--status-late|input/);
    });

    it('sets the state of a feed tile in the type scale, and gives the phone of the agency no shadow of its own', () => {
      expect(rules.filter((rule) => rule.selectors.includes('.content-feed__state .ui-status-tag')).map((rule) => rule.body).join('\n')).toMatch(/font:\s*var\(--caption\);/);
      expect(body('.content-feed-layout .content-phone')).not.toMatch(/box-shadow/);
    });

    it('scrolls the stories of the month inside their own strip, snapped, with room after the last one', () => {
      const strip = body('.story-list__items');
      expect(strip).toMatch(/overflow-x:\s*auto;/);
      expect(strip).toMatch(/scroll-snap-type:\s*x proximity;/);
      expect(strip).toMatch(/padding:\s*var\(--space-1\) var\(--space-4\) var\(--space-2\) var\(--space-1\);/);
      expect(body('.story-list__items > li')).toMatch(/scroll-snap-align:\s*start;/);
    });

    it('draws the shadow of the format icon of a tile with a token of the design system, never a raw colour', () => {
      expect(body('.content-feed__format')).toMatch(/drop-shadow\(0 0 2px var\(--scrim\)\)/);
      expect(body('.content-feed__format')).not.toMatch(/rgb\(/);
    });
  });
});

describe('the Calendário Editorial: the title, the three views, the whole card (#703)', () => {
  const OPERATE = [VISUALIZE, READ_CLIENTS, 'conteudo.operar'];
  const titles = (): string[] => screen.getAllByRole('heading', { level: 1 }).map((heading) => heading.textContent ?? '');

  it('has the picker titled "Calendário Editorial", and the period as the one title once a client is chosen, with the screen in the trail', async () => {
    const { impl } = makeFetch();
    render_(impl, `/agencia/${AGENCY_A}/conteudos`);
    await screen.findByRole('link', { name: /Padaria Central/ });
    expect(titles()).toEqual(['Calendário Editorial']);
    expect(document.title).toBe('Calendário Editorial — Ageniza');
    expect(screen.queryByText('Escolha um cliente para ver o calendário editorial.')).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: /Padaria Central/ }));
    await calendarReady();
    expect(titles()).toEqual(['Outubro 2026']);
    expect(within(screen.getByRole('navigation', { name: 'Você está em' })).getByRole('link', { name: 'Calendário Editorial' }).getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos`);
    await waitFor(() => expect(document.title).toBe('Calendário Editorial de Padaria Central — Ageniza'));
  });

  it('draws the three views in one selector, and reads the feed view from the address, with the profile on the phone of the board', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Um post', publishOn: '2026-10-14', format: 'image' })] } });
    render_(impl, contentsUrl(padaria.id, '?visao=feed'));

    const group = await screen.findByRole('radiogroup', { name: 'Visão' });
    expect(within(group).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['Mês', 'Semana', 'Feed']);
    expect(within(group).getByRole('radio', { name: 'Feed' }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(document.querySelector('.content-feed-layout .content-feed__grid')).not.toBeNull());
    expect(screen.getByRole('region', { name: 'Simulador do perfil do Instagram' })).toBeTruthy();
    expect(document.querySelector('.content-calendar')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Filtrar por estado' })).toBeNull();
  });

  it('writes each view to the address, and a reload on that address lands on the same view', async () => {
    const { impl } = makeFetch();
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await calendarReady();

    fireEvent.click(screen.getByRole('radio', { name: 'Feed' }));
    await waitFor(() => expect(probe.search).toBe('?visao=feed'));
    expect(screen.getByRole('radio', { name: 'Feed' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Semana' }));
    await waitFor(() => expect(probe.search).toBe('?visao=semana'));
    expect(screen.getByRole('radio', { name: 'Semana' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Mês' }));
    await waitFor(() => expect(probe.search).toBe(''));
    expect(screen.getByRole('radio', { name: 'Mês' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows every post of the period in the feed view, with no page of nine', async () => {
    const rows = Array.from({ length: 12 }, (_value, index) => contentFixture({ title: `Post ${index + 1}`, publishOn: `2026-10-${String(index + 1).padStart(2, '0')}`, format: 'image' }));
    const { impl } = makeFetch({ contents: { [padaria.id]: rows } });
    render_(impl, contentsUrl(padaria.id, '?visao=feed'));
    await waitFor(() => expect(document.querySelectorAll('.content-feed__tile')).toHaveLength(12));
    // Twelve fit in the page of the feed view (thirty): no pager is needed.
    expect(document.querySelector('.content-feed__pager')).toBeNull();
  });

  it('counts the month by the state it shows in the chips above the calendar, from the contents it already read', async () => {
    const rows = [
      contentFixture({ title: 'A', publishOn: '2026-10-14', status: 'in_production' }),
      contentFixture({ title: 'B', publishOn: '2026-10-08', status: 'approved' }),
      contentFixture({ title: 'C', publishOn: '2026-10-25', status: 'approved' }),
      contentFixture({ title: 'D', publishOn: '2026-10-26', status: 'approved', publishAtTime: '09:00' }),
      contentFixture({ title: 'Do mês seguinte', publishOn: '2026-11-01', status: 'approved' })
    ];
    const { impl } = makeFetch({ contents: { [padaria.id]: rows } });
    render_(impl, contentsUrl(padaria.id));
    const filters = await screen.findByRole('group', { name: 'Filtrar por estado' });

    // The 1st of November is a day the grid does not draw: it is not counted. B is late (the 8th has passed), D is scheduled.
    expect(within(filters).getAllByRole('button').map((chip) => chip.textContent)).toEqual([
      'Todos4', 'Em produção1', 'Aguardando0', 'Aprovado1', 'Agendado1', 'Atrasado1', 'Publicado0'
    ]);
    expect(within(filters).getAllByRole('button').every((chip) => chip.getAttribute('aria-pressed') === 'false' || chip.textContent === 'Todos4')).toBe(true);
  });

  describe('the whole card opens its content', () => {
    const pair = () => [
      contentFixture({ title: 'Primeiro post', publishOn: '2026-10-20', format: 'image' }),
      contentFixture({ title: 'Segundo post', publishOn: '2026-10-20', format: 'reels' })
    ];

    it('opens the content of the row that was pressed, on any point of the card and not only on its title', async () => {
      const [first, second] = pair() as [ReturnType<typeof contentFixture>, ReturnType<typeof contentFixture>];
      const { impl } = makeFetch({ contents: { [padaria.id]: [first, second] } });
      const { probe } = render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Segundo post');

      const card = screen.getByText('Segundo post').closest('article')!;
      fireEvent.click(card.querySelector('.content-card__support')!);
      await waitFor(() => expect(probe.pathname).toBe(`${contentsUrl(padaria.id)}/${second.id}`));
    });

    it('opens the first one when the first is pressed, by the line of its state', async () => {
      const [first, second] = pair() as [ReturnType<typeof contentFixture>, ReturnType<typeof contentFixture>];
      const { impl } = makeFetch({ contents: { [padaria.id]: [first, second] } });
      const { probe } = render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Primeiro post');

      fireEvent.click(screen.getByText('Primeiro post').closest('article')!.querySelector('.content-card__foot')!);
      await waitFor(() => expect(probe.pathname).toBe(`${contentsUrl(padaria.id)}/${first.id}`));
    });

    it('has one stop for the keyboard on a card, named by the format, the title and the state it shows', async () => {
      const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Receita', publishOn: '2026-10-20', format: 'reels', status: 'adjusting' })] } });
      render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Receita');

      const card = screen.getByText('Receita').closest('article')!;
      expect(card.getAttribute('tabindex')).toBeNull();
      expect(card.querySelectorAll('a, button')).toHaveLength(1);
      expect(within(card).getByRole('link').textContent).toBe('ReelsReceitaEm ajuste');
    });

    it('does not open the content when the card is dragged, even if the browser then fires a click', async () => {
      const [first, second] = pair() as [ReturnType<typeof contentFixture>, ReturnType<typeof contentFixture>];
      const { impl } = makeFetch({ permissions: OPERATE, contents: { [padaria.id]: [first, second] } });
      const { probe } = render_(impl, contentsUrl(padaria.id));
      await screen.findByText('Segundo post');
      await waitFor(() => expect(screen.getByText('Segundo post').closest('article')?.getAttribute('draggable')).toBe('true'));

      const card = screen.getByText('Segundo post').closest('article')!;
      fireEvent.dragStart(card);
      fireEvent.dragEnd(card);
      fireEvent.click(card.querySelector('.content-card__link')!);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(probe.pathname).toBe(contentsUrl(padaria.id));

      // A press after the drag is a press again.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      fireEvent.click(card.querySelector('.content-card__link')!);
      await waitFor(() => expect(probe.pathname).toBe(`${contentsUrl(padaria.id)}/${second.id}`));
    });

    it('opens the content of a tile of the feed when the tile is pressed', async () => {
      const [first, second] = pair() as [ReturnType<typeof contentFixture>, ReturnType<typeof contentFixture>];
      const { impl } = makeFetch({ contents: { [padaria.id]: [first, second] } });
      const { probe } = render_(impl, contentsUrl(padaria.id, '?visao=feed'));
      await waitFor(() => expect(document.querySelectorAll('.content-feed__tile')).toHaveLength(2));

      const tile = [...document.querySelectorAll('.content-feed__tile')].find((candidate) => (candidate.textContent ?? '').includes('Primeiro post'))!;
      fireEvent.click(tile.querySelector('a')!);
      await waitFor(() => expect(probe.pathname).toBe(`${contentsUrl(padaria.id)}/${first.id}`));
    });
  });

  it('sums up a crowded day of the month as "+N" and opens the week of that day with it', async () => {
    const rows = Array.from({ length: 5 }, (_value, index) => contentFixture({ title: `Do dia ${index + 1}`, publishOn: '2026-10-20', format: 'image' }));
    const { impl } = makeFetch({ contents: { [padaria.id]: rows } });
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Do dia 1');

    expect(within(dayCell('2026-10-20')).getAllByRole('link')).toHaveLength(3);
    fireEvent.click(within(dayCell('2026-10-20')).getByRole('button', { name: /^\+2/ }));
    await waitFor(() => expect(probe.search).toBe('?visao=semana&data=2026-10-20'));
    await waitFor(() => expect(within(dayCell('2026-10-20')).getAllByRole('link')).toHaveLength(5));
  });

  it('offers the way to plan the first post in the empty feed to who can create, and not to who cannot', async () => {
    const reader = makeFetch();
    const first = render_(reader.impl, contentsUrl(padaria.id, '?visao=feed'));
    await screen.findByText('Nenhum post planejado neste período.');
    expect(screen.queryByRole('button', { name: 'Planejar um post' })).toBeNull();
    first.unmount();

    const operator = makeFetch({ permissions: OPERATE });
    const { probe } = render_(operator.impl, contentsUrl(padaria.id, '?visao=feed'));
    fireEvent.click(await screen.findByRole('button', { name: 'Planejar um post' }));
    await waitFor(() => expect(probe.pathname).toBe(`${contentsUrl(padaria.id)}/novo`));
    expect(probe.search).toBe('?visao=feed&dia=2026-10-11');
  });
});

describe('the Calendário Editorial of the approved board: filters, legend, periods and the switch of client', () => {
  const OPERATE = [VISUALIZE, READ_CLIENTS, 'conteudo.operar'];
  const filters = (): HTMLElement => screen.getByRole('group', { name: 'Filtrar por estado' });
  const chip = (label: string): HTMLElement => within(filters()).getAllByRole('button').find((candidate) => candidate.textContent?.startsWith(label))!;
  const cardTitles = (): string[] => Array.from(document.querySelectorAll('.content-card__title')).map((title) => title.textContent ?? '');
  // 01:30Z of the 12th is 22:30 of the 11th in São Paulo.
  const rows = () => [
    contentFixture({ title: 'Em produção A', publishOn: '2026-10-14', status: 'in_production' }),
    contentFixture({ title: 'Esperando B', publishOn: '2026-10-15', status: 'awaiting_approval' }),
    contentFixture({ title: 'Aprovado C', publishOn: '2026-10-16', status: 'approved' }),
    contentFixture({ title: 'Agendado D', publishOn: '2026-10-11', publishAtTime: '23:00', status: 'approved' }),
    contentFixture({ title: 'Atrasado E', publishOn: '2026-10-09', status: 'in_production' }),
    contentFixture({ title: 'Publicado F', publishOn: '2026-10-05', status: 'published' })
  ];

  it('filters the cards by each chip, writes the state to the address, and a second press on the chip clears it', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: rows() } });
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Em produção A');
    expect(cardTitles()).toHaveLength(6);
    expect(chip('Todos').getAttribute('aria-pressed')).toBe('true');

    const cases = [
      ['Em produção', 'producao', ['Em produção A']],
      ['Aguardando', 'aguardando', ['Esperando B']],
      ['Aprovado', 'aprovado', ['Aprovado C']],
      ['Agendado', 'agendado', ['Agendado D']],
      ['Atrasado', 'atrasado', ['Atrasado E']],
      ['Publicado', 'publicado', ['Publicado F']]
    ] as const;
    for (const [label, param, titles] of cases) {
      fireEvent.click(chip(label));
      await waitFor(() => expect(probe.search).toBe(`?estado=${param}`));
      expect(cardTitles(), label).toEqual(titles);
      expect(chip(label).getAttribute('aria-pressed'), label).toBe('true');
      expect(chip('Todos').getAttribute('aria-pressed'), label).toBe('false');
    }
    fireEvent.click(chip('Publicado'));
    await waitFor(() => expect(probe.search).toBe(''));
    expect(cardTitles()).toHaveLength(6);
    fireEvent.click(chip('Aprovado'));
    await waitFor(() => expect(probe.search).toBe('?estado=aprovado'));
    fireEvent.click(chip('Todos'));
    await waitFor(() => expect(probe.search).toBe(''));
    expect(cardTitles()).toHaveLength(6);
  });

  it('reads the filter from the address, and ignores a state that does not exist', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: rows() } });
    render_(impl, contentsUrl(padaria.id, '?estado=atrasado'));
    await screen.findByText('Atrasado E');
    expect(cardTitles()).toEqual(['Atrasado E']);
    expect(chip('Atrasado').getAttribute('aria-pressed')).toBe('true');
    cleanup();

    render_(impl, contentsUrl(padaria.id, '?estado=inventado'));
    await screen.findByText('Em produção A');
    expect(cardTitles()).toHaveLength(6);
    expect(chip('Todos').getAttribute('aria-pressed')).toBe('true');
  });

  it('says that no content has the state when the filter leaves the grid empty, and keeps the filter while the period moves', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: rows() } });
    const { probe } = render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Em produção A');
    fireEvent.click(chip('Aguardando'));
    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await waitFor(() => expect(probe.search).toBe('?estado=aguardando&data=2026-11-01'));
    expect(await screen.findByText('Nenhum conteúdo planejado neste período.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }));
    await waitFor(() => expect(probe.search).toBe('?estado=aguardando'));
    expect(await screen.findByText('Esperando B')).toBeTruthy();
    expect(cardTitles()).toEqual(['Esperando B']);
  });

  it('draws the chip of "Em ajuste" only while a content is in it, or when it is the chosen filter', async () => {
    const without = makeFetch({ contents: { [padaria.id]: rows() } });
    render_(without.impl, contentsUrl(padaria.id));
    await screen.findByText('Em produção A');
    expect(within(filters()).queryByRole('button', { name: /^Em ajuste/ })).toBeNull();
    cleanup();

    const withOne = makeFetch({ contents: { [padaria.id]: [...rows(), contentFixture({ title: 'Ajuste G', publishOn: '2026-10-17', status: 'adjusting' })] } });
    const { probe } = render_(withOne.impl, contentsUrl(padaria.id));
    await screen.findByText('Ajuste G');
    fireEvent.click(chip('Em ajuste'));
    await waitFor(() => expect(probe.search).toBe('?estado=ajuste'));
    expect(cardTitles()).toEqual(['Ajuste G']);
    cleanup();

    render_(without.impl, contentsUrl(padaria.id, '?estado=ajuste'));
    await screen.findByText('Nenhum conteúdo com este estado neste período.');
    expect(chip('Em ajuste').getAttribute('aria-pressed')).toBe('true');
  });

  it('counts the chips by the state each card shows, "agendado" and "atrasado" included', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: rows() } });
    render_(impl, contentsUrl(padaria.id));
    await screen.findByText('Em produção A');

    expect(within(filters()).getAllByRole('button').map((candidate) => candidate.textContent)).toEqual([
      'Todos6', 'Em produção1', 'Aguardando1', 'Aprovado1', 'Agendado1', 'Atrasado1', 'Publicado1'
    ]);
  });

  it('draws the legend of the formats under the grid, saying the format tints the card and the state is the tag', async () => {
    const { impl } = makeFetch();
    render_(impl, contentsUrl(padaria.id));
    await calendarReady();

    const legend = screen.getByRole('list', { name: 'Legenda dos formatos' });
    expect(within(legend).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Carrossel', 'Reels', 'Estático', 'O formato tinge o card; o estado fica na etiqueta.']);
  });

  it('starts the week on Sunday on the week view: an anchor on a Sunday and one on a Saturday open the same seven days', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'No domingo', publishOn: '2026-10-11' }), contentFixture({ title: 'No sábado', publishOn: '2026-10-17' }), contentFixture({ title: 'Na outra semana', publishOn: '2026-10-18' })] } });
    for (const anchor of ['2026-10-11', '2026-10-17']) {
      const view = render_(impl, contentsUrl(padaria.id, `?visao=semana&data=${anchor}`));
      expect(await screen.findByRole('heading', { name: '11 a 17 de outubro de 2026' })).toBeTruthy();
      await screen.findByText('No sábado');
      const days = Array.from(document.querySelectorAll('.content-day time')).map((time) => time.getAttribute('datetime'));
      expect(days).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
      expect(within(dayCell('2026-10-11')).getByText('No domingo')).toBeTruthy();
      expect(screen.queryByText('Na outra semana')).toBeNull();
      view.unmount();
    }
    expect(periodCalls(calls)).toEqual([periodCall(padaria.id, '2026-10-11', '2026-10-17'), periodCall(padaria.id, '2026-10-11', '2026-10-17')]);
  });

  it('opens the next week at the Sunday after a Saturday, and "Hoje" goes back to the week of today', async () => {
    const { impl, calls } = makeFetch();
    const { probe } = render_(impl, contentsUrl(padaria.id, '?visao=semana&data=2026-10-17'));
    await screen.findByRole('heading', { name: '11 a 17 de outubro de 2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Próxima semana' }));
    expect(await screen.findByRole('heading', { name: '18 a 24 de outubro de 2026' })).toBeTruthy();
    await waitFor(() => expect(calls).toContain(periodCall(padaria.id, '2026-10-18', '2026-10-24')));
    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }));
    expect(await screen.findByRole('heading', { name: '11 a 17 de outubro de 2026' })).toBeTruthy();
    expect(probe.search).toBe('?visao=semana');
  });

  it('keeps the day when the view changes, so the Feed and the month show the period that was on screen', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'De novembro', publishOn: '2026-11-10', format: 'image' })] } });
    const { probe } = render_(impl, contentsUrl(padaria.id, '?data=2026-11-05'));
    await screen.findByRole('heading', { name: 'Novembro 2026' });
    fireEvent.click(screen.getByRole('radio', { name: 'Feed' }));
    await waitFor(() => expect(probe.search).toBe('?data=2026-11-05&visao=feed'));
    await waitFor(() => expect(document.querySelectorAll('.content-feed__tile')).toHaveLength(1));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Novembro 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }));
    await waitFor(() => expect(probe.search).toBe('?visao=feed'));
    await screen.findByRole('heading', { name: 'Outubro 2026' });
  });

  it('changes the client from the header without leaving the view, and each client reads its own period', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Da padaria', publishOn: '2026-10-14' })], [academia.id]: [contentFixture({ title: 'Da academia', publishOn: '2026-10-14' })] } });
    const { probe } = render_(impl, contentsUrl(padaria.id, '?visao=semana&data=2026-10-14&estado=producao'));
    await screen.findByText('Da padaria');

    await switchClient('Padaria Central', 'Academia Corpo');
    await waitFor(() => expect(probe.pathname).toBe(contentsUrl(academia.id)));
    expect(probe.search).toBe('?visao=semana&data=2026-10-14&estado=producao');
    expect(await screen.findByText('Da academia')).toBeTruthy();
    expect(screen.queryByText('Da padaria')).toBeNull();
    expect(periodCalls(calls)).toEqual([periodCall(padaria.id, '2026-10-11', '2026-10-17'), periodCall(academia.id, '2026-10-11', '2026-10-17')]);
  });

  it('keeps only "Novo conteúdo" at the top, and no "Enviar vários para aprovação" (it lives on the client tab since 2026-11-13)', async () => {
    const toApprove = [contentFixture({ title: 'Pronto para enviar', publishOn: '2026-10-14', status: 'in_production' })];
    const operator = makeFetch({ permissions: OPERATE, contents: { [padaria.id]: toApprove } });
    const { probe } = render_(operator.impl, contentsUrl(padaria.id));
    await screen.findByText('Pronto para enviar');
    expect(await screen.findByRole('button', { name: 'Novo conteúdo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Enviar vários/ })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Novo conteúdo' }));
    await waitFor(() => expect(probe.pathname).toBe(`${contentsUrl(padaria.id)}/novo`));
    expect(probe.search).toBe('?dia=2026-10-11');
  });
});
