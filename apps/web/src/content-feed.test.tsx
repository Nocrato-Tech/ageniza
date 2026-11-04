// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CONTENT_FEED_PAGE_SIZE, type ContentListItem } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { feedItems } from './content-feed.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { useCommittedLocation } from './location-probe-fixture.js';

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 01:30Z of the 12th is 22:30 of the 11th (a Sunday) in São Paulo: a day computed in UTC is the wrong one. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T01:30:00Z'));
});

const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const sessionBody = { user: { id: '99999999-9999-4999-8999-999999999999', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const padaria = {
  id: '1a1a1a1a-1111-4111-8111-111111111111', name: 'Padaria Central', photoUrl: null, instagramHandle: 'padariacentral' as string | null,
  status: 'active', closingDate: null, threadsAwaitingAgency: 0
};
const confeitaria = { ...padaria, id: '4d4d4d4d-4444-4444-8444-444444444444', name: 'Confeitaria Doce', instagramHandle: null };
const ROSTER = [padaria, confeitaria];

const detailOf = (client: typeof padaria) => ({
  id: client.id, name: client.name, status: client.status, photoUrl: client.photoUrl, instagramHandle: client.instagramHandle,
  legalName: null, taxId: null, segment: null, website: null, contactName: null, contactPhone: null, contactEmail: null,
  closingDate: null, archivedAt: null,
  summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 0 }
});

let idCounter = 0;
const contentFixture = (overrides: Partial<ContentListItem> = {}): ContentListItem => {
  idCounter += 1;
  return {
    id: `c0c0c0c0-0000-4000-8000-${String(idCounter).padStart(12, '0')}`,
    title: `Conteúdo ${idCounter}`,
    platform: 'instagram',
    format: 'image',
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
    thumbnailAssetId: 'thumbnailAssetId' in overrides ? (overrides.thumbnailAssetId ?? null) : (overrides.coverAssetId ?? null)
  };
};

interface Scenario {
  readonly contents?: Readonly<Record<string, readonly ContentListItem[]>>;
  readonly period?: (clientId: string, from: string, to: string, call: number) => Response | Promise<Response> | undefined;
  readonly cover?: (assetId: string) => Response | undefined;
  /** The feed of the phone, by cursor; the default pages the client's `contents` nine at a time, as the API does. */
  readonly feed?: (clientId: string, cursor: string | null, call: number) => Response | Promise<Response> | undefined;
  /** The counters the API sends for the whole feed; the default counts the client's `contents`. */
  readonly counters?: (clientId: string) => { posts: number; approved: number; awaitingApproval: number } | undefined;
}

const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  let periodCalls = 0;
  let feedCalls = 0;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}${url.search}`);
    if (path.endsWith('/auth/session')) return json(sessionBody);
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) {
      return json({ agencyId: me[1], agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Papel' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions: ['conteudo.visualizar', 'cliente.visualizar'] });
    }
    if (/\/agencies\/[^/]+\/clients$/.test(path)) return json({ data: ROSTER, meta: { page: 1, pageSize: 100, totalItems: ROSTER.length, totalPages: 1 } });
    const media = /\/agencies\/[^/]+\/media\/([^/]+)\/download-url$/.exec(path);
    if (media !== null) return scenario.cover?.(media[1]!) ?? json({ url: `https://storage.test/${media[1]}.jpg`, expiresAt: '2026-10-12T01:45:00.000Z' });
    const feed = /\/agencies\/[^/]+\/clients\/([^/]+)\/contents\/feed$/.exec(path);
    if (feed !== null) {
      feedCalls += 1;
      // A real answer comes in a later task, not in the microtask of the call: the screen must not rely on the first.
      await new Promise<void>((done) => { setTimeout(done, 0); });
      const cursor = url.searchParams.get('cursor');
      const custom = scenario.feed?.(feed[1]!, cursor, feedCalls);
      if (custom !== undefined) return custom;
      const rows = feedItems(scenario.contents?.[feed[1]!] ?? []);
      const offset = cursor === null ? 0 : Number(cursor.replace('offset-', ''));
      const page = rows.slice(offset, offset + CONTENT_FEED_PAGE_SIZE);
      const counted = (status: string): number => rows.filter((row) => row.status === status).length;
      return json({
        data: {
          contents: page,
          nextCursor: offset + CONTENT_FEED_PAGE_SIZE < rows.length ? `offset-${offset + CONTENT_FEED_PAGE_SIZE}` : null,
          counters: scenario.counters?.(feed[1]!) ?? { posts: rows.length, approved: counted('approved'), awaitingApproval: counted('awaiting_approval') }
        },
        meta: { count: page.length }
      });
    }
    if (/\/agencies\/[^/]+\/clients\/[^/]+\/contents\/[^/]+$/.test(path)) return json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    const period = /\/agencies\/[^/]+\/clients\/([^/]+)\/contents$/.exec(path);
    if (period !== null) {
      const from = url.searchParams.get('from')!;
      const to = url.searchParams.get('to')!;
      periodCalls += 1;
      const custom = scenario.period?.(period[1]!, from, to, periodCalls);
      if (custom !== undefined) return custom;
      const rows = (scenario.contents?.[period[1]!] ?? []).filter((content) => content.publishOn >= from && content.publishOn <= to);
      return json({ data: { contents: rows, storyScripts: [] }, meta: { from, to, count: rows.length } });
    }
    const detail = /\/agencies\/[^/]+\/clients\/([^/]+)$/.exec(path);
    if (detail !== null) {
      const client = ROSTER.find((candidate) => candidate.id === detail[1]);
      return client === undefined ? json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404) : json(detailOf(client));
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

const probe = { pathname: '', search: '' };
const history: { go: (delta: number) => void } = { go: () => undefined };
function HistoryProbe() {
  const navigate = useNavigate();
  history.go = (delta) => navigate(delta);
  return null;
}
function LocationProbe() {
  useCommittedLocation((location) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
  });
  return null;
}

const renderScreen = (impl: typeof fetch, entry: string, queryClient = createQueryClient()) => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const store = createAuthSessionStore(client);
  return render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[entry]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <LocationProbe />
            <HistoryProbe />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const url = (clientId: string, search = '') => `/agencia/${AGENCY_A}/conteudos/${clientId}${search}`;

/** The feed region of the page, wherever it is: beside the calendar or in place of it. */
/** The lucide icon that draws the shape of a format: the name lucide-react gives the class of its svg. */
const shapeOf = (cover: Element | null | undefined): string | null => {
  const names = (cover?.querySelector('.format-shape > svg')?.getAttribute('class') ?? '').split(' ').filter((name) => name.startsWith('lucide-'));
  return names.length === 0 ? null : names[0]!.slice('lucide-'.length);
};

const feedRegion = (): HTMLElement => screen.getByRole(screen.queryByRole('complementary', { name: 'Prévia do feed' }) === null ? 'region' : 'complementary', { name: 'Prévia do feed' });
const tiles = (): HTMLElement[] => within(feedRegion()).queryAllByRole('listitem');
/** What a tile says in words, latest first: "title · format · dd/mm". */
const tileTexts = (): (string | null)[] => tiles().filter((tile) => tile.className.includes('content-feed__tile')).map((tile) => tile.querySelector('.visually-hidden')?.textContent ?? null);
/** The feed once the period answered: the skeleton is a grid too, but a hidden one. */
const ready = (): Promise<HTMLElement> => waitFor(() => {
  const grid = feedRegion().querySelector<HTMLElement>('.content-feed__grid:not([aria-hidden="true"])') ?? feedRegion().querySelector<HTMLElement>('.content-feed__empty');
  if (grid === null) throw new Error('The feed has not rendered.');
  return grid;
});

describe('feedItems', () => {
  it('keeps the feed formats that are not cancelled, in every state, and drops the rest', () => {
    const kept = (['image', 'carousel', 'reels'] as const).flatMap((format) =>
      (['in_production', 'awaiting_approval', 'adjusting', 'approved', 'published'] as const).map((status) => contentFixture({ format, status })));
    const dropped = [
      contentFixture({ format: 'long_video' }), contentFixture({ format: 'vsl' }),
      contentFixture({ format: 'image', status: 'cancelled' }), contentFixture({ format: 'carousel', status: 'cancelled' }),
      contentFixture({ format: 'reels', status: 'cancelled' }), contentFixture({ format: 'long_video', status: 'published' }), contentFixture({ format: 'vsl', status: 'approved' })
    ];
    expect(feedItems([...dropped, ...kept]).map((content) => content.id).sort()).toEqual(kept.map((content) => content.id).sort());
    expect(feedItems(dropped)).toEqual([]);
    expect(feedItems([])).toEqual([]);
  });

  it('puts the latest first: by day, then by time, a content without time at the end of its day, then the larger id', () => {
    const a = contentFixture({ id: 'a0000000-0000-4000-8000-000000000001', publishOn: '2026-10-14', publishAtTime: '09:00' });
    const b = contentFixture({ id: 'b0000000-0000-4000-8000-000000000002', publishOn: '2026-10-14', publishAtTime: '18:30' });
    const c = contentFixture({ id: 'c0000000-0000-4000-8000-000000000003', publishOn: '2026-10-14', publishAtTime: null });
    const d = contentFixture({ id: 'd0000000-0000-4000-8000-000000000004', publishOn: '2026-10-15', publishAtTime: '08:00' });
    const e = contentFixture({ id: 'e0000000-0000-4000-8000-000000000005', publishOn: '2026-10-13', publishAtTime: '23:59' });
    const f = contentFixture({ id: 'f0000000-0000-4000-8000-000000000006', publishOn: '2026-10-13', publishAtTime: '23:59' });
    expect(feedItems([a, b, c, d, e, f]).map((content) => content.id)).toEqual([d.id, c.id, b.id, a.id, f.id, e.id]);
    expect(feedItems([f, e, d, c, b, a]).map((content) => content.id)).toEqual([d.id, c.id, b.id, a.id, f.id, e.id]);
  });

  it('does not reorder what it was given', () => {
    const early = contentFixture({ publishOn: '2026-10-01' });
    const late = contentFixture({ publishOn: '2026-10-30' });
    const given = [early, late];
    feedItems(given);
    expect(given).toEqual([early, late]);
  });
});

describe('the feed beside the calendar', () => {
  it('shows the posts of the period, latest first, without the cancelled, the long video and the VSL', async () => {
    const { impl } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ title: 'Primeiro do mês', publishOn: '2026-10-02', format: 'image' }),
          contentFixture({ title: 'Reels do meio', publishOn: '2026-10-14', publishAtTime: '18:00', format: 'reels', status: 'approved' }),
          contentFixture({ title: 'Carrossel do meio', publishOn: '2026-10-14', publishAtTime: '09:00', format: 'carousel' }),
          contentFixture({ title: 'Último do mês', publishOn: '2026-10-28', format: 'image', status: 'awaiting_approval' }),
          contentFixture({ title: 'Cancelado', publishOn: '2026-10-15', status: 'cancelled' }),
          contentFixture({ title: 'Filme completo', publishOn: '2026-10-16', format: 'long_video' }),
          contentFixture({ title: 'Vendas em vídeo', publishOn: '2026-10-17', format: 'vsl' })
        ]
      }
    });
    renderScreen(impl, url(padaria.id));
    await ready();

    expect(tileTexts()).toEqual([
      'Último do mês · Imagem · 28/10',
      'Reels do meio · Reels · 14/10',
      'Carrossel do meio · Carrossel · 14/10',
      'Primeiro do mês · Imagem · 02/10'
    ]);
    // The calendar still has all of them: only the feed leaves three out.
    expect(screen.getByText('Filme completo')).toBeTruthy();
    expect(screen.getByText('Vendas em vídeo')).toBeTruthy();
    expect(within(feedRegion()).queryByText(/Cancelado|Filme completo|Vendas em vídeo/)).toBeNull();
  });

  it('marks what is still planned, by the day of São Paulo: today is not, tomorrow is', async () => {
    const { impl } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ title: 'Ontem', publishOn: '2026-10-10', status: 'published', publishedOn: '2026-10-10' }),
          contentFixture({ title: 'Hoje', publishOn: '2026-10-11', status: 'approved' }),
          contentFixture({ title: 'Amanhã', publishOn: '2026-10-12', status: 'approved' }),
          contentFixture({ title: 'Mais adiante', publishOn: '2026-10-25' })
        ]
      }
    });
    renderScreen(impl, url(padaria.id));
    await ready();

    const plannedOf = (title: string): boolean => {
      const tile = tiles().find((candidate) => candidate.textContent?.includes(title));
      if (tile === undefined) throw new Error(`No tile for ${title}`);
      return within(tile).queryByText('Planejado') !== null;
    };
    expect(plannedOf('Ontem')).toBe(false);
    expect(plannedOf('Hoje')).toBe(false);
    expect(plannedOf('Amanhã')).toBe(true);
    expect(plannedOf('Mais adiante')).toBe(true);
  });

  it('does not follow the period: the month and the week leave the phone as it is, and the feed asks for none', async () => {
    const { impl, calls } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ title: 'De setembro', publishOn: '2026-09-29' }),
          contentFixture({ title: 'De outubro', publishOn: '2026-10-02' }),
          contentFixture({ title: 'Desta semana', publishOn: '2026-10-09' }),
          contentFixture({ title: 'De novembro', publishOn: '2026-11-10' })
        ]
      }
    });
    renderScreen(impl, url(padaria.id));
    await ready();
    const all = ['De novembro · Imagem · 10/11', 'Desta semana · Imagem · 09/10', 'De outubro · Imagem · 02/10', 'De setembro · Imagem · 29/09'];
    expect(tileTexts()).toEqual(all);

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await waitFor(() => expect(calls).toContain(`GET /agencies/${AGENCY_A}/clients/${padaria.id}/contents?from=2026-10-26&to=2026-12-06`));
    expect(tileTexts()).toEqual(all);

    fireEvent.click(screen.getByRole('radio', { name: 'Semana' }));
    await waitFor(() => expect(calls.filter((call) => /contents\?from=/.test(call))).toHaveLength(3));
    expect(tileTexts()).toEqual(all);
    // Read once, with no period in it, and not again for the moves through the calendar.
    expect(calls.filter((call) => /contents\/feed/.test(call))).toEqual([`GET /agencies/${AGENCY_A}/clients/${padaria.id}/contents/feed`]);
  });

  it('shows the whole feed of the client whatever period the address names', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'De novembro', publishOn: '2026-11-10' }), contentFixture({ title: 'De outubro', publishOn: '2026-10-07' })] } });
    renderScreen(impl, url(padaria.id, '?data=2026-11-01'));
    await ready();
    expect(tileTexts()).toEqual(['De novembro · Imagem · 10/11', 'De outubro · Imagem · 07/10']);
  });

  it('says there is no post, with no grid of empty frames, when there is nothing to show, and only then', async () => {
    const empty = makeFetch();
    const first = renderScreen(empty.impl, url(padaria.id));
    expect(await screen.findByText('Nenhum post planejado ainda.')).toBeTruthy();
    expect(document.querySelectorAll('.content-feed__slot')).toHaveLength(0);
    expect(document.querySelector('.content-feed__grid')).toBeNull();
    first.unmount();

    // A feed with only what the grid leaves out is empty for the grid, though not for the calendar.
    const onlyOthers = makeFetch({ contents: { [padaria.id]: [contentFixture({ format: 'long_video', publishOn: '2026-10-14' }), contentFixture({ status: 'cancelled', publishOn: '2026-10-15' })] } });
    const second = renderScreen(onlyOthers.impl, url(padaria.id));
    expect(await screen.findByText('Nenhum post planejado ainda.')).toBeTruthy();
    expect(screen.queryByText('Nenhum conteúdo planejado neste período.')).toBeNull();
    second.unmount();

    const filled = makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-14' })] } });
    renderScreen(filled.impl, url(padaria.id));
    await ready();
    expect(screen.queryByText('Nenhum post planejado ainda.')).toBeNull();
    // One post is one tile: nothing is drawn for the eight places a full page would have.
    expect(document.querySelectorAll('.content-feed__slot')).toHaveLength(0);
    expect(document.querySelectorAll('.content-feed__tile')).toHaveLength(1);
    expect(document.querySelectorAll('.content-feed__tile--empty')).toHaveLength(0);
  });

  it('shows a skeleton of the grid while the feed loads, and the calendar changing its period does not touch the phone', async () => {
    const heldFeed = deferred<Response>();
    const loading = renderScreen(makeFetch({ feed: () => heldFeed.promise }).impl, url(confeitaria.id));
    await waitFor(() => expect(document.querySelectorAll('.content-feed__skeleton')).toHaveLength(9));
    expect(screen.queryByText('Nenhum post planejado ainda.')).toBeNull();
    loading.unmount();

    const heldPeriod = deferred<Response>();
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Do fim de outubro', publishOn: '2026-10-30' })] },
      period: (_client, from, to) => from === '2026-10-26' ? heldPeriod.promise.then(() => json({ data: { contents: [], storyScripts: [] }, meta: { from, to, count: 0 } })) : undefined
    });
    renderScreen(impl, url(padaria.id));
    await ready();
    expect(tileTexts()).toEqual(['Do fim de outubro · Imagem · 30/10']);
    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await screen.findByText('Atualizando…');
    expect(tileTexts()).toEqual(['Do fim de outubro · Imagem · 30/10']);
    expect(document.querySelectorAll('.content-feed__skeleton')).toHaveLength(0);
    heldPeriod.resolve(json({}));
    await waitFor(() => expect(screen.queryByText('Atualizando…')).toBeNull());
    expect(tileTexts()).toEqual(['Do fim de outubro · Imagem · 30/10']);
  });

  it('shows no feed of another client while the next client loads', async () => {
    const held = deferred<Response>();
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Da padaria', publishOn: '2026-10-14' })] },
      feed: (clientId) => clientId === confeitaria.id ? held.promise : undefined
    });
    renderScreen(impl, url(padaria.id));
    await ready();
    fireEvent.click(await screen.findByRole('link', { name: 'Confeitaria Doce' }));
    await waitFor(() => expect(probe.pathname).toBe(url(confeitaria.id)));
    expect(screen.queryByText(/Da padaria/)).toBeNull();
    await waitFor(() => expect(document.querySelectorAll('.content-feed__skeleton')).toHaveLength(9));
    held.resolve(json({ data: { contents: [], nextCursor: null, counters: { posts: 0, approved: 0, awaitingApproval: 0 } }, meta: { count: 0 } }));
    expect(await screen.findByText('Nenhum post planejado ainda.')).toBeTruthy();
  });

  it('opens the phone on the newest post when it goes back to a client that is in the cache, not where it was left', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Da padaria', publishOn: '2026-10-14' })] } });
    renderScreen(impl, url(padaria.id));
    await ready();
    const first = await screen.findByRole('region', { name: 'Posts do feed' });
    first.scrollTop = 500;
    expect(first.scrollTop).toBe(500);

    fireEvent.click(await screen.findByRole('link', { name: 'Confeitaria Doce' }));
    await waitFor(() => expect(probe.pathname).toBe(url(confeitaria.id)));
    await screen.findByText('Nenhum post planejado ainda.');
    fireEvent.click(await screen.findByRole('link', { name: 'Padaria Central' }));
    await waitFor(() => expect(probe.pathname).toBe(url(padaria.id)));
    await ready();

    const back = await screen.findByRole('region', { name: 'Posts do feed' });
    expect(back.scrollTop).toBe(0);
    expect(tileTexts()).toEqual(['Da padaria · Imagem · 14/10']);
  });

  it('shows the handle of the client above the grid, and nothing when the client has none', async () => {
    const first = renderScreen(makeFetch().impl, url(padaria.id));
    expect(await screen.findByText('@padariacentral')).toBeTruthy();
    expect(within(feedRegion()).getByText('@padariacentral')).toBeTruthy();
    first.unmount();

    renderScreen(makeFetch().impl, url(confeitaria.id));
    await screen.findByText('Nenhum post planejado ainda.');
    expect(document.querySelector('.content-feed__handle')).toBeNull();
  });

  it('gives the error of the feed, with "Tentar de novo", and brings the grid back', async () => {
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Voltou', publishOn: '2026-10-14' })] },
      feed: (_client, _cursor, call) => call <= 2 ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) : undefined
    });
    renderScreen(impl, url(padaria.id));

    expect(await within(await screen.findByRole('complementary', { name: 'Prévia do feed' })).findByText('Não foi possível carregar o feed.', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('Nenhum post planejado ainda.')).toBeNull();
    fireEvent.click(within(feedRegion()).getByRole('button', { name: 'Tentar de novo' }));
    await ready();
    expect(tileTexts()).toEqual(['Voltou · Imagem · 14/10']);
  });

  it('renders what the server wrote as text, never as markup', async () => {
    const hostile = '<img src=x onerror="document.title=1"><b>negrito</b>';
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: hostile, publishOn: '2026-10-14' })] } });
    renderScreen(impl, url(padaria.id));
    await ready();

    expect(tileTexts()).toEqual([`${hostile} · Imagem · 14/10`]);
    expect(feedRegion().querySelector('b')).toBeNull();
    expect(feedRegion().querySelector('img')).toBeNull();
  });
});

describe('the cover of a tile', () => {
  const ASSET = 'a1a1a1a1-0000-4000-8000-000000000001';
  const coverCalls = (calls: readonly string[]): string[] => calls.filter((call) => /\/download-url/.test(call));

  it('is the thumbnail of the cover asset, never the original, read once however many times it is drawn', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Com capa', publishOn: '2026-10-14', coverAssetId: ASSET })] } });
    renderScreen(impl, url(padaria.id));

    await waitFor(() => expect(feedRegion().querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET}.jpg`));
    expect(feedRegion().querySelector('img')?.getAttribute('alt')).toBe('');
    expect(coverCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET}/download-url?variant=thumbnail`]);
  });

  it('draws the first media of a post that has no chosen cover, as the thumbnail of that asset (issue #606)', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Post de imagem', publishOn: '2026-10-14', format: 'image', thumbnailAssetId: ASSET })] } });
    renderScreen(impl, url(padaria.id));

    await waitFor(() => expect(feedRegion().querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET}.jpg`));
    expect(coverCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET}/download-url?variant=thumbnail`]);
  });

  it('asks for the frame of a reels that has no chosen cover as the thumbnail, and keeps the shape when it has none yet (issue #606)', async () => {
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Filme sem capa', publishOn: '2026-10-14', format: 'reels', coverAssetId: null, thumbnailAssetId: ASSET })] },
      cover: () => json({ error: { code: 'VARIANT_NOT_READY', message: 'This variant has not been generated yet.' } }, 409)
    });
    renderScreen(impl, url(padaria.id));
    await ready();

    await waitFor(() => expect(coverCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET}/download-url?variant=thumbnail`]));
    await waitFor(() => expect(shapeOf(feedRegion().querySelector('.content-feed__cover--placeholder'))).toBe('clapperboard'));
    expect(feedRegion().querySelector('img')).toBeNull();
  });

  it('keeps its URL until 30 s before it expires, and asks for a new one after that', async () => {
    const queryClient = createQueryClient();
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Com capa', publishOn: '2026-10-14', coverAssetId: ASSET })] } });
    const first = renderScreen(impl, url(padaria.id), queryClient);
    await waitFor(() => expect(feedRegion().querySelector('img')).not.toBeNull());
    expect(coverCalls(calls)).toHaveLength(1);
    first.unmount();

    // The URL expires at 01:45 and is kept until 30 s before that: one second before the margin the cover is drawn from the cache.
    vi.setSystemTime(new Date('2026-10-12T01:44:29Z'));
    const second = renderScreen(impl, url(padaria.id), queryClient);
    await waitFor(() => expect(feedRegion().querySelector('img')).not.toBeNull());
    expect(coverCalls(calls)).toHaveLength(1);
    second.unmount();

    // One second past the margin the URL is stale, so the same cover asks for a new one.
    vi.setSystemTime(new Date('2026-10-12T01:44:31Z'));
    renderScreen(impl, url(padaria.id), queryClient);
    await waitFor(() => expect(coverCalls(calls)).toHaveLength(2));
  });

  it('is the shape of the format when there is no cover, and when the route refuses', async () => {
    const { impl, calls } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ title: 'Reels', publishOn: '2026-10-14', format: 'reels' }),
          contentFixture({ title: 'Carrossel', publishOn: '2026-10-15', format: 'carousel' }),
          contentFixture({ title: 'Recusada', publishOn: '2026-10-16', format: 'image', coverAssetId: ASSET })
        ]
      },
      cover: () => json({ error: { code: 'VARIANT_NOT_READY', message: 'This variant has not been generated yet.' } }, 409)
    });
    renderScreen(impl, url(padaria.id));
    await ready();

    await waitFor(() => expect(coverCalls(calls)).toHaveLength(1));
    const shapes = Array.from(feedRegion().querySelectorAll('.content-feed__cover--placeholder')).map((cover) => shapeOf(cover));
    expect(shapes).toEqual(['image', 'gallery-vertical', 'clapperboard']);
    expect(feedRegion().querySelector('img')).toBeNull();
  });
});

describe('the feed is the phone beside the calendar, and a view of its own', () => {
  it('has one feed on the screen, at the side of the calendar, and no tab to swap them', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'De outubro', publishOn: '2026-10-07' })] } });
    renderScreen(impl, url(padaria.id));
    await ready();

    expect(screen.getAllByRole('complementary', { name: 'Prévia do feed' })).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'Prévia do feed' })).toBeNull();
    expect(document.querySelector('.content-calendar')).not.toBeNull();
    expect(screen.queryByRole('tab', { name: 'Feed' })).toBeNull();
    // The same feed is also one of the three views of the screen, on its own, with no phone around it.
    expect(screen.getByRole('radio', { name: 'Feed' })).toBeTruthy();
  });

  it('opens the calendar with the feed beside it for the old feed address, and writes nothing to the URL', async () => {
    renderScreen(makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'De outubro', publishOn: '2026-10-07' })] } }).impl, url(padaria.id, '?vista=feed'));
    await ready();

    expect(document.querySelector('.content-calendar')).not.toBeNull();
    expect(screen.getAllByRole('complementary', { name: 'Prévia do feed' })).toHaveLength(1);
    expect(tileTexts()).toEqual(['De outubro · Imagem · 07/10']);
    expect(probe.search).toBe('?vista=feed');
  });
});

describe('the profile preview (state of each post and counters)', () => {
  const statuses = [
    ['in_production', 'Produção'], ['awaiting_approval', 'Aguardando'], ['adjusting', 'Em ajuste'], ['approved', 'Pronto'], ['published', 'Publicado']
  ] as const;

  it('says the state of each post on its tile, in words and not only by the colour of the dot', async () => {
    const rows = statuses.map(([status], index) => contentFixture({ title: `Post ${status}`, publishOn: `2026-10-${String(index + 2).padStart(2, '0')}`, status }));
    const { impl } = makeFetch({ contents: { [padaria.id]: rows } });
    renderScreen(impl, url(padaria.id));
    await ready();

    for (const [status, label] of statuses) {
      const tile = tiles().find((candidate) => candidate.textContent?.includes(`Post ${status}`));
      expect(within(tile!).getByText(label)).toBeTruthy();
      expect(tile!.getAttribute('data-status')).toBe(status);
    }
  });

  it('counts the feed beside the avatar: the posts of the grid, the ready ones and the ones waiting for the client', async () => {
    const { impl } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ publishOn: '2026-10-02', status: 'published' }),
          contentFixture({ publishOn: '2026-10-03', status: 'approved' }),
          contentFixture({ publishOn: '2026-10-04', status: 'approved' }),
          contentFixture({ publishOn: '2026-10-05', status: 'awaiting_approval' }),
          contentFixture({ publishOn: '2026-10-06', status: 'awaiting_approval', format: 'long_video' }),
          contentFixture({ publishOn: '2026-10-07', status: 'cancelled' })
        ]
      }
    });
    renderScreen(impl, url(padaria.id));
    await ready();

    const counters = feedRegion().querySelector('.content-feed__counters')!;
    const valueOf = (term: string): string | null => within(counters as HTMLElement).getByText(term).nextElementSibling?.textContent ?? null;
    // The long video and the cancelled one are not posts of the feed, so they are not counted either.
    expect(valueOf('posts')).toBe('4');
    expect(valueOf('prontos')).toBe('2');
    expect(valueOf('aguardando')).toBe('1');
    expect(within(counters as HTMLElement).queryByText('no período')).toBeNull();
  });

  it('counts the whole feed of the client with what the API says, not the posts that were loaded', async () => {
    const { impl } = makeFetch({
      contents: { [padaria.id]: Array.from({ length: 12 }, (_value, index) => contentFixture({ publishOn: `2026-10-${String(index + 1).padStart(2, '0')}` })) },
      counters: () => ({ posts: 57, approved: 3, awaitingApproval: 5 })
    });
    renderScreen(impl, url(padaria.id));
    await ready();

    const counters = feedRegion().querySelector<HTMLElement>('.content-feed__counters')!;
    expect(within(counters).getByText('posts').nextElementSibling?.textContent).toBe('57');
    expect(within(counters).getByText('prontos').nextElementSibling?.textContent).toBe('3');
    expect(within(counters).getByText('aguardando').nextElementSibling?.textContent).toBe('5');
    expect(feedRegion().querySelectorAll('.content-feed__tile')).toHaveLength(9);
  });

  it('says "pronto" for one ready post and "prontos" for any other number', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-03', status: 'approved' })] } });
    renderScreen(impl, url(padaria.id));
    await ready();

    const counters = feedRegion().querySelector<HTMLElement>('.content-feed__counters')!;
    expect(within(counters).getByText('pronto').nextElementSibling?.textContent).toBe('1');
    expect(within(counters).queryByText('prontos')).toBeNull();
  });
});

const realRect = Element.prototype.getBoundingClientRect;
afterEach(() => { Element.prototype.getBoundingClientRect = realRect; });

/** The layout jsdom does not have: a screen of `screenHeight` px over a header and rows of `rowHeight` px, three tiles to a row. */
const withLayout = (scroller: HTMLElement, { screenHeight = 300, rowHeight = 200 } = {}) => {
  let top = 0;
  // A tile sits where its row puts it: the arrow measures the rows from the tiles themselves.
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    if (!this.classList.contains('content-feed__tile')) return realRect.call(this);
    const index = Array.from(scroller.querySelectorAll('.content-feed__tile')).indexOf(this);
    const y = 150 + Math.floor(index / 3) * rowHeight - top;
    return { x: 0, y, top: y, left: 0, right: 100, bottom: y + rowHeight, width: 100, height: rowHeight, toJSON: () => ({}) } as DOMRect;
  };
  const jumps: Array<{ top: number; behavior: ScrollBehavior | undefined }> = [];
  const height = (): number => 150 + Math.ceil(scroller.querySelectorAll('.content-feed__tile').length / 3) * rowHeight;
  const maxTop = (): number => Math.max(0, height() - screenHeight);
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => screenHeight });
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: height });
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: (value: number) => { top = Math.min(Math.max(0, value), maxTop()); } });
  scroller.scrollTo = ((options: ScrollToOptions) => {
    jumps.push({ top: options.top ?? 0, behavior: options.behavior });
    top = Math.min(Math.max(0, options.top ?? 0), maxTop());
    scroller.dispatchEvent(new Event('scroll'));
  }) as typeof scroller.scrollTo;
  return {
    jumps,
    maxTop,
    scrollTo(value: number) { top = Math.min(Math.max(0, value), maxTop()); fireEvent.scroll(scroller); },
    top: () => top
  };
};

describe('the phone scrolls inside its screen, nine posts at a time', () => {
  const posts = (count: number) => Array.from({ length: count }, (_value, index) => contentFixture({ title: `Post ${index + 1}`, publishOn: `2026-10-${String(index + 1).padStart(2, '0')}` }));
  const scrollerOf = (): HTMLElement => within(feedRegion()).getByRole('region', { name: 'Posts do feed' });
  const up = (): HTMLElement => within(feedRegion()).getByRole('button', { name: 'Rolar para cima' });
  const down = (): HTMLElement => within(feedRegion()).getByRole('button', { name: 'Rolar para baixo' });
  const locked = (button: HTMLElement): boolean => button.getAttribute('aria-disabled') === 'true';
  const feedCalls = (calls: readonly string[]): string[] => calls.filter((call) => /contents\/feed/.test(call));
  const wait = (ms: number): Promise<void> => new Promise<void>((done) => { setTimeout(done, ms); });

  /** Renders, lays the screen out before the first answer, and waits for the first nine. */
  const open = async (scenario: Scenario, layout?: { screenHeight?: number; rowHeight?: number }, entry = url(padaria.id)) => {
    const made = makeFetch(scenario);
    renderScreen(made.impl, entry);
    const scroller = await screen.findByRole('region', { name: 'Posts do feed' });
    const laid = withLayout(scroller, layout);
    await ready();
    return { ...made, scroller, laid };
  };

  it('is drawn on a device with a screen of its own height: a bezel, the camera island and the home bar, with the profile in the scroll', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: posts(2) } });
    renderScreen(impl, url(padaria.id));
    await ready();

    const phone = feedRegion().querySelector('.content-phone')!;
    expect(phone.classList.contains('content-phone--fixed')).toBe(true);
    expect(phone.querySelector('.content-phone__island')?.getAttribute('aria-hidden')).toBe('true');
    expect(phone.querySelector('.content-phone__home')?.getAttribute('aria-hidden')).toBe('true');
    expect(scrollerOf().querySelector('.content-feed__profile')).not.toBeNull();
    // The scroll is a stop of the keyboard, named for who does not see it.
    expect(scrollerOf().getAttribute('tabindex')).toBe('0');
  });

  it('opens on the newest post and shows nine, with no range counter and no empty slot', async () => {
    const { calls } = await open({ contents: { [padaria.id]: posts(14) } });

    expect(tileTexts()).toEqual(Array.from({ length: 9 }, (_value, index) => `Post ${14 - index} · Imagem · ${String(14 - index).padStart(2, '0')}/10`));
    expect(feedRegion().querySelector('.content-feed__range')).toBeNull();
    expect(feedRegion().textContent).not.toMatch(/\d+[–-]\d+ de \d+/);
    expect(feedRegion().querySelectorAll('.content-feed__slot')).toHaveLength(0);
    expect(feedCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/clients/${padaria.id}/contents/feed`]);
  });

  it('names the two arrows for who does not see them, and no arrow says page, left or right', async () => {
    await open({ contents: { [padaria.id]: posts(14) } });

    expect(within(feedRegion()).getByRole('navigation', { name: 'Rolagem do feed' })).toBeTruthy();
    expect(up().textContent).toBe('');
    expect(within(feedRegion()).queryByRole('button', { name: /Página|Próxima/ })).toBeNull();
  });

  it('moves one screen down with a smooth scroll, and the next nine load when the end comes near', async () => {
    const { calls, laid } = await open({ contents: { [padaria.id]: posts(30) } });
    expect(feedCalls(calls)).toHaveLength(1);
    expect(locked(up())).toBe(true);
    expect(locked(down())).toBe(false);

    fireEvent.click(down());
    expect(laid.jumps).toEqual([{ top: 600, behavior: 'smooth' }]);
    expect(locked(up())).toBe(false);
    // 750 px of grid, a screen of 300 and the top at 600 (three rows, clamped to 450): at the end, so the second page is asked for.
    await waitFor(() => expect(feedCalls(calls)).toEqual([
      `GET /agencies/${AGENCY_A}/clients/${padaria.id}/contents/feed`,
      `GET /agencies/${AGENCY_A}/clients/${padaria.id}/contents/feed?cursor=offset-9`
    ]));
    await waitFor(() => expect(tileTexts()).toHaveLength(18));
    expect(tileTexts()[9]).toBe('Post 21 · Imagem · 21/10');
  });

  it('loads on a wheel or a touch too: any scroll that nears the end', async () => {
    const { calls, laid } = await open({ contents: { [padaria.id]: posts(30) } });

    laid.scrollTo(100);
    await wait(20);
    expect(feedCalls(calls)).toHaveLength(1);
    laid.scrollTo(laid.maxTop() - 100);
    await waitFor(() => expect(feedCalls(calls)).toHaveLength(2));
  });

  it('moves one screen up, and locks the up arrow at the real start', async () => {
    const { laid } = await open({ contents: { [padaria.id]: posts(30) } });
    laid.scrollTo(450);
    expect(locked(up())).toBe(false);

    fireEvent.click(up());
    expect(laid.jumps.at(-1)).toEqual({ top: 0, behavior: 'smooth' });
    laid.scrollTo(0);
    expect(locked(up())).toBe(true);
    // A press at the start moves nothing.
    const before = laid.jumps.length;
    fireEvent.click(up());
    expect(laid.jumps).toHaveLength(before);
  });

  it('locks the down arrow only at the real end of the whole feed, and keeps the focus of the pressed arrow there', async () => {
    const { calls, laid } = await open({ contents: { [padaria.id]: posts(12) } });
    // Twelve posts: nine, then three. The end of the first nine is not the end of the feed.
    laid.scrollTo(laid.maxTop());
    await waitFor(() => expect(tileTexts()).toHaveLength(12));
    expect(feedCalls(calls)).toHaveLength(2);

    down().focus();
    laid.scrollTo(laid.maxTop());
    await waitFor(() => expect(locked(down())).toBe(true));
    expect((down() as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(down());
    expect(locked(up())).toBe(false);
    const before = laid.jumps.length;
    fireEvent.click(down());
    expect(laid.jumps).toHaveLength(before);
    expect(feedCalls(calls)).toHaveLength(2);
  });

  it('waits for the next nine when the arrow is pressed at the end of what is loaded, then moves one screen', async () => {
    const held = deferred<Response>();
    const rows = posts(20);
    const { laid } = await open({
      contents: { [padaria.id]: rows },
      feed: (_client, cursor) => cursor === 'offset-9' ? held.promise : undefined
    });
    laid.scrollTo(laid.maxTop());
    await screen.findByText('Carregando mais posts…');
    expect(locked(down())).toBe(false);
    const before = laid.jumps.length;
    const startedAt = laid.top();

    fireEvent.click(down());
    expect(laid.jumps).toHaveLength(before);
    held.resolve(json({
      data: { contents: feedItems(rows).slice(9, 18), nextCursor: 'offset-18', counters: { posts: 20, approved: 0, awaitingApproval: 0 } },
      meta: { count: 9 }
    }));

    await waitFor(() => expect(laid.jumps).toHaveLength(before + 1));
    expect(laid.jumps.at(-1)?.top).toBe(startedAt + 600);
  });

  it.each([120, 105, 80])('moves exactly three rows, whatever the height of a row (%i px), and not the height of the screen', async (rowHeight) => {
    const { laid } = await open({ contents: { [padaria.id]: posts(30) } }, { screenHeight: 200, rowHeight });
    fireEvent.click(down());
    expect(laid.jumps.at(-1)).toEqual({ top: 3 * rowHeight, behavior: 'smooth' });
    await waitFor(() => expect(tileTexts().length).toBeGreaterThan(9));
    laid.scrollTo(4 * rowHeight);
    fireEvent.click(up());
    expect(laid.jumps.at(-1)).toEqual({ top: rowHeight, behavior: 'smooth' });
  });

  it('locks both arrows when there are fewer than nine posts and they fit the screen', async () => {
    const { calls } = await open({ contents: { [padaria.id]: posts(5) } }, { screenHeight: 600, rowHeight: 100 });

    expect(tileTexts()).toHaveLength(5);
    expect(locked(up())).toBe(true);
    expect(locked(down())).toBe(true);
    fireEvent.click(down());
    fireEvent.click(up());
    expect(feedCalls(calls)).toHaveLength(1);
  });

  it('locks both arrows while there is nothing to show', async () => {
    renderScreen(makeFetch().impl, url(padaria.id));
    await screen.findByText('Nenhum post planejado ainda.');

    expect(locked(up())).toBe(true);
    expect(locked(down())).toBe(true);
  });

  it('animates the scroll, and jumps when the system asks for reduced motion', async () => {
    const { laid } = await open({ contents: { [padaria.id]: posts(30) } });
    fireEvent.click(down());
    expect(laid.jumps.at(-1)?.behavior).toBe('smooth');
    laid.scrollTo(100);

    const original = window.matchMedia;
    const asked: string[] = [];
    window.matchMedia = ((query: string) => { asked.push(query); return { matches: true, media: query } as MediaQueryList; }) as typeof window.matchMedia;
    try {
      fireEvent.click(down());
      expect(laid.jumps.at(-1)?.behavior).toBe('auto');
      fireEvent.click(up());
      expect(laid.jumps.at(-1)?.behavior).toBe('auto');
      expect(asked).toContain('(prefers-reduced-motion: reduce)');
    } finally {
      window.matchMedia = original;
    }
  });

  it('shows the error of a page that did not load, with a retry, and the arrows stay free to try again', async () => {
    let failing = true;
    const { calls, laid } = await open({
      contents: { [padaria.id]: posts(20) },
      feed: (_client, cursor) => cursor === 'offset-9' && failing ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) : undefined
    });
    laid.scrollTo(laid.maxTop());

    expect(await within(feedRegion()).findByText('Não foi possível carregar mais posts.', undefined, { timeout: 5000 })).toBeTruthy();
    expect(tileTexts()).toHaveLength(9);
    expect(locked(down())).toBe(false);
    // It does not loop on its own: a scroll more does not ask again.
    const asked = feedCalls(calls).length;
    laid.scrollTo(laid.maxTop() - 1);
    laid.scrollTo(laid.maxTop());
    await wait(1500);
    expect(feedCalls(calls)).toHaveLength(asked);

    failing = false;
    fireEvent.click(within(feedRegion()).getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(tileTexts()).toHaveLength(18));
    expect(within(feedRegion()).queryByText('Não foi possível carregar mais posts.')).toBeNull();
  });

  it('tries again by the down arrow too, when the page failed', async () => {
    let failing = true;
    const { laid } = await open({
      contents: { [padaria.id]: posts(20) },
      feed: (_client, cursor) => cursor === 'offset-9' && failing ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) : undefined
    });
    laid.scrollTo(laid.maxTop());
    await within(feedRegion()).findByText('Não foi possível carregar mais posts.', undefined, { timeout: 5000 });

    failing = false;
    fireEvent.click(down());
    await waitFor(() => expect(tileTexts()).toHaveLength(18));
  });

  it('opens a post keeping the query and the state, and the scroll is where it was left when the modal closes', async () => {
    const { scroller, laid } = await open({ contents: { [padaria.id]: posts(30) } }, undefined, url(padaria.id, '?data=2026-10-05'));
    laid.scrollTo(250);
    const link = within(feedRegion()).getAllByRole('link')[0]!;
    expect(link.getAttribute('href')).toMatch(/\/conteudos\/[^/?]+\/c0c0c0c0[^?]*\?data=2026-10-05$/);
    fireEvent.click(link);
    await waitFor(() => expect(probe.pathname).toMatch(/\/conteudos\/[^/]+\/c0c0c0c0/));
    expect(probe.search).toBe('?data=2026-10-05');

    expect(scrollerOf()).toBe(scroller);
    expect(laid.top()).toBe(250);
    await act(async () => { history.go(-1); });
    await waitFor(() => expect(probe.pathname).toBe(url(padaria.id)));
    expect(scrollerOf()).toBe(scroller);
    expect(laid.top()).toBe(250);
  });

  it('reads the feed again when a content is created, edited, moved or cancelled: what invalidates the calendar invalidates it', async () => {
    const rows = posts(3);
    const queryClient = createQueryClient();
    const { impl } = makeFetch({ contents: { [padaria.id]: rows } });
    renderScreen(impl, url(padaria.id), queryClient);
    await ready();
    expect(tileTexts()).toHaveLength(3);

    rows[2] = { ...rows[2]!, status: 'cancelled' };
    rows.push(contentFixture({ title: 'Novo', publishOn: '2026-10-28' }));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ['agency', AGENCY_A, 'contents', padaria.id] }); });

    await waitFor(() => expect(tileTexts()).toEqual(['Novo · Imagem · 28/10', 'Post 2 · Imagem · 02/10', 'Post 1 · Imagem · 01/10']));
  });

  it('is not drawn when the feed on its own screen is, and that one keeps the period and thirty to a page', async () => {
    const rows = Array.from({ length: 35 }, (_value, index) => contentFixture({ title: `Post ${index + 1}`, publishOn: `2026-10-${String((index % 28) + 1).padStart(2, '0')}`, publishAtTime: `${String(index % 24).padStart(2, '0')}:00` }));
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: rows } });
    renderScreen(impl, url(padaria.id, '?visao=feed'));

    const nav = await screen.findByRole('navigation', { name: 'Páginas do feed' });
    expect(within(nav).getByRole('button', { name: 'Próxima página' })).toBeTruthy();
    expect(nav.querySelector('.content-feed__range')?.textContent).toMatch(/^1–\d+ de \d+$/);
    expect(document.querySelectorAll('.content-feed-full .content-feed__tile').length).toBeLessThanOrEqual(30);
    expect(screen.queryByRole('complementary', { name: 'Prévia do feed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rolar para baixo' })).toBeNull();
    expect(within(document.querySelector<HTMLElement>('.content-feed__counters')!).getByText('no período')).toBeTruthy();
    expect(feedCalls(calls)).toEqual([]);
  });
});
