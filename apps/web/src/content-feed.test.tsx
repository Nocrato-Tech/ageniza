// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentListItem, StoryScriptListItem } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { clientRegistrationExtras } from './client-registration-fixture.js';
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
  closingDate: null, archivedAt: null, ...clientRegistrationExtras,
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
    approval: null,
    ...overrides,
    // As the API answers: the chosen cover is the file that serves as the cover, unless the test says another.
    thumbnailAssetId: 'thumbnailAssetId' in overrides ? (overrides.thumbnailAssetId ?? null) : (overrides.coverAssetId ?? null)
  };
};

interface Scenario {
  readonly contents?: Readonly<Record<string, readonly ContentListItem[]>>;
  readonly period?: (clientId: string, from: string, to: string, call: number) => Response | Promise<Response> | undefined;
  readonly cover?: (assetId: string) => Response | undefined;
  readonly scripts?: Readonly<Record<string, readonly StoryScriptListItem[]>>;
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
      return json({ agencyId: me[1], agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Papel' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions: ['conteudo.visualizar', 'cliente.visualizar'] });
    }
    if (/\/agencies\/[^/]+\/clients$/.test(path)) return json({ data: ROSTER, meta: { page: 1, pageSize: 100, totalItems: ROSTER.length, totalPages: 1 } });
    const media = /\/agencies\/[^/]+\/media\/([^/]+)\/download-url$/.exec(path);
    if (media !== null) return scenario.cover?.(media[1]!) ?? json({ url: `https://storage.test/${media[1]}.jpg`, expiresAt: '2026-10-12T01:45:00.000Z' });
    const script = /\/agencies\/[^/]+\/clients\/[^/]+\/story-scripts\/([^/]+)$/.exec(path);
    if (script !== null) {
      const found = Object.values(scenario.scripts ?? {}).flat().find((candidate) => candidate.id === script[1]);
      return found === undefined ? json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404) : json({ ...found, scenes: [], recordedBy: null, recordedAt: null, createdAt: '2026-10-11T12:00:00.000Z' });
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
      return json({ data: { contents: rows, storyScripts: scenario.scripts?.[period[1]!] ?? [] }, meta: { from, to, count: rows.length } });
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

const url = (clientId: string, search = '') => `/agencia/${AGENCY_A}/conteudos/${clientId}${search}`;

/** The lucide icon that draws the shape of a format: the name lucide-react gives the class of its svg. */
const shapeOf = (cover: Element | null | undefined): string | null => {
  const names = (cover?.querySelector('.format-shape > svg')?.getAttribute('class') ?? '').split(' ').filter((name) => name.startsWith('lucide-'));
  return names.length === 0 ? null : names[0]!.slice('lucide-'.length);
};

const feedRegion = (): HTMLElement => screen.getByRole('region', { name: 'Simulador do perfil do Instagram' });
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

const FEED = '?visao=feed';
const feedUrl = (clientId: string) => url(clientId, FEED);

describe('the feed view: the profile on the phone of the board', () => {
  it('draws the phone with the handle, the name, the counters of the period and the posts, latest first, without the cancelled, the long video and the VSL', async () => {
    const { impl } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ title: 'Primeiro do mês', publishOn: '2026-10-11', format: 'image', status: 'published' }),
          contentFixture({ title: 'Reels do meio', publishOn: '2026-10-14', publishAtTime: '18:00', format: 'reels', status: 'approved' }),
          contentFixture({ title: 'Carrossel do meio', publishOn: '2026-10-14', publishAtTime: '09:00', format: 'carousel' }),
          contentFixture({ title: 'Último do mês', publishOn: '2026-10-28', format: 'image', status: 'awaiting_approval' }),
          contentFixture({ title: 'Cancelado', publishOn: '2026-10-15', status: 'cancelled' }),
          contentFixture({ title: 'Filme completo', publishOn: '2026-10-16', format: 'long_video' }),
          contentFixture({ title: 'Vendas em vídeo', publishOn: '2026-10-17', format: 'vsl' })
        ]
      }
    });
    renderScreen(impl, feedUrl(padaria.id));
    await ready();

    expect(within(feedRegion()).getByText('@padariacentral')).toBeTruthy();
    expect(within(feedRegion()).getByText('Padaria Central')).toBeTruthy();
    expect(tileTexts()).toEqual([
      'Último do mês · Imagem · 28/10 · planejado',
      'Reels do meio · Reels · 14/10 · planejado',
      'Carrossel do meio · Carrossel · 14/10 · planejado',
      'Primeiro do mês · Imagem · 11/10'
    ]);
    expect(feedRegion().querySelector('.content-phone__island')).not.toBeNull();
    expect(feedRegion().querySelector('.content-phone__home')).not.toBeNull();
    expect(within(feedRegion()).queryByText(/Cancelado|Filme completo|Vendas em vídeo/)).toBeNull();
    expect(document.querySelector('.content-calendar')).toBeNull();
  });

  it('draws the date, the format and the state of each tile, with the words of the board', async () => {
    const { impl } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ title: 'Produção', publishOn: '2026-10-20', format: 'reels', status: 'in_production' }),
          contentFixture({ title: 'Espera', publishOn: '2026-10-21', format: 'carousel', status: 'awaiting_approval' }),
          contentFixture({ title: 'Ajuste', publishOn: '2026-10-22', format: 'image', status: 'adjusting' }),
          contentFixture({ title: 'Pronto', publishOn: '2026-10-23', format: 'image', status: 'approved' }),
          contentFixture({ title: 'No ar', publishOn: '2026-10-11', format: 'image', status: 'published' }),
          contentFixture({ title: 'Agendado', publishOn: '2026-10-12', publishAtTime: '08:00', format: 'image', status: 'approved' }),
          contentFixture({ title: 'Perdido', publishOn: '2026-10-05', format: 'image', status: 'awaiting_approval' })
        ]
      }
    });
    renderScreen(impl, feedUrl(padaria.id));
    await ready();

    const tile = (title: string): HTMLElement => tiles().find((candidate) => candidate.textContent?.includes(title))!;
    const stateOf = (title: string): string | undefined => tile(title).querySelector('.content-feed__state')?.textContent ?? undefined;
    expect(stateOf('Produção')).toBe('Produção');
    expect(stateOf('Espera')).toBe('Aguardando');
    expect(stateOf('Ajuste')).toBe('Em ajuste');
    expect(stateOf('Pronto')).toBe('Pronto');
    expect(stateOf('No ar')).toBe('Publicado');
    expect(stateOf('Agendado')).toBe('Agendado');
    expect(stateOf('Perdido')).toBe('Atrasado');
    expect(tile('Agendado').getAttribute('data-state')).toBe('scheduled');
    expect(tile('Perdido').getAttribute('data-state')).toBe('late');
    expect(tile('Produção').querySelector('time')?.textContent).toBe('20 out');
    expect(tile('Produção').querySelector('svg.lucide-clapperboard')).not.toBeNull();
    expect(tile('Espera').querySelector('svg.lucide-gallery-vertical')).not.toBeNull();
    expect(tile('Pronto').querySelector('.content-feed__format')).toBeNull();
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
    renderScreen(impl, feedUrl(padaria.id));
    await ready();

    const plannedOf = (title: string): boolean => {
      const tile = tiles().find((candidate) => candidate.textContent?.includes(title));
      if (tile === undefined) throw new Error(`No tile for ${title}`);
      return tile.hasAttribute('data-planned') && /planejado/.test(tile.textContent ?? '');
    };
    expect(plannedOf('Ontem')).toBe(false);
    expect(plannedOf('Hoje')).toBe(false);
    expect(plannedOf('Amanhã')).toBe(true);
    expect(plannedOf('Mais adiante')).toBe(true);
  });

  it('counts the period by the state it shows: the posts, the ready ones (not the scheduled) and the ones waiting for the client', async () => {
    const { impl } = makeFetch({
      contents: {
        [padaria.id]: [
          contentFixture({ publishOn: '2026-10-11', status: 'published' }),
          contentFixture({ publishOn: '2026-10-13', status: 'approved' }),
          contentFixture({ publishOn: '2026-10-14', status: 'approved' }),
          contentFixture({ publishOn: '2026-10-15', status: 'approved', publishAtTime: '09:00' }),
          contentFixture({ publishOn: '2026-10-16', status: 'awaiting_approval' }),
          contentFixture({ publishOn: '2026-10-17', status: 'awaiting_approval', format: 'long_video' }),
          contentFixture({ publishOn: '2026-10-18', status: 'cancelled' })
        ]
      }
    });
    renderScreen(impl, feedUrl(padaria.id));
    await ready();

    const counters = feedRegion().querySelector<HTMLElement>('.content-feed__counters')!;
    const valueOf = (term: string): string | null => within(counters).getByText(term).nextElementSibling?.textContent ?? null;
    // The long video and the cancelled one are not posts of the feed; the scheduled one is its own state, so it is not "pronto".
    expect(valueOf('no período')).toBe('5');
    expect(valueOf('prontos')).toBe('2');
    expect(valueOf('aguardando')).toBe('1');
  });

  it('says "pronto" for one ready post and "prontos" for any other number', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-13', status: 'approved' })] } });
    renderScreen(impl, feedUrl(padaria.id));
    await ready();

    const counters = feedRegion().querySelector<HTMLElement>('.content-feed__counters')!;
    expect(within(counters).getByText('pronto').nextElementSibling?.textContent).toBe('1');
    expect(within(counters).queryByText('prontos')).toBeNull();
  });

  it('shows the handle of the client above the grid, and nothing when the client has none', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-13' })], [confeitaria.id]: [contentFixture({ publishOn: '2026-10-13' })] } });
    renderScreen(impl, feedUrl(confeitaria.id));
    await ready();
    expect(feedRegion().querySelector('.content-feed__handle')).toBeNull();
    cleanup();

    renderScreen(impl, feedUrl(padaria.id));
    await ready();
    expect(feedRegion().querySelector('.content-feed__handle')?.textContent).toBe('@padariacentral');
  });

  it('opens the content of the tile that was pressed, keeping the view and the period in the address', async () => {
    const { impl } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ id: 'a1a1a1a1-0000-4000-8000-0000000000a1', title: 'Um', publishOn: '2026-10-13' }), contentFixture({ id: 'a1a1a1a1-0000-4000-8000-0000000000a2', title: 'Dois', publishOn: '2026-10-14' })] }
    });
    renderScreen(impl, url(padaria.id, '?visao=feed&data=2026-10-11'));
    await ready();

    const link = within(tiles().find((candidate) => candidate.textContent?.includes('Um'))!).getByRole('link');
    expect(link.getAttribute('href')).toBe(`/agencia/${AGENCY_A}/conteudos/${padaria.id}/a1a1a1a1-0000-4000-8000-0000000000a1?visao=feed&data=2026-10-11`);
    fireEvent.click(link);
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY_A}/conteudos/${padaria.id}/a1a1a1a1-0000-4000-8000-0000000000a1`));
    expect(probe.search).toBe('?visao=feed&data=2026-10-11');
  });

  it('says there is no post, with no grid of empty frames, when there is nothing to show, and only then', async () => {
    renderScreen(makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-13', format: 'long_video' })] } }).impl, feedUrl(padaria.id));
    await ready();

    expect(within(feedRegion()).getByText('Nenhum post planejado neste período.')).toBeTruthy();
    expect(feedRegion().querySelector('.content-feed__grid')).toBeNull();
  });

  it('pages the period thirty to a page, with the range and the arrows named', async () => {
    const rows = Array.from({ length: 31 }, (_value, index) => contentFixture({ title: `Post ${index + 1}`, publishOn: `2026-10-${String(index + 1).padStart(2, '0')}`, status: 'published' }));
    renderScreen(makeFetch({ contents: { [padaria.id]: rows } }).impl, feedUrl(padaria.id));
    await ready();

    expect(tiles().filter((tile) => tile.className.includes('content-feed__tile'))).toHaveLength(30);
    expect(within(feedRegion()).getByText('1–30 de 31')).toBeTruthy();
    fireEvent.click(within(feedRegion()).getByRole('button', { name: 'Próxima página' }));
    expect(within(feedRegion()).getByText('31 de 31')).toBeTruthy();
    expect(tiles().filter((tile) => tile.className.includes('content-feed__tile'))).toHaveLength(1);
    fireEvent.click(within(feedRegion()).getByRole('button', { name: 'Página anterior' }));
    expect(within(feedRegion()).getByText('1–30 de 31')).toBeTruthy();
  });

  it('renders what the server wrote as text, never as markup', async () => {
    renderScreen(makeFetch({ contents: { [padaria.id]: [contentFixture({ title: '<img src=x onerror=alert(1)>', publishOn: '2026-10-13' })] } }).impl, feedUrl(padaria.id));
    await ready();

    expect(feedRegion().querySelector('img[src="x"]')).toBeNull();
    expect(tileTexts()).toEqual(['<img src=x onerror=alert(1)> · Imagem · 13/10 · planejado']);
  });
});

describe('the guide beside the phone', () => {
  it('says how to read the feed, with the five legends and the note of the simulator, in the words of the board', async () => {
    renderScreen(makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-13' })] } }).impl, feedUrl(padaria.id));
    await ready();

    const guide = screen.getByRole('complementary', { name: 'Como ler o feed' });
    expect(within(guide).getByRole('heading', { name: 'Como ler o feed' })).toBeTruthy();
    expect(within(guide).getByText('A grade mostra imagem, carrossel e reels, do mais recente para o mais antigo, em três colunas, como o Instagram vai mostrar. Vídeo longo, VSL e cancelados ficam de fora. Toque num quadrado para abrir o conteúdo.')).toBeTruthy();
    const legend = Array.from(guide.querySelectorAll('.content-feed-guide__legend li')).map((item) => item.textContent);
    expect(legend).toEqual([
      'Produçãosua vez',
      'Aguardandoesperando o cliente aprovar',
      'Prontoaprovado, pronto para publicar',
      'Publicadojá no ar',
      'contorno tracejado: planejado, data futura'
    ]);
    expect(within(guide).getByText('Seguidores, bio, destaques, curtidas e comentários não existem: é um simulador da grade, não o Instagram.')).toBeTruthy();
  });

  it('explains the stories at the top of the profile, and the board\'s proposal tag is not on the screen', async () => {
    renderScreen(makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-13' })] } }).impl, feedUrl(padaria.id));
    await ready();

    const guide = screen.getByRole('complementary', { name: 'Como ler o feed' });
    expect(within(guide).getByRole('heading', { name: 'Stories no feed' })).toBeTruthy();
    expect(within(guide).getByText(/faixa de círculos no topo do perfil, no lugar dos destaques/)).toBeTruthy();
    expect(screen.queryByText('Proposta')).toBeNull();
  });
});

describe('the stories on the profile', () => {
  const scripts = {
    [padaria.id]: [
      { id: 'b1b1b1b1-0000-4000-8000-0000000000b1', scriptOn: '2026-10-05', status: 'recorded' as const, sceneCount: 3 },
      { id: 'b1b1b1b1-0000-4000-8000-0000000000b2', scriptOn: '2026-10-13', status: 'draft' as const, sceneCount: 4 },
      { id: 'b1b1b1b1-0000-4000-8000-0000000000b3', scriptOn: '2026-10-20', status: 'sent' as const, sceneCount: 2 }
    ]
  };

  it('draws one circle for each script, in the order of the days, with the day and the state in words', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-13' })] }, scripts });
    renderScreen(impl, feedUrl(padaria.id));
    await ready();

    const circles = within(feedRegion()).getByRole('list', { name: 'Stories do mês' });
    const items = within(circles).getAllByRole('listitem').map((item) => item.querySelector('button')!);
    expect(items.map((button) => button.getAttribute('data-status'))).toEqual(['recorded', 'draft', 'sent']);
    expect(items.map((button) => button.textContent)).toEqual(['5GravadoStories do dia segunda-feira, 5 de outubro de 2026', '13RascunhoStories do dia terça-feira, 13 de outubro de 2026', '20EnviadoStories do dia terça-feira, 20 de outubro de 2026']);
  });

  it('opens the script that was pressed', async () => {
    const { impl } = makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-13' })] }, scripts });
    renderScreen(impl, feedUrl(padaria.id));
    await ready();

    fireEvent.click(within(feedRegion()).getByRole('button', { name: /Stories do dia terça-feira, 13 de outubro de 2026/ }));
    expect(await screen.findByRole('dialog', { name: 'Roteiro de stories' })).toBeTruthy();
  });

  it('draws no strip when the period has no script', async () => {
    renderScreen(makeFetch({ contents: { [padaria.id]: [contentFixture({ publishOn: '2026-10-13' })] } }).impl, feedUrl(padaria.id));
    await ready();

    expect(within(feedRegion()).queryByRole('list', { name: 'Stories do mês' })).toBeNull();
  });
});

describe('the cover of a tile', () => {
  const ASSET = 'a1a1a1a1-0000-4000-8000-000000000001';
  const coverCalls = (calls: readonly string[]): string[] => calls.filter((call) => /\/download-url/.test(call));

  it('is the thumbnail of the cover asset, never the original, read once however many times it is drawn', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Com capa', publishOn: '2026-10-14', coverAssetId: ASSET })] } });
    renderScreen(impl, feedUrl(padaria.id));

    await waitFor(() => expect(feedRegion().querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET}.jpg`));
    expect(feedRegion().querySelector('img')?.getAttribute('alt')).toBe('');
    expect(coverCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET}/download-url?variant=thumbnail`]);
  });

  it('draws the first media of a post that has no chosen cover, as the thumbnail of that asset (issue #606)', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Post de imagem', publishOn: '2026-10-14', format: 'image', thumbnailAssetId: ASSET })] } });
    renderScreen(impl, feedUrl(padaria.id));

    await waitFor(() => expect(feedRegion().querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${ASSET}.jpg`));
    expect(coverCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET}/download-url?variant=thumbnail`]);
  });

  it('asks for the frame of a reels that has no chosen cover as the thumbnail, and keeps the shape when it has none yet (issue #606)', async () => {
    const { impl, calls } = makeFetch({
      contents: { [padaria.id]: [contentFixture({ title: 'Filme sem capa', publishOn: '2026-10-14', format: 'reels', coverAssetId: null, thumbnailAssetId: ASSET })] },
      cover: () => json({ error: { code: 'VARIANT_NOT_READY', message: 'This variant has not been generated yet.' } }, 409)
    });
    renderScreen(impl, feedUrl(padaria.id));
    await ready();

    await waitFor(() => expect(coverCalls(calls)).toEqual([`GET /agencies/${AGENCY_A}/media/${ASSET}/download-url?variant=thumbnail`]));
    await waitFor(() => expect(shapeOf(feedRegion().querySelector('.content-feed__cover--placeholder'))).toBe('clapperboard'));
    expect(feedRegion().querySelector('img')).toBeNull();
  });

  it('keeps its URL until 30 s before it expires, and asks for a new one after that', async () => {
    const queryClient = createQueryClient();
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'Com capa', publishOn: '2026-10-14', coverAssetId: ASSET })] } });
    const first = renderScreen(impl, feedUrl(padaria.id), queryClient);
    await waitFor(() => expect(feedRegion().querySelector('img')).not.toBeNull());
    expect(coverCalls(calls)).toHaveLength(1);
    first.unmount();

    // The URL expires at 01:45 and is kept until 30 s before that: one second before the margin the cover is drawn from the cache.
    vi.setSystemTime(new Date('2026-10-12T01:44:29Z'));
    const second = renderScreen(impl, feedUrl(padaria.id), queryClient);
    await waitFor(() => expect(feedRegion().querySelector('img')).not.toBeNull());
    expect(coverCalls(calls)).toHaveLength(1);
    second.unmount();

    // One second past the margin the URL is stale, so the same cover asks for a new one.
    vi.setSystemTime(new Date('2026-10-12T01:44:31Z'));
    renderScreen(impl, feedUrl(padaria.id), queryClient);
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
    renderScreen(impl, feedUrl(padaria.id));
    await ready();

    await waitFor(() => expect(coverCalls(calls)).toHaveLength(1));
    const shapes = Array.from(feedRegion().querySelectorAll('.content-feed__cover--placeholder')).map((cover) => shapeOf(cover));
    expect(shapes).toEqual(['image', 'gallery-vertical', 'clapperboard']);
    expect(feedRegion().querySelector('img')).toBeNull();
  });
});

describe('there is no phone beside the calendar any more (decision 2026-11-11)', () => {
  it('draws no phone and never reads the feed of the client on the month, the week or the old feed address', async () => {
    const { impl, calls } = makeFetch({ contents: { [padaria.id]: [contentFixture({ title: 'De outubro', publishOn: '2026-10-13' })] } });
    renderScreen(impl, url(padaria.id));
    await waitFor(() => expect(document.querySelector('.content-calendar')).not.toBeNull());

    expect(screen.queryByRole('complementary', { name: 'Prévia do feed' })).toBeNull();
    expect(document.querySelector('.content-phone')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Semana' }));
    await waitFor(() => expect(probe.search).toBe('?visao=semana'));
    expect(document.querySelector('.content-phone')).toBeNull();
    expect(calls.some((call) => /\/contents\/feed/.test(call))).toBe(false);
  });
});
