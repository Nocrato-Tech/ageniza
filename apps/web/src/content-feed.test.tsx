// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentListItem } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { feedItems } from './content-feed.js';
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
}

const makeFetch = (scenario: Scenario = {}) => {
  const calls: string[] = [];
  let periodCalls = 0;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${path}${url.search}`);
    if (path.endsWith('/auth/session')) return json(sessionBody);
    const me = /\/agencies\/([^/]+)\/me$/.exec(path);
    if (me !== null) {
      return json({ agencyId: me[1], agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Papel' }, permissions: ['conteudo.visualizar', 'cliente.visualizar'] });
    }
    if (/\/agencies\/[^/]+\/clients$/.test(path)) return json({ data: ROSTER, meta: { page: 1, pageSize: 100, totalItems: ROSTER.length, totalPages: 1 } });
    const media = /\/agencies\/[^/]+\/media\/([^/]+)\/download-url$/.exec(path);
    if (media !== null) return scenario.cover?.(media[1]!) ?? json({ url: `https://storage.test/${media[1]}.jpg`, expiresAt: '2026-10-12T01:45:00.000Z' });
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

  it('keeps every post of the period in the grid, with no limit of nine', async () => {
    const rows = Array.from({ length: 14 }, (_value, index) => contentFixture({ title: `Post ${index + 1}`, publishOn: `2026-10-${String(index + 1).padStart(2, '0')}` }));
    const { impl } = makeFetch({ contents: { [padaria.id]: rows } });
    renderScreen(impl, url(padaria.id));
    await ready();

    expect(tileTexts()).toHaveLength(14);
    expect(tileTexts()[0]).toBe('Post 14 · Imagem · 14/10');
    expect(tileTexts()[13]).toBe('Post 1 · Imagem · 01/10');
  });

  it('follows the period: the month and the week change the grid, and the days asked for are the calendar\'s', async () => {
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
    // October on screen reaches back to Monday the 28th of September.
    expect(tileTexts()).toEqual(['Desta semana · Imagem · 09/10', 'De outubro · Imagem · 02/10', 'De setembro · Imagem · 29/09']);

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await waitFor(() => expect(tileTexts()).toEqual(['De novembro · Imagem · 10/11']));
    expect(calls).toContain(`GET /agencies/${AGENCY_A}/clients/${padaria.id}/contents?from=2026-10-26&to=2026-12-06`);

    fireEvent.click(screen.getByRole('button', { name: 'Hoje' }));
    await waitFor(() => expect(tileTexts()).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Semana' }));
    await waitFor(() => expect(tileTexts()).toEqual(['Desta semana · Imagem · 09/10']));
  });

  it('reads the period from the URL, so the feed and the calendar are the same reload', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'De novembro', publishOn: '2026-11-10' }), contentFixture({ title: 'De outubro', publishOn: '2026-10-07' })] } });
    renderScreen(impl, url(padaria.id, '?data=2026-11-01'));
    await ready();
    expect(tileTexts()).toEqual(['De novembro · Imagem · 10/11']);
  });

  it('draws the empty grid and says "Planeje o primeiro post" when there is nothing to show, and only then', async () => {
    const empty = makeFetch();
    const first = renderScreen(empty.impl, url(padaria.id));
    expect(await screen.findByText('Planeje o primeiro post')).toBeTruthy();
    expect(document.querySelectorAll('.content-feed__tile--empty')).toHaveLength(9);
    first.unmount();

    // A period with only what the feed leaves out is empty for the feed, though not for the calendar.
    const onlyOthers = makeFetch({ contents: { [padaria.id]: [contentFixture({ format: 'long_video', publishOn: '2026-10-14' }), contentFixture({ status: 'cancelled', publishOn: '2026-10-15' })] } });
    const second = renderScreen(onlyOthers.impl, url(padaria.id));
    expect(await screen.findByText('Planeje o primeiro post')).toBeTruthy();
    expect(screen.queryByText('Nenhum conteúdo planejado neste período.')).toBeNull();
    second.unmount();

    const filled = makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-14' })] } });
    renderScreen(filled.impl, url(padaria.id));
    await ready();
    expect(screen.queryByText('Planeje o primeiro post')).toBeNull();
    expect(document.querySelectorAll('.content-feed__tile--empty')).toHaveLength(0);
  });

  it('shows a skeleton of the grid on the first load, and keeps the previous grid while the next period loads', async () => {
    const held = deferred<Response>();
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Do fim de outubro', publishOn: '2026-10-30' })] },
      period: (_client, from, to) => from === '2026-10-26' ? held.promise.then(() => json({ data: { contents: [], storyScripts: [] }, meta: { from, to, count: 0 } })) : undefined
    });
    const first = makeFetch({ period: () => deferred<Response>().promise });
    const loading = renderScreen(first.impl, url(confeitaria.id));
    await waitFor(() => expect(document.querySelectorAll('.content-feed__skeleton')).toHaveLength(9));
    expect(screen.queryByText('Planeje o primeiro post')).toBeNull();
    loading.unmount();

    renderScreen(impl, url(padaria.id));
    await ready();
    expect(tileTexts()).toEqual(['Do fim de outubro · Imagem · 30/10']);
    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await screen.findByText('Atualizando…');
    expect(tileTexts()).toEqual(['Do fim de outubro · Imagem · 30/10']);
    expect(document.querySelectorAll('.content-feed__skeleton')).toHaveLength(0);
    held.resolve(json({}));
    expect(await screen.findByText('Planeje o primeiro post')).toBeTruthy();
  });

  it('shows no feed of another client while the next client loads', async () => {
    const held = deferred<Response>();
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Da padaria', publishOn: '2026-10-14' })] },
      period: (clientId, from, to) => clientId === confeitaria.id ? held.promise.then(() => json({ data: { contents: [], storyScripts: [] }, meta: { from, to, count: 0 } })) : undefined
    });
    renderScreen(impl, url(padaria.id));
    await ready();
    fireEvent.click(await screen.findByRole('link', { name: 'Confeitaria Doce' }));
    await waitFor(() => expect(probe.pathname).toBe(url(confeitaria.id)));
    expect(screen.queryByText(/Da padaria/)).toBeNull();
    expect(document.querySelectorAll('.content-feed__skeleton')).toHaveLength(9);
    held.resolve(json({}));
    expect(await screen.findByText('Planeje o primeiro post')).toBeTruthy();
  });

  it('shows the handle of the client above the grid, and nothing when the client has none', async () => {
    const first = renderScreen(makeFetch().impl, url(padaria.id));
    expect(await screen.findByText('@padariacentral')).toBeTruthy();
    expect(within(feedRegion()).getByText('@padariacentral')).toBeTruthy();
    first.unmount();

    renderScreen(makeFetch().impl, url(confeitaria.id));
    await screen.findByText('Planeje o primeiro post');
    expect(document.querySelector('.content-feed__handle')).toBeNull();
  });

  it('gives the error of the period, with "Tentar de novo", and brings the grid back', async () => {
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Voltou', publishOn: '2026-10-14' })] },
      period: (_client, _from, _to, call) => call <= 2 ? json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }, 500) : undefined
    });
    renderScreen(impl, url(padaria.id));

    expect(await screen.findByText('Não foi possível carregar os conteúdos. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('Planeje o primeiro post')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
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

describe('the Feed tab', () => {
  const rows = () => [
    contentFixture({ title: 'De outubro', publishOn: '2026-10-07' }),
    contentFixture({ title: 'De novembro', publishOn: '2026-11-10' })
  ];

  it('swaps the calendar for the grid of the same period, writes the view to the URL and keeps the navigation', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: rows() } });
    renderScreen(impl, url(padaria.id));
    await ready();
    expect(screen.getByRole('tab', { name: 'Calendário' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('complementary', { name: 'Prévia do feed' })).toBeTruthy();
    expect(document.querySelector('.content-calendar')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Feed' }));
    await waitFor(() => expect(probe.search).toBe('?vista=feed'));
    expect(screen.getByRole('tab', { name: 'Feed' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Calendário' }).getAttribute('aria-selected')).toBe('false');
    // One feed on the screen, in the place of the calendar: no second one at the side.
    expect(screen.queryByRole('complementary', { name: 'Prévia do feed' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Prévia do feed' })).toBeTruthy();
    expect(document.querySelector('.content-calendar')).toBeNull();
    expect(tileTexts()).toEqual(['De outubro · Imagem · 07/10']);

    fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
    await waitFor(() => expect(tileTexts()).toEqual(['De novembro · Imagem · 10/11']));
    expect(probe.search).toBe('?vista=feed&data=2026-11-01');

    fireEvent.click(screen.getByRole('tab', { name: 'Calendário' }));
    await waitFor(() => expect(probe.search).toBe('?data=2026-11-01'));
    expect(document.querySelector('.content-calendar')).not.toBeNull();
    expect(screen.getByRole('complementary', { name: 'Prévia do feed' })).toBeTruthy();
  });

  it('opens on the feed from the URL, and on the calendar for a view that does not exist', async () => {
    const first = renderScreen(makeFetch({ contents: { [padaria.id]: rows() } }).impl, url(padaria.id, '?vista=feed'));
    await ready();
    expect(screen.getByRole('tab', { name: 'Feed' }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.content-calendar')).toBeNull();
    first.unmount();

    renderScreen(makeFetch({ contents: { [padaria.id]: rows() } }).impl, url(padaria.id, '?vista=inexistente'));
    await ready();
    expect(screen.getByRole('tab', { name: 'Calendário' }).getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.content-calendar')).not.toBeNull();
  });

  it('shows the empty grid and the skeleton in the feed view too, with Pastas open beside it', async () => {
    const held = deferred<Response>();
    const loading = renderScreen(makeFetch({ period: () => held.promise }).impl, url(padaria.id, '?vista=feed'));
    await waitFor(() => expect(document.querySelectorAll('.content-feed__skeleton')).toHaveLength(9));
    loading.unmount();

    renderScreen(makeFetch().impl, url(padaria.id, '?vista=feed'));
    expect(await screen.findByText('Planeje o primeiro post')).toBeTruthy();
    const pastas = screen.getByRole('tab', { name: 'Pastas' }) as HTMLButtonElement;
    expect(pastas.disabled).toBe(false);
    expect(pastas.getAttribute('aria-selected')).toBe('false');
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

  it('counts the period beside the avatar: the posts of the grid, the ready ones and the ones waiting for the client', async () => {
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
    expect(valueOf('no período')).toBe('4');
    expect(valueOf('prontos')).toBe('2');
    expect(valueOf('aguardando')).toBe('1');
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
