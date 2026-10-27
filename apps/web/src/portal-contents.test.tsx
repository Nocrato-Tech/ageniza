// @vitest-environment jsdom
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { contentsError, createPortalContentsApi } from './portal-contents-fixture.js';
import { portalClientBody } from './portal-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

afterEach(cleanup);

const AGENCY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const CLIENT_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER_CLIENT_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const COVER_ID = 'a1a1a1a1-0000-4000-8000-000000000001';
const COVER_TWO_ID = 'a1a1a1a1-0000-4000-8000-000000000002';
const COVER_THREE_ID = 'a1a1a1a1-0000-4000-8000-000000000003';

// 01:30Z of the 12th is 22:30 of the 11th (a Sunday) in São Paulo: a day computed in UTC is the wrong one.
const NIGHT = '2026-10-12T01:30:00.000Z';
const TODAY = '2026-10-11';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sessionBody = { user: { id: USER_ID, name: 'Maria', email: 'maria@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };
const contextsBody = {
  canCreateAgency: false,
  contexts: [{ type: 'client', clientId: CLIENT_ID, clientName: 'Padaria Central', agencyId: AGENCY_ID, agencyName: 'Agência Um', onboardingPending: false }]
};
const legalAccepted = {
  required: false,
  documents: [
    { document: 'terms', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false },
    { document: 'privacy', currentVersion: '2026-01-01', acceptedVersion: '2026-01-01', pending: false }
  ]
};

interface World {
  readonly api: ReturnType<typeof createPortalContentsApi>;
  readonly other: ReturnType<typeof createPortalContentsApi>;
  readonly calls: string[];
  /** The Instagram handle of the client, as the shell reads it. */
  handle: string | null;
  /** What the client's own `GET` answers: the shell of the portal, with the tour already seen. */
  readonly impl: typeof fetch;
}

const makeWorld = (): World => {
  const api = createPortalContentsApi(CLIENT_ID);
  const other = createPortalContentsApi(OTHER_CLIENT_ID);
  const calls: string[] = [];
  const world: World = {
    api,
    other,
    calls,
    handle: null,
    impl: async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${path}${url.search}`);
      if (path.endsWith('/auth/session')) return json(sessionBody);
      if (path.endsWith('/me/contexts')) return json(contextsBody);
      if (path.endsWith('/me/legal-acceptances')) return json(legalAccepted);
      const answered = api.handle(url, method) ?? other.handle(url, method);
      if (answered !== undefined) return answered;
      if (path === `/clients/${CLIENT_ID}`) return json({ ...portalClientBody(CLIENT_ID, 'Padaria Central'), instagramHandle: world.handle });
      if (path === `/clients/${OTHER_CLIENT_ID}`) return json(portalClientBody(OTHER_CLIENT_ID, 'Outro Cliente'));
      if (path === `/clients/${CLIENT_ID}/story-scripts`) {
        const from = url.searchParams.get('from') ?? '';
        const to = url.searchParams.get('to') ?? '';
        return json({ data: [], meta: { from, to, count: 0 } });
      }
      throw new Error(`unexpected ${method} ${url}`);
    }
  };
  return world;
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface ProbeTarget {
  pathname: string;
  search: string;
  navigate: NavigateFunction;
}

function Probe({ probe }: { probe: ProbeTarget }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.navigate = navigate;
  });
  return null;
}

const contentsUrl = (search = '', clientId = CLIENT_ID): string => `/portal/${clientId}/conteudos${search}`;

const renderPortal = (world: World, entries: readonly string[] = [contentsUrl()]): { container: HTMLElement; probe: ProbeTarget; queryClient: QueryClient } => {
  const client = new HttpClient('http://127.0.0.1:3001', world.impl);
  const queryClient = createQueryClient();
  const store = createAuthSessionStore(client);
  const probe: ProbeTarget = { pathname: '', search: '', navigate: () => undefined };
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[...entries]} initialIndex={entries.length - 1}>
            <Probe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { container: rendered.container, probe, queryClient };
};

const nav = (): HTMLElement => screen.getByRole('navigation', { name: 'Navegação do portal' });
const days = (container: HTMLElement): HTMLElement => container.querySelector('.portal-days') as HTMLElement;
const awaitingBlock = (): HTMLElement => screen.getByRole('region', { name: /O que precisa de você/ });
/** The card of the month's list: a content that awaits approval is also in the block above it, with the same title. */
const cardOf = (title: string): HTMLElement => {
  const found = Array.from(document.querySelectorAll<HTMLElement>('.portal-days .portal-card')).filter((card) => card.querySelector('.portal-card__title')?.textContent === title);
  if (found.length !== 1) throw new Error(`Expected one card titled "${title}", found ${found.length}.`);
  return found[0]!;
};
/** The lucide icon that draws the shape of a format: the name lucide-react gives the class of its svg. */
const shapeOf = (scope: HTMLElement): string | null => {
  const names = (scope.querySelector('.format-shape > svg')?.getAttribute('class') ?? '').split(' ').filter((name) => name.startsWith('lucide-'));
  return names.length === 0 ? null : names[0]!.slice('lucide-'.length);
};
/** What the tags of a card say, and the tone and the state each one draws: the format and the state are two tags, never one sentence. */
const tagsOf = (card: HTMLElement): { format: string | null; formatTone: string | undefined; status: string | null; statusIcon: string | undefined } => {
  const format = card.querySelector('.ui-format-tag');
  const status = card.querySelector('.ui-status-tag');
  return {
    format: format?.textContent ?? null,
    formatTone: format?.className.split(' ').find((name) => name.startsWith('ui-format-tag--')),
    status: status?.textContent ?? null,
    statusIcon: status?.className.split(' ').find((name) => name.startsWith('ui-status-tag--'))
  };
};
const titlesOf = (container: HTMLElement): string[] => Array.from(days(container).querySelectorAll('.portal-card__title')).map((node) => node.textContent ?? '');
const periodCalls = (world: World): string[] => world.api.calls.filter((call) => call.startsWith(`GET /clients/${CLIENT_ID}/contents?`));
const mediaCalls = (world: World): string[] => world.api.calls.filter((call) => call.includes('/media/'));
const ready = async (): Promise<void> => { await screen.findByRole('heading', { level: 1, name: 'Conteúdos' }); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NIGHT));
});
afterEach(() => { vi.useRealTimers(); });

const seedOctober = (world: World): void => {
  world.api.seed({ title: 'Reels de segunda', format: 'reels', publishOn: '2026-10-12', status: 'approved' });
  world.api.seed({ title: 'Carrossel da semana', format: 'carousel', publishOn: '2026-10-15', status: 'awaiting_approval' });
  world.api.seed({ title: 'Imagem em ajuste', format: 'image', publishOn: '2026-10-20', status: 'adjusting' });
  world.api.seed({ title: 'Post em produção', format: 'image', publishOn: '2026-10-22', status: 'in_production' });
  world.api.seed({ title: 'Vídeo publicado', format: 'long_video', publishOn: '2026-10-05', status: 'published', publishedOn: '2026-10-05' });
};

describe('the portal Conteúdos (#269)', () => {
  describe('the bottom bar and the address', () => {
    it('says Conteúdos where it said Calendário, and the heading and the tab title say it too', async () => {
      const world = makeWorld();
      const { probe } = renderPortal(world, [`/portal/${CLIENT_ID}/inicio`]);
      await screen.findByRole('heading', { name: 'Olá, Maria' });
      expect(within(nav()).getAllByRole('link').map((link) => link.textContent)).toEqual(['Início', 'Conteúdos', 'Marca', 'Relatórios']);
      expect(within(nav()).queryByRole('link', { name: 'Calendário' })).toBeNull();

      fireEvent.click(within(nav()).getByRole('link', { name: 'Conteúdos' }));
      await ready();
      expect(probe.pathname).toBe(contentsUrl());
      expect(within(nav()).getByRole('link', { name: 'Conteúdos' }).getAttribute('aria-current')).toBe('page');
      expect(within(nav()).getByRole('link', { name: 'Conteúdos' }).getAttribute('href')).toBe(contentsUrl());
      expect(document.title).toBe('Conteúdos — Portal do cliente — Ageniza');
    });

    it('keeps the address of the e-mail working: /calendario lands on Conteúdos, in place, and with the query it came with', async () => {
      const world = makeWorld();
      seedOctober(world);
      const { probe } = renderPortal(world, [`/portal/${CLIENT_ID}/calendario`]);
      await ready();
      expect(await screen.findByText('Reels de segunda')).toBeTruthy();
      expect(probe.pathname).toBe(contentsUrl());
      expect(within(nav()).getByRole('link', { name: 'Conteúdos' }).getAttribute('aria-current')).toBe('page');
      cleanup();

      const withQuery = makeWorld();
      const second = renderPortal(withQuery, [`/portal/${CLIENT_ID}/calendario?data=2026-11-10`]);
      expect(await screen.findByRole('heading', { name: 'Novembro 2026' })).toBeTruthy();
      expect(second.probe.pathname).toBe(contentsUrl());
      expect(second.probe.search).toBe('?data=2026-11-10');
    });

    it('replaces the old address in the history, so going back does not bounce the person to Conteúdos again', async () => {
      const world = makeWorld();
      const { probe } = renderPortal(world, [`/portal/${CLIENT_ID}/inicio`, `/portal/${CLIENT_ID}/calendario`]);
      await ready();
      expect(probe.pathname).toBe(contentsUrl());
      act(() => { probe.navigate(-1); });
      expect(await screen.findByRole('heading', { name: 'Olá, Maria' })).toBeTruthy();
      expect(probe.pathname).toBe(`/portal/${CLIENT_ID}/inicio`);
    });
  });

  describe('the month, by the period query', () => {
    it.each([
      ['a minute before midnight in São Paulo', '2026-11-01T02:59:00.000Z', '2026-10-01', '2026-10-31', 'Outubro 2026'],
      ['at midnight in São Paulo', '2026-11-01T03:00:00.000Z', '2026-11-01', '2026-11-30', 'Novembro 2026']
    ])('opens on the month of the day of São Paulo, %s', async (_label, instant, from, to, title) => {
      vi.setSystemTime(new Date(instant));
      const world = makeWorld();
      renderPortal(world);
      await ready();
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
      await waitFor(() => expect(periodCalls(world)).toEqual([`GET /clients/${CLIENT_ID}/contents?from=${from}&to=${to}`]));
    });

    it('moves a month at a time, asking for exactly the days of the month, and shows only what the API gave for it', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Fim de setembro', publishOn: '2026-09-30' });
      world.api.seed({ title: 'Início de outubro', publishOn: '2026-10-01' });
      world.api.seed({ title: 'Fim de outubro', publishOn: '2026-10-31' });
      world.api.seed({ title: 'Início de novembro', publishOn: '2026-11-01' });
      const { container, probe } = renderPortal(world);
      await ready();
      await screen.findByText('Início de outubro');
      expect(titlesOf(container)).toEqual(['Início de outubro', 'Fim de outubro']);
      expect(screen.getByRole('heading', { name: 'Outubro 2026' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
      expect(await screen.findByRole('heading', { name: 'Novembro 2026' })).toBeTruthy();
      await screen.findByText('Início de novembro');
      expect(titlesOf(container)).toEqual(['Início de novembro']);
      expect(probe.search).toBe('?data=2026-11-01');

      fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
      fireEvent.click(screen.getByRole('button', { name: 'Mês anterior' }));
      expect(await screen.findByRole('heading', { name: 'Setembro 2026' })).toBeTruthy();
      await screen.findByText('Fim de setembro');
      expect(titlesOf(container)).toEqual(['Fim de setembro']);
      expect(probe.search).toBe('?data=2026-09-01');
      expect(periodCalls(world)).toEqual([
        `GET /clients/${CLIENT_ID}/contents?from=2026-10-01&to=2026-10-31`,
        `GET /clients/${CLIENT_ID}/contents?from=2026-11-01&to=2026-11-30`,
        `GET /clients/${CLIENT_ID}/contents?from=2026-09-01&to=2026-09-30`
      ]);
    });

    it.each([
      ['crosses the year', '?data=2026-12-15', 'Janeiro 2027', '2027-01-01', '2027-01-31'],
      ['spells the leap day', '?data=2028-01-20', 'Fevereiro 2028', '2028-02-01', '2028-02-29'],
      ['keeps a month of 28 days', '?data=2027-01-20', 'Fevereiro 2027', '2027-02-01', '2027-02-28']
    ])('%s going forward', async (_label, search, title, from, to) => {
      const world = makeWorld();
      renderPortal(world, [contentsUrl(search)]);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy();
      await waitFor(() => expect(periodCalls(world).at(-1)).toBe(`GET /clients/${CLIENT_ID}/contents?from=${from}&to=${to}`));
    });

    it('starts from the month in the address on a reload, and from today when the address is not a real day', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Do dia 17', publishOn: '2026-10-17' });
      world.api.seed({ title: 'De novembro', publishOn: '2026-11-17' });
      renderPortal(world, [contentsUrl('?data=2026-11-17')]);
      await ready();
      expect(await screen.findByRole('heading', { name: 'Novembro 2026' })).toBeTruthy();
      expect(await screen.findByText('De novembro')).toBeTruthy();
      expect(screen.queryByText('Do dia 17')).toBeNull();
      cleanup();

      const garbled = makeWorld();
      renderPortal(garbled, [contentsUrl('?data=2026-02-31')]);
      await ready();
      expect(await screen.findByRole('heading', { name: 'Outubro 2026' })).toBeTruthy();
      await waitFor(() => expect(periodCalls(garbled)).toEqual([`GET /clients/${CLIENT_ID}/contents?from=2026-10-01&to=2026-10-31`]));
    });

    it('never mixes the contents of two clients: each portal reads and shows its own', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Da Padaria', publishOn: '2026-10-12' });
      world.other.seed({ title: 'Do Outro', publishOn: '2026-10-13' });
      const { container, probe } = renderPortal(world);
      await ready();
      await screen.findByText('Da Padaria');

      act(() => { probe.navigate(contentsUrl('', OTHER_CLIENT_ID)); });
      await screen.findByText('Do Outro');
      expect(titlesOf(container)).toEqual(['Do Outro']);
      expect(screen.queryByText('Da Padaria')).toBeNull();
      expect(world.other.calls.filter((call) => call.includes('?from='))).toEqual([`GET /clients/${OTHER_CLIENT_ID}/contents?from=2026-10-01&to=2026-10-31`]);
    });
  });

  describe('the cards', () => {
    it('draws each content under its day, in the order of the API, with the format and the status of the client', async () => {
      const world = makeWorld();
      seedOctober(world);
      world.api.seed({ title: 'Tarde', format: 'image', publishOn: '2026-10-12', publishAtTime: '18:00', status: 'approved' });
      world.api.seed({ title: 'Manhã', format: 'carousel', publishOn: '2026-10-12', publishAtTime: '09:00', status: 'awaiting_approval' });
      const { container } = renderPortal(world);
      await ready();
      await screen.findByText('Reels de segunda');

      expect(titlesOf(container)).toEqual(['Vídeo publicado', 'Manhã', 'Tarde', 'Reels de segunda', 'Carrossel da semana', 'Imagem em ajuste', 'Post em produção']);
      expect(tagsOf(cardOf('Reels de segunda'))).toEqual({ format: 'Reels', formatTone: 'ui-format-tag--reels', status: 'Aprovado', statusIcon: 'ui-status-tag--ready' });
      expect(tagsOf(cardOf('Carrossel da semana'))).toEqual({ format: 'Carrossel', formatTone: 'ui-format-tag--carousel', status: 'Aguardando aprovação', statusIcon: 'ui-status-tag--waiting' });
      expect(tagsOf(cardOf('Imagem em ajuste'))).toEqual({ format: 'Imagem', formatTone: 'ui-format-tag--static', status: 'Em ajuste', statusIcon: 'ui-status-tag--adjust' });
      expect(tagsOf(cardOf('Post em produção'))).toEqual({ format: 'Imagem', formatTone: 'ui-format-tag--static', status: 'Em produção', statusIcon: 'ui-status-tag--production' });
      expect(tagsOf(cardOf('Vídeo publicado'))).toEqual({ format: 'Vídeo longo', formatTone: 'ui-format-tag--static', status: 'Publicado', statusIcon: 'ui-status-tag--published' });
    });

    it('tints each card by its format, as the calendar of the agency does, and the status is the tag and not the tint', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Um reels', format: 'reels', publishOn: '2026-10-12', status: 'awaiting_approval' });
      world.api.seed({ title: 'Um carrossel', format: 'carousel', publishOn: '2026-10-13', status: 'awaiting_approval' });
      world.api.seed({ title: 'Uma imagem', format: 'image', publishOn: '2026-10-14', status: 'awaiting_approval' });
      world.api.seed({ title: 'Um vídeo', format: 'long_video', publishOn: '2026-10-15', status: 'approved' });
      world.api.seed({ title: 'Uma VSL', format: 'vsl', publishOn: '2026-10-16', status: 'approved' });
      renderPortal(world);
      await ready();
      await screen.findByText('Um reels');

      const tones = ['Um reels', 'Um carrossel', 'Uma imagem', 'Um vídeo', 'Uma VSL'].map((title) => cardOf(title).getAttribute('data-format'));
      expect(tones).toEqual(['reels', 'carousel', 'static', 'static', 'static']);
      expect(cardOf('Um reels').getAttribute('data-status')).toBe('awaiting_approval');
    });

    it('draws no primary action on the list: the screen has nothing to decide, the post does', async () => {
      const world = makeWorld();
      seedOctober(world);
      const { container } = renderPortal(world);
      await ready();
      await screen.findByText('Reels de segunda');
      expect(container.querySelectorAll('.ui-button--primary')).toHaveLength(0);
    });

    it('names each day by its number and weekday, once for the contents of that day, and in full for who does not see the grid', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Primeiro', publishOn: '2026-10-12', publishAtTime: '09:00' });
      world.api.seed({ title: 'Segundo', publishOn: '2026-10-12', publishAtTime: '18:00' });
      world.api.seed({ title: 'Outro dia', publishOn: '2026-10-15' });
      const { container } = renderPortal(world);
      await ready();
      await screen.findByText('Primeiro');

      const dayItems = Array.from(days(container).querySelectorAll(':scope > li'));
      expect(dayItems).toHaveLength(2);
      expect(within(dayItems[0] as HTMLElement).getByText('12 seg')).toBeTruthy();
      expect(within(dayItems[0] as HTMLElement).getByText('segunda-feira, 12 de outubro de 2026')).toBeTruthy();
      expect((dayItems[0] as HTMLElement).querySelector('time')?.getAttribute('datetime')).toBe('2026-10-12');
      expect(within(dayItems[0] as HTMLElement).getAllByRole('article')).toHaveLength(2);
      expect(within(dayItems[1] as HTMLElement).getByText('15 qui')).toBeTruthy();
      expect(within(dayItems[1] as HTMLElement).getByText('quinta-feira, 15 de outubro de 2026')).toBeTruthy();
    });

    it('shows a content in production as its title, its day and its format, and nothing the agency keeps', async () => {
      const world = makeWorld();
      world.api.seed({
        title: 'Post em produção',
        format: 'image',
        publishOn: '2026-10-22',
        status: 'in_production',
        publishAtTime: '10:00',
        caption: 'LEGENDA INTERNA DA AGÊNCIA',
        coverAssetId: COVER_ID
      });
      const { container } = renderPortal(world);
      await ready();
      await screen.findByText('Post em produção');

      expect(cardOf('Post em produção').textContent).toBe('Post em produçãoImagemEm produção');
      expect(shapeOf(cardOf('Post em produção'))).toBe('image');
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).not.toMatch(/LEGENDA INTERNA|10:00/);
      expect(within(days(container)).getByText('22 qui')).toBeTruthy();
      expect(mediaCalls(world)).toEqual([]);
    });

    it('refuses an answer that carries more than the title, the day and the format of a content in production', async () => {
      const world = makeWorld();
      world.api.state.leakInProduction = true;
      world.api.seed({ title: 'Post em produção', format: 'image', publishOn: '2026-10-22', status: 'in_production', publishAtTime: '10:00', caption: 'LEGENDA INTERNA DA AGÊNCIA', coverAssetId: COVER_ID });
      const { container } = renderPortal(world);
      await ready();
      // A refused answer is read once more before the screen gives up (the app's retry), so the wait is longer than the default.
      expect(await screen.findByText('Não foi possível carregar os conteúdos. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
      expect(container.textContent).not.toMatch(/LEGENDA INTERNA|Post em produção/);
      expect(mediaCalls(world)).toEqual([]);
    });

    it('draws every text of the server as text: a title is never markup', async () => {
      const world = makeWorld();
      const hostile = '<img src="x" onerror="alert(1)"><b>negrito</b>';
      world.api.seed({ title: hostile, publishOn: '2026-10-12' });
      const { container } = renderPortal(world);
      await ready();
      expect(await screen.findByText(hostile)).toBeTruthy();
      expect(container.querySelector('img[src="x"]')).toBeNull();
      expect(container.querySelector('b')).toBeNull();
    });
  });

  describe('the link to the post', () => {
    const postUrl = (contentId: string): string => `/portal/${CLIENT_ID}/conteudos/${contentId}`;

    it('makes each card of the month a link to its own post, named by its title, and the one link of the card', async () => {
      const world = makeWorld();
      const first = world.api.seed({ title: 'Primeiro post', publishOn: '2026-10-12', status: 'approved' });
      const second = world.api.seed({ title: 'Segundo post', publishOn: '2026-10-15', status: 'adjusting' });
      const { probe } = renderPortal(world);
      await ready();
      await screen.findByText('Segundo post');

      const firstLink = within(cardOf('Primeiro post')).getByRole('link', { name: 'Primeiro post' });
      const secondLink = within(cardOf('Segundo post')).getByRole('link', { name: 'Segundo post' });
      expect(firstLink.getAttribute('href')).toBe(postUrl(first.id));
      expect(secondLink.getAttribute('href')).toBe(postUrl(second.id));
      expect(within(cardOf('Primeiro post')).getAllByRole('link')).toHaveLength(1);
      expect(within(cardOf('Segundo post')).getAllByRole('link')).toHaveLength(1);

      fireEvent.click(secondLink);
      await waitFor(() => expect(probe.pathname).toBe(postUrl(second.id)));
    });

    it('links a content in production as well: its post is its title, its day and its format', async () => {
      const world = makeWorld();
      const content = world.api.seed({ title: 'Ainda em produção', format: 'image', publishOn: '2026-10-22', status: 'in_production' });
      const { probe } = renderPortal(world);
      await ready();
      await screen.findByText('Ainda em produção');
      const link = within(cardOf('Ainda em produção')).getByRole('link', { name: 'Ainda em produção' });
      expect(link.getAttribute('href')).toBe(postUrl(content.id));
      fireEvent.click(link);
      await waitFor(() => expect(probe.pathname).toBe(postUrl(content.id)));
    });

    it('makes each cover of what waits for the person a link to its own post', async () => {
      const world = makeWorld();
      const first = world.api.seed({ title: 'Esperando um', publishOn: '2026-10-14', status: 'awaiting_approval' });
      const second = world.api.seed({ title: 'Esperando dois', publishOn: '2026-10-16', status: 'awaiting_approval' });
      const { probe } = renderPortal(world);
      await ready();
      const block = await waitFor(() => awaitingBlock());
      const links = within(block).getAllByRole('link');
      expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
        ['Esperando um', postUrl(first.id)],
        ['Esperando dois', postUrl(second.id)]
      ]);
      expect(within(block).getByRole('link', { name: 'Esperando dois' })).toBe(links[1]);

      fireEvent.click(links[1] as HTMLElement);
      await waitFor(() => expect(probe.pathname).toBe(postUrl(second.id)));
    });

    it('takes the id of the content into the address as one segment, whatever the server wrote in the title', async () => {
      const world = makeWorld();
      const content = world.api.seed({ title: '../../conta/../sair', publishOn: '2026-10-12' });
      renderPortal(world);
      await ready();
      const link = await screen.findAllByRole('link', { name: '../../conta/../sair' });
      expect(link[0]!.getAttribute('href')).toBe(postUrl(content.id));
    });
  });

  describe('the covers', () => {
    it('asks the portal route for the thumbnail of the cover of each content that has one, and draws it', async () => {
      const world = makeWorld();
      const content = world.api.seed({ title: 'Com capa', publishOn: '2026-10-12', coverAssetId: COVER_ID });
      world.api.seed({ title: 'Sem capa', publishOn: '2026-10-13' });
      const { container } = renderPortal(world);
      await ready();
      await screen.findByText('Com capa');

      await waitFor(() => expect(cardOf('Com capa').querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${COVER_ID}.png?variant=thumbnail`));
      expect(mediaCalls(world)).toEqual([`GET /clients/${CLIENT_ID}/contents/${content.id}/media/${COVER_ID}/url?variant=thumbnail`]);
      expect(cardOf('Sem capa').querySelector('img')).toBeNull();
      expect(shapeOf(cardOf('Sem capa'))).toBe('clapperboard');
      expect(cardOf('Com capa').querySelector('.format-shape')).toBeNull();
      expect(container.querySelectorAll('img')).toHaveLength(1);
    });

    it('draws the first media of a post that has no chosen cover, in the month and in what waits, as the thumbnail (issue #606)', async () => {
      const world = makeWorld();
      const post = world.api.seed({ title: 'Post de imagem', format: 'image', publishOn: '2026-10-12', thumbnailAssetId: COVER_ID });
      const waiting = world.api.seed({ title: 'Carrossel esperando', format: 'carousel', publishOn: '2026-10-13', status: 'awaiting_approval', thumbnailAssetId: COVER_TWO_ID });
      world.api.seed({ title: 'Sem mídia', format: 'image', publishOn: '2026-10-14' });
      renderPortal(world);
      await ready();
      await screen.findByText('Post de imagem');

      await waitFor(() => expect(cardOf('Post de imagem').querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${COVER_ID}.png?variant=thumbnail`));
      await waitFor(() => expect(awaitingBlock().querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${COVER_TWO_ID}.png?variant=thumbnail`));
      expect(shapeOf(cardOf('Sem mídia'))).toBe('image');
      expect([...mediaCalls(world)].sort()).toEqual([
        `GET /clients/${CLIENT_ID}/contents/${post.id}/media/${COVER_ID}/url?variant=thumbnail`,
        `GET /clients/${CLIENT_ID}/contents/${waiting.id}/media/${COVER_TWO_ID}/url?variant=thumbnail`
      ].sort());
    });

    it('goes back to the shape of the format when the picture does not load, and does not ask for it again', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Imagem quebrada', format: 'image', publishOn: '2026-10-12', coverAssetId: COVER_ID });
      renderPortal(world);
      await ready();
      await screen.findByText('Imagem quebrada');
      await waitFor(() => expect(cardOf('Imagem quebrada').querySelector('img')).toBeTruthy());

      fireEvent.error(cardOf('Imagem quebrada').querySelector('img') as HTMLImageElement);
      await waitFor(() => expect(cardOf('Imagem quebrada').querySelector('img')).toBeNull());
      expect(shapeOf(cardOf('Imagem quebrada'))).toBe('image');
      expect(mediaCalls(world)).toHaveLength(1);
    });

    it('keeps the shape of the format when the route refuses, when the thumbnail is not ready, or when the address is not http(s)', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Ainda processando', format: 'reels', publishOn: '2026-10-12', coverAssetId: COVER_ID });
      world.api.seed({ title: 'Endereço estranho', format: 'image', publishOn: '2026-10-13', coverAssetId: COVER_TWO_ID });
      world.api.seed({ title: 'Recusada', format: 'carousel', publishOn: '2026-10-14', coverAssetId: COVER_THREE_ID });
      world.api.state.failMedia.set(COVER_ID, () => contentsError(409, 'VARIANT_NOT_READY'));
      world.api.state.failMedia.set(COVER_THREE_ID, () => contentsError(404, 'NOT_FOUND', 'Media asset not found.'));
      world.api.state.mediaUrl = (assetId) => (assetId === COVER_TWO_ID ? 'javascript:alert(1)' : 'https://storage.test/x.png');
      const { container } = renderPortal(world);
      await ready();
      await screen.findByText('Ainda processando');
      await waitFor(() => expect(mediaCalls(world)).toHaveLength(3));

      expect(container.querySelectorAll('img')).toHaveLength(0);
      expect(shapeOf(cardOf('Recusada'))).toBe('gallery-vertical');
      expect(shapeOf(cardOf('Ainda processando'))).toBe('clapperboard');
      expect(shapeOf(cardOf('Endereço estranho'))).toBe('image');
    });
  });

  describe('the covers with an observer of what is on screen', () => {
    class FakeObserver {
      static instances: FakeObserver[] = [];
      readonly observed: Element[] = [];
      constructor(private readonly callback: IntersectionObserverCallback) { FakeObserver.instances.push(this); }
      observe(element: Element): void { this.observed.push(element); }
      unobserve(): void { /* unused */ }
      disconnect(): void { /* unused */ }
      takeRecords(): IntersectionObserverEntry[] { return []; }
      show(element: Element): void { this.callback([{ isIntersecting: true, target: element } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
    }
    const original = globalThis.IntersectionObserver;
    beforeEach(() => {
      FakeObserver.instances = [];
      globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
    });
    afterEach(() => { globalThis.IntersectionObserver = original; });

    it('asks for the thumbnail only once the card is on screen, and only for that card', async () => {
      const world = makeWorld();
      const seen = world.api.seed({ title: 'À vista', format: 'image', publishOn: '2026-10-12', thumbnailAssetId: COVER_ID });
      world.api.seed({ title: 'Fora da tela', format: 'image', publishOn: '2026-10-13', thumbnailAssetId: COVER_TWO_ID });
      renderPortal(world);
      await ready();
      await screen.findByText('Fora da tela');
      await waitFor(() => expect(FakeObserver.instances.length).toBeGreaterThanOrEqual(2));
      expect(mediaCalls(world)).toEqual([]);

      const observer = FakeObserver.instances.find((candidate) => cardOf('À vista').contains(candidate.observed[0] ?? null))!;
      act(() => observer.show(observer.observed[0]!));
      await waitFor(() => expect(mediaCalls(world)).toEqual([`GET /clients/${CLIENT_ID}/contents/${seen.id}/media/${COVER_ID}/url?variant=thumbnail`]));
      expect(cardOf('Fora da tela').querySelector('img')).toBeNull();
    });
  });

  describe('what waits for the person', () => {
    it('counts what awaits approval with the total of the API, shows it with its cover, day and title, and does not depend on the month', async () => {
      const world = makeWorld();
      const first = world.api.seed({ title: 'Para aprovar um', format: 'reels', publishOn: '2026-10-14', status: 'awaiting_approval', coverAssetId: COVER_ID });
      world.api.seed({ title: 'Para aprovar dois', format: 'image', publishOn: '2026-10-13', status: 'awaiting_approval' });
      world.api.seed({ title: 'Para aprovar de dezembro', format: 'image', publishOn: '2026-12-20', status: 'awaiting_approval' });
      world.api.seed({ title: 'Aprovado', publishOn: '2026-10-12', status: 'approved' });
      renderPortal(world);
      await ready();
      const block = await waitFor(() => awaitingBlock());
      expect(within(block).getByRole('heading', { name: 'O que precisa de você (3)' })).toBeTruthy();
      expect(Array.from(block.querySelectorAll('.portal-awaiting__title')).map((node) => node.textContent)).toEqual(['Para aprovar dois', 'Para aprovar um', 'Para aprovar de dezembro']);
      expect(Array.from(block.querySelectorAll('.portal-awaiting__day')).map((node) => node.textContent)).toEqual(['13/10', '14/10', '20/12']);
      expect(within(block).queryByText('Aprovado')).toBeNull();
      expect(world.api.calls.filter((call) => call.includes('awaiting-approval'))).toEqual([`GET /clients/${CLIENT_ID}/contents/awaiting-approval?pageSize=6`]);
      await waitFor(() => expect(mediaCalls(world)).toContain(`GET /clients/${CLIENT_ID}/contents/${first.id}/media/${COVER_ID}/url?variant=thumbnail`));

      fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
      await screen.findByRole('heading', { name: 'Novembro 2026' });
      expect(within(awaitingBlock()).getByRole('heading', { name: 'O que precisa de você (3)' })).toBeTruthy();
      expect(world.api.calls.filter((call) => call.includes('awaiting-approval'))).toHaveLength(1);
    });

    it('shows the first six and says how many there are, when more wait', async () => {
      const world = makeWorld();
      for (let day = 1; day <= 8; day += 1) world.api.seed({ title: `Esperando ${day}`, publishOn: `2026-10-${String(day + 10).padStart(2, '0')}`, status: 'awaiting_approval' });
      renderPortal(world);
      await ready();
      const block = await waitFor(() => awaitingBlock());
      expect(within(block).getByRole('heading', { name: 'O que precisa de você (8)' })).toBeTruthy();
      expect(within(block).getAllByRole('listitem')).toHaveLength(6);
      expect(within(block).getByText('Mostrando 6 de 8')).toBeTruthy();
      expect(within(block).queryByText('Esperando 7')).toBeNull();
    });

    it('is not there when nothing awaits approval, and says nothing about it', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Aprovado', publishOn: '2026-10-12', status: 'approved' });
      renderPortal(world);
      await ready();
      await screen.findByText('Aprovado');
      expect(screen.queryByRole('region', { name: /O que precisa de você/ })).toBeNull();
      expect(screen.queryByText(/precisa de você/)).toBeNull();
    });

    it('says it could not load, keeps the month, and tries again', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Para aprovar', publishOn: '2026-10-14', status: 'awaiting_approval' });
      world.api.state.failAwaiting = () => contentsError(500, 'INTERNAL_ERROR');
      const { container } = renderPortal(world);
      await ready();
      expect(await screen.findByText('Não foi possível carregar o que precisa de você.', undefined, { timeout: 5000 })).toBeTruthy();
      expect(await within(days(container)).findByText('Para aprovar')).toBeTruthy();

      world.api.state.failAwaiting = null;
      fireEvent.click(within(screen.getByRole('region', { name: 'O que precisa de você' })).getByRole('button', { name: 'Tentar de novo' }));
      expect(await screen.findByRole('heading', { name: 'O que precisa de você (1)' })).toBeTruthy();
      expect(screen.queryByText('Não foi possível carregar o que precisa de você.')).toBeNull();
    });
  });

  describe('the filter by status', () => {
    const seedAll = (world: World): void => {
      world.api.seed({ title: 'Está aprovado', publishOn: '2026-10-12', status: 'approved' });
      world.api.seed({ title: 'Está aguardando', publishOn: '2026-10-13', status: 'awaiting_approval' });
      world.api.seed({ title: 'Está em ajuste', publishOn: '2026-10-14', status: 'adjusting' });
      world.api.seed({ title: 'Está em produção', publishOn: '2026-10-15', status: 'in_production' });
      world.api.seed({ title: 'Está publicado', publishOn: '2026-10-16', status: 'published' });
    };

    it('offers Todos and each status in the words of the client', async () => {
      const world = makeWorld();
      renderPortal(world);
      await ready();
      const select = screen.getByLabelText('Filtro') as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
        ['', 'Todos'],
        ['approved', 'Aprovado'],
        ['awaiting_approval', 'Aguardando aprovação'],
        ['adjusting', 'Em ajuste'],
        ['in_production', 'Em produção'],
        ['published', 'Publicado']
      ]);
      expect(select.value).toBe('');
    });

    it.each([
      ['approved', 'Está aprovado'],
      ['awaiting_approval', 'Está aguardando'],
      ['adjusting', 'Está em ajuste'],
      ['in_production', 'Está em produção'],
      ['published', 'Está publicado']
    ])('keeps only the contents %s, writes it in the address, and Todos brings everything back', async (status, title) => {
      const world = makeWorld();
      seedAll(world);
      const { container, probe } = renderPortal(world);
      await ready();
      await screen.findByText('Está aprovado');
      expect(titlesOf(container)).toHaveLength(5);

      fireEvent.change(screen.getByLabelText('Filtro'), { target: { value: status } });
      await waitFor(() => expect(titlesOf(container)).toEqual([title]));
      expect(probe.search).toBe(`?situacao=${status}`);

      fireEvent.change(screen.getByLabelText('Filtro'), { target: { value: '' } });
      await waitFor(() => expect(titlesOf(container)).toHaveLength(5));
      expect(probe.search).toBe('');
    });

    it('starts filtered from the address, ignores a status that does not exist, and keeps the filter when the month changes', async () => {
      const world = makeWorld();
      seedAll(world);
      world.api.seed({ title: 'Aprovado de novembro', publishOn: '2026-11-03', status: 'approved' });
      world.api.seed({ title: 'Ajuste de novembro', publishOn: '2026-11-04', status: 'adjusting' });
      const { container, probe } = renderPortal(world, [contentsUrl('?situacao=approved')]);
      await ready();
      await screen.findByText('Está aprovado');
      expect(titlesOf(container)).toEqual(['Está aprovado']);
      expect((screen.getByLabelText('Filtro') as HTMLSelectElement).value).toBe('approved');

      fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
      await screen.findByText('Aprovado de novembro');
      expect(titlesOf(container)).toEqual(['Aprovado de novembro']);
      expect(probe.search).toContain('situacao=approved');
      cleanup();

      const lenient = makeWorld();
      seedAll(lenient);
      const second = renderPortal(lenient, [contentsUrl('?situacao=cancelled')]);
      await ready();
      await screen.findByText('Está aprovado');
      expect(titlesOf(second.container)).toHaveLength(5);
      expect((screen.getByLabelText('Filtro') as HTMLSelectElement).value).toBe('');
    });

    it('says so when the month has contents but none with the status', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Só aprovado', publishOn: '2026-10-12', status: 'approved' });
      renderPortal(world);
      await ready();
      await screen.findByText('Só aprovado');
      fireEvent.change(screen.getByLabelText('Filtro'), { target: { value: 'adjusting' } });
      expect(await screen.findByText('Nenhum conteúdo nesta situação neste mês')).toBeTruthy();
      expect(screen.queryByText('Só aprovado')).toBeNull();
      expect(screen.queryByText('Nenhum conteúdo planejado para este mês')).toBeNull();
    });
  });

  describe('the feed', () => {
    it('swaps the list for the grid, shows only the formats of the feed, the latest first, and goes back to the list', async () => {
      const world = makeWorld();
      world.handle = 'padariacentral';
      world.api.seed({ title: 'Reels antigo', format: 'reels', publishOn: '2026-10-02', status: 'published' });
      world.api.seed({ title: 'Imagem da tarde', format: 'image', publishOn: '2026-10-20', publishAtTime: '15:00', status: 'approved' });
      world.api.seed({ title: 'Imagem da manhã', format: 'image', publishOn: '2026-10-20', publishAtTime: '08:00', status: 'approved' });
      world.api.seed({ title: 'Carrossel sem hora', format: 'carousel', publishOn: '2026-10-20', status: 'awaiting_approval' });
      world.api.seed({ title: 'Vídeo longo', format: 'long_video', publishOn: '2026-10-25', status: 'approved' });
      world.api.seed({ title: 'VSL', format: 'vsl', publishOn: '2026-10-26', status: 'approved' });
      const { container, probe } = renderPortal(world);
      await ready();
      await screen.findByText('Reels antigo');
      expect(screen.getByRole('button', { name: 'Calendário' }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: 'Feed' }).getAttribute('aria-pressed')).toBe('false');

      fireEvent.click(screen.getByRole('button', { name: 'Feed' }));
      const feed = await screen.findByRole('region', { name: 'Prévia do feed' });
      expect(probe.search).toBe('?vista=feed');
      expect(screen.getByRole('button', { name: 'Feed' }).getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelector('.portal-days')).toBeNull();
      expect(within(feed).getByText('@padariacentral')).toBeTruthy();
      const labels = Array.from(feed.querySelectorAll('li > .visually-hidden')).map((node) => node.textContent);
      expect(labels).toEqual([
        'Carrossel sem hora · Carrossel · 20/10',
        'Imagem da tarde · Imagem · 20/10',
        'Imagem da manhã · Imagem · 20/10',
        'Reels antigo · Reels · 02/10'
      ]);

      fireEvent.click(screen.getByRole('button', { name: 'Calendário' }));
      expect(await screen.findByRole('link', { name: 'Vídeo longo' })).toBeTruthy();
      expect(probe.search).toBe('');
      expect(screen.queryByRole('region', { name: 'Prévia do feed' })).toBeNull();
    });

    it('marks as planned only what is after today in São Paulo, and keeps the same month and the same query', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Ontem', format: 'image', publishOn: '2026-10-10', status: 'published' });
      world.api.seed({ title: 'Hoje', format: 'image', publishOn: TODAY, status: 'approved' });
      world.api.seed({ title: 'Amanhã', format: 'image', publishOn: '2026-10-12', status: 'approved' });
      renderPortal(world, [contentsUrl('?vista=feed')]);
      await ready();
      const feed = await screen.findByRole('region', { name: 'Prévia do feed' });
      await within(feed).findByText('Amanhã · Imagem · 12/10');
      const tileOf = (title: string): HTMLElement => within(feed).getByText(new RegExp(`^${title} ·`)).closest('li') as HTMLElement;
      expect(within(tileOf('Amanhã')).getByText('Planejado')).toBeTruthy();
      expect(within(tileOf('Hoje')).queryByText('Planejado')).toBeNull();
      expect(within(tileOf('Ontem')).queryByText('Planejado')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
      await screen.findByRole('heading', { name: 'Novembro 2026' });
      expect(periodCalls(world).at(-1)).toBe(`GET /clients/${CLIENT_ID}/contents?from=2026-11-01&to=2026-11-30`);
      expect(screen.getByRole('button', { name: 'Feed' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('does not offer the status filter, does not apply it, and gives it back with the list', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Aprovado', format: 'image', publishOn: '2026-10-12', status: 'approved' });
      world.api.seed({ title: 'Em ajuste', format: 'image', publishOn: '2026-10-13', status: 'adjusting' });
      const { container } = renderPortal(world, [contentsUrl('?situacao=approved')]);
      await ready();
      await screen.findByText('Aprovado');
      expect(titlesOf(container)).toEqual(['Aprovado']);

      fireEvent.click(screen.getByRole('button', { name: 'Feed' }));
      const feed = await screen.findByRole('region', { name: 'Prévia do feed' });
      expect(screen.queryByLabelText('Filtro')).toBeNull();
      expect(within(feed).getAllByRole('listitem')).toHaveLength(2);

      fireEvent.click(screen.getByRole('button', { name: 'Calendário' }));
      await screen.findByLabelText('Filtro');
      expect(titlesOf(container)).toEqual(['Aprovado']);
    });

    it('says there is no post of the feed when the month only has long videos, and the month text when it has nothing', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Só vídeo longo', format: 'long_video', publishOn: '2026-10-12' });
      renderPortal(world, [contentsUrl('?vista=feed')]);
      await ready();
      expect(await screen.findByText('Nenhum post do feed planejado para este mês')).toBeTruthy();
      expect(screen.queryByText('Só vídeo longo')).toBeNull();
      cleanup();

      renderPortal(makeWorld(), [contentsUrl('?vista=feed')]);
      await ready();
      expect(await screen.findByText('Nenhum conteúdo planejado para este mês')).toBeTruthy();
    });

    it('hides the handle when the client has none', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Um post', format: 'image', publishOn: '2026-10-12' });
      renderPortal(world, [contentsUrl('?vista=feed')]);
      await ready();
      const feed = await screen.findByRole('region', { name: 'Prévia do feed' });
      expect(feed.textContent).not.toMatch(/@/);
    });
  });

  describe('the states of the screen', () => {
    it('says the month is empty, with the sentence of the SPEC', async () => {
      const world = makeWorld();
      renderPortal(world);
      await ready();
      expect(await screen.findByText('Nenhum conteúdo planejado para este mês')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('draws a skeleton while the first month loads, never announced, and the list replaces it', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Chegou', publishOn: '2026-10-12' });
      let release: () => void = () => undefined;
      world.api.state.holdPeriod = new Promise<void>((resolveHold) => { release = resolveHold; });
      const { container } = renderPortal(world);
      await ready();
      await waitFor(() => expect(container.querySelector('.portal-contents__skeleton')).toBeTruthy());
      expect(container.querySelector('.portal-contents__skeleton')?.getAttribute('aria-hidden')).toBe('true');
      expect(screen.queryByText('Nenhum conteúdo planejado para este mês')).toBeNull();
      release();
      expect(await screen.findByText('Chegou')).toBeTruthy();
      expect(container.querySelector('.portal-contents__skeleton')).toBeNull();
    });

    it('asks the second month with a skeleton, not with the first month under another title', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'De outubro', publishOn: '2026-10-12' });
      world.api.seed({ title: 'De novembro', publishOn: '2026-11-12' });
      const { container } = renderPortal(world);
      await ready();
      await screen.findByText('De outubro');
      let release: () => void = () => undefined;
      world.api.state.holdPeriod = new Promise<void>((resolveHold) => { release = resolveHold; });
      fireEvent.click(screen.getByRole('button', { name: 'Próximo mês' }));
      await waitFor(() => expect(container.querySelector('.portal-contents__skeleton')).toBeTruthy());
      expect(screen.queryByText('De outubro')).toBeNull();
      release();
      expect(await screen.findByText('De novembro')).toBeTruthy();
    });

    it('says it could not load, offers Tentar de novo, and the retry brings the month', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Voltou', publishOn: '2026-10-12' });
      world.api.state.failPeriod = () => contentsError(500, 'INTERNAL_ERROR');
      renderPortal(world);
      await ready();
      const alert = await screen.findByRole('alert', undefined, { timeout: 5000 });
      expect(within(alert).getByText('Não foi possível carregar os conteúdos. Tente de novo.')).toBeTruthy();
      expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();

      world.api.state.failPeriod = null;
      fireEvent.click(within(alert).getByRole('button', { name: 'Tentar de novo' }));
      expect(await screen.findByText('Voltou')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('does not change the screen when the month is read again: the list stays while the new answer is on its way', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Fica na tela', publishOn: '2026-10-12' });
      const { container, queryClient } = renderPortal(world);
      await ready();
      await screen.findByText('Fica na tela');
      let release: () => void = () => undefined;
      world.api.state.holdPeriod = new Promise<void>((resolveHold) => { release = resolveHold; });
      const before = periodCalls(world).length;
      void queryClient.invalidateQueries({ queryKey: ['portal', CLIENT_ID, 'contents', 'period'] });
      await waitFor(() => expect(periodCalls(world)).toHaveLength(before + 1));
      expect(screen.getByText('Fica na tela')).toBeTruthy();
      expect(container.querySelector('.portal-contents__skeleton')).toBeNull();
      release();
      await waitFor(() => expect(screen.getByText('Fica na tela')).toBeTruthy());
    });
  });

  describe('the icons and the empty states (#688)', () => {
    it.each([
      ['image', 'image'],
      ['carousel', 'gallery-vertical'],
      ['reels', 'clapperboard'],
      ['long_video', 'video'],
      ['vsl', 'monitor-play']
    ] as const)('draws a %s that has no cover as the %s icon, and no character', async (format, icon) => {
      const world = makeWorld();
      world.api.seed({ title: 'Sem capa', format, publishOn: '2026-10-12' });
      renderPortal(world);
      await ready();
      await screen.findByText('Sem capa');
      expect(shapeOf(cardOf('Sem capa'))).toBe(icon);
      expect(cardOf('Sem capa').querySelector('.portal-card__cover')?.textContent).toBe('');
      expect(cardOf('Sem capa').querySelector('.format-shape')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('draws no character as an icon in the files that draw the list and the cover', () => {
      for (const file of ['portal-contents.tsx', 'portal-content-cover.tsx', 'content-cover.tsx']) {
        expect(readFileSync(resolve(process.cwd(), 'src', file), 'utf8'), file).not.toMatch(/[▣▤▶‹›]/u);
      }
    });

    it('moves the month with a chevron on each button, named by where it goes', async () => {
      renderPortal(makeWorld());
      await ready();
      const previous = screen.getByRole('button', { name: 'Mês anterior' });
      const next = screen.getByRole('button', { name: 'Próximo mês' });
      expect(previous.querySelector('svg')?.getAttribute('class')).toContain('lucide-chevron-left');
      expect(next.querySelector('svg')?.getAttribute('class')).toContain('lucide-chevron-right');
      expect(previous.textContent).toBe('');
      expect(next.textContent).toBe('');
    });

    it('uses the pieces the portal shares: the headline of the page, the title of a block and the error block', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Para aprovar', publishOn: '2026-10-14', status: 'awaiting_approval' });
      world.api.state.failAwaiting = () => contentsError(500, 'INTERNAL_ERROR');
      renderPortal(world);
      await ready();
      expect(screen.getByRole('heading', { level: 1, name: 'Conteúdos' }).classList.contains('portal-headline')).toBe(true);
      expect(screen.getByRole('heading', { level: 2, name: 'Outubro 2026' }).classList.contains('portal-contents__period-title')).toBe(true);
      const block = await screen.findByRole('region', { name: 'O que precisa de você' }, { timeout: 5000 });
      expect(within(block).getByRole('heading', { level: 2 }).classList.contains('portal-section__title')).toBe(true);
      expect(within(block).getByRole('alert').classList.contains('portal-error')).toBe(true);
    });

    it('says what is missing in an empty month, with the owl, and offers no way out in the month of today', async () => {
      renderPortal(makeWorld());
      await ready();
      expect(await screen.findByRole('heading', { name: 'Nenhum conteúdo planejado para este mês' })).toBeTruthy();
      expect(screen.getByText('Quando a agência planejar, os posts aparecem aqui.')).toBeTruthy();
      expect(document.querySelectorAll('.ui-empty-state--mascot')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Ir para este mês' })).toBeNull();
    });

    it('takes the person back to the month of today from an empty month that is not it', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'De outubro', publishOn: '2026-10-12' });
      const { probe } = renderPortal(world, [contentsUrl('?data=2026-12-10')]);
      await ready();
      expect(await screen.findByRole('heading', { name: 'Nenhum conteúdo planejado para este mês' })).toBeTruthy();
      expect(document.querySelectorAll('.ui-empty-state--mascot')).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Ir para este mês' }));
      expect(await screen.findByText('De outubro')).toBeTruthy();
      expect(probe.search).toBe('');
      expect(screen.getByRole('heading', { name: 'Outubro 2026' })).toBeTruthy();
    });

    it('offers to clear the filter when no content of the month has that status, without the owl', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Aprovado de outubro', publishOn: '2026-10-12', status: 'approved' });
      const { probe } = renderPortal(world, [contentsUrl('?situacao=adjusting')]);
      await ready();
      expect(await screen.findByRole('heading', { name: 'Nenhum conteúdo nesta situação neste mês' })).toBeTruthy();
      expect(document.querySelectorAll('.ui-empty-state--mascot')).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: 'Limpar o filtro' }));
      expect(await screen.findByText('Aprovado de outubro')).toBeTruthy();
      expect(probe.search).toBe('');
      expect(screen.queryByRole('heading', { name: 'Nenhum conteúdo nesta situação neste mês' })).toBeNull();
    });

    it('offers the list when the feed has no post of its formats, and keeps the month', async () => {
      const world = makeWorld();
      world.api.seed({ title: 'Só vídeo longo', format: 'long_video', publishOn: '2026-10-12' });
      const { probe } = renderPortal(world, [contentsUrl('?vista=feed&data=2026-10-01')]);
      await ready();
      expect(await screen.findByRole('heading', { name: 'Nenhum post do feed planejado para este mês' })).toBeTruthy();
      expect(screen.getByText('O feed mostra imagens, carrosséis e reels. Os outros formatos estão na lista.')).toBeTruthy();
      expect(document.querySelectorAll('.ui-empty-state--mascot')).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: 'Ver a lista' }));
      expect(await screen.findByRole('link', { name: 'Só vídeo longo' })).toBeTruthy();
      expect(probe.search).toBe('?data=2026-10-01');
    });

    it('offers Tentar de novo as a secondary action when the month does not load, and draws no primary one', async () => {
      const world = makeWorld();
      world.api.state.failPeriod = () => contentsError(500, 'INTERNAL_ERROR');
      const { container } = renderPortal(world);
      await ready();
      expect(await screen.findByText('Não foi possível carregar os conteúdos. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
      const retry = within(container.querySelector('.portal-error[role="alert"]') as HTMLElement).getByRole('button', { name: 'Tentar de novo' });
      expect(retry.classList.contains('ui-button--secondary')).toBe(true);
      expect(container.querySelectorAll('.ui-button--primary')).toHaveLength(0);
    });
  });

  describe('on a phone', () => {
    const css = (): string => readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf8').replace(/\r\n/g, '\n');
    /** The block that opens with `selector`, not one that merely ends with it (a line of a longer selector list). */
    const rule = (selector: string): string => {
      const text = css();
      for (let start = text.indexOf(`\n${selector} {`); start !== -1; start = text.indexOf(`\n${selector} {`, start + 1)) {
        const before = text.slice(0, start).trimEnd();
        if (before === '' || before.endsWith('}') || before.endsWith('*/')) return text.slice(start, text.indexOf('}', start));
      }
      throw new Error(`${selector} was not found in globals.css.`);
    };

    it('keeps the bottom bar the last piece of the shell with a short month, and the content taking the rest', async () => {
      const world = makeWorld();
      const { container } = renderPortal(world);
      await ready();
      await screen.findByText('Nenhum conteúdo planejado para este mês');
      const shell = container.querySelector('.portal-shell') as HTMLElement;
      expect(Array.from(shell.children).map((child) => child.tagName.toLowerCase())).toEqual(['a', 'header', 'main', 'nav']);
      expect(shell.lastElementChild).toBe(nav());
      // jsdom has no layout: the rules that put the bar at the bottom of a 360x780 phone with a short page are read from the stylesheet.
      expect(rule('.portal-shell')).toMatch(/min-height:\s*100dvh;/);
      expect(rule('.portal-shell > .portal-content')).toMatch(/flex:\s*1;/);
      expect(rule('.portal-nav')).toMatch(/position:\s*sticky;/);
      expect(rule('.portal-nav')).toMatch(/bottom:\s*0;/);
    });

    it('lets every box shrink and every text wrap, with no fixed width that could push a 390 px screen sideways', () => {
      expect(rule('.portal-contents')).toMatch(/min-width:\s*0;/);
      expect(rule('.portal-awaiting')).toMatch(/min-width:\s*0;/);
      expect(rule('.portal-awaiting__item')).toMatch(/min-width:\s*0;/);
      expect(rule('.portal-awaiting__list')).toMatch(/grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/);
      expect(rule('.portal-day')).toMatch(/grid-template-columns:\s*4rem minmax\(0, 1fr\);/);
      expect(rule('.portal-card')).toMatch(/grid-template-columns:\s*4rem minmax\(0, 1fr\);/);
      expect(rule('.portal-contents__period')).toMatch(/grid-template-columns:\s*2\.75rem minmax\(0, 1fr\) 2\.75rem;/);
      expect(rule('.portal-contents__toggle')).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
      expect(rule('.portal-day__items,\n.portal-card__text')).toMatch(/min-width:\s*0;/);
      expect(rule('.portal-contents .ui-select')).toMatch(/width:\s*100%;/);
      const wrapping = rule('.portal-awaiting__title,\n.portal-awaiting__day,\n.portal-awaiting__more,\n.portal-card__title,\n.portal-day__label');
      expect(wrapping).toMatch(/overflow-wrap:\s*anywhere;/);
      expect(rule('.portal-contents__period-title')).toMatch(/overflow-wrap:\s*anywhere;/);
      for (const selector of ['.portal-contents', '.portal-awaiting', '.portal-awaiting__list', '.portal-days,\n.portal-day__items', '.portal-card__text', '.portal-awaiting__skeleton']) {
        expect(rule(selector)).not.toMatch(/(^|[^-])(width|min-width):\s*[\d.]+(px|rem)/);
      }
      expect(rule('.portal-awaiting__skeleton')).toMatch(/width:\s*100%;/);
    });

    it('stretches the link of the title over the whole card, so the tap does not have to find the words', () => {
      expect(rule('.portal-card-link::after')).toMatch(/content:\s*'';/);
      expect(rule('.portal-card-link::after')).toMatch(/position:\s*absolute;/);
      expect(rule('.portal-card-link::after')).toMatch(/inset:\s*0;/);
      expect(rule('.portal-card')).toMatch(/position:\s*relative;/);
      expect(rule('.portal-awaiting__item')).toMatch(/position:\s*relative;/);
      expect(rule('.portal-awaiting__item:has(.portal-card-link:focus-visible),\n.portal-card:has(.portal-card-link:focus-visible)')).toMatch(/outline:\s*2px solid var\(--focus-ring\);/);
    });

    it('gives the controls a touch target of 44 px, and the cover a shape that does not depend on the picture', () => {
      expect(rule('.portal-contents__period .ui-button,\n.portal-contents__toggle .ui-button')).toMatch(/min-height:\s*2\.75rem;/);
      expect(rule('.portal-card__cover')).toMatch(/aspect-ratio:\s*1;/);
      expect(rule('.portal-awaiting__cover')).toMatch(/aspect-ratio:\s*4 \/ 5;/);
    });
    it('tints the card by its format with the tokens of the agency calendar, and writes the title in the foreground of the format', () => {
      for (const format of ['carousel', 'reels', 'static']) {
        const block = rule(`.portal-card[data-format='${format}']`);
        expect(block).toContain(`background: var(--format-${format}-bg);`);
        expect(block).toContain(`--portal-card-title: var(--format-${format}-fg);`);
      }
      expect(rule('.portal-card__title')).toContain('color: var(--portal-card-title, var(--text-primary));');
      expect(rule('.portal-card')).toContain('border: 1px solid var(--border-default);');
      expect(rule('.portal-card .portal-meta')).toContain('margin: 0;');
    });

    it('sizes the shape of a format by a property of the cover, or by its own font', () => {
      expect(rule('.format-shape > svg')).toContain('width: var(--format-shape-size, 1em);');
      expect(rule('.format-shape > svg')).toContain('height: var(--format-shape-size, 1em);');
      expect(rule('.portal-awaiting__cover--placeholder,\n.portal-card__cover--placeholder')).toContain('--format-shape-size: 1.5rem;');
    });

    it('keeps the screen to the three sizes of text of the Pauta: the title of the page, the line and the caption', () => {
      const text = css();
      const start = text.indexOf('/* --- Portal: Conteúdos (#269, #688)');
      const end = text.indexOf('/* --- Portal: post em tela cheia');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const fonts = new Set(Array.from(text.slice(start, end).matchAll(/\n\s*font: var\(--([a-z-]+)\)/g), (match) => match[1]));
      expect([...fonts].sort()).toEqual(['body-md', 'caption']);
      expect(rule('.portal-contents .portal-empty .ui-empty-state__title')).toContain('font: var(--body-md);');
    });

    it('does not let a cover of a third of the page, nor a card as wide as the page, on a wide screen', () => {
      const text = css();
      const start = text.indexOf('/* A wide screen is not three covers');
      const block = text.slice(start, text.indexOf('\n}\n\n', text.indexOf('.portal-day__items', start)) + 3);
      expect(block).toContain('@media (min-width: 48rem)');
      expect(block).toMatch(/\.portal-awaiting__list \{\n\s+grid-template-columns: repeat\(3, minmax\(0, 10rem\)\);/);
      expect(block).toMatch(/\.portal-day__items \{\n\s+grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 18rem\), 24rem\)\);/);
    });

    it('scrolls the whole card clear of the bottom bar when its link takes the focus, not only the link', () => {
      expect(rule('.portal-card-link')).toMatch(/scroll-margin-bottom:\s*4rem;/);
      expect(rule('html:has(.portal-shell)')).toMatch(/scroll-padding-bottom:\s*calc\(5\.5rem/);
    });

    it('draws the skeleton with the shape of a card, so the first load does not jump', () => {
      expect(rule('.portal-contents__skeleton .ui-skeleton')).toMatch(/height:\s*5rem;/);
      expect(rule('.portal-contents__skeleton .ui-skeleton')).toMatch(/border-radius:\s*var\(--radius-md\);/);
    });

  });
});
