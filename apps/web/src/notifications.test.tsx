// @vitest-environment jsdom

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notification, NotificationKind } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { NotificationsBell, relativeTime } from './notifications-panel.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { readGlobalCss } from './styles/read-css';

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

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-12T15:00:00.000Z');
const WALLET_STATE = { clientListUrl: `/agencia/${AGENCY}/clientes?q=padaria` };
const sessionBody = { user: { id: AGENCY, name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number): Response => json({ error: { code: 'ERROR', message: 'Failed.' } }, status);

const make = (n: number, kind: NotificationKind, summary: string, elapsed: number, read: boolean): Notification => ({
  id: id(n),
  kind,
  summary,
  createdAt: ago(elapsed),
  readAt: read ? ago(elapsed - MIN) : null,
  destination: kind === 'invitation_accepted'
    ? { type: 'collaborators' }
    : kind === 'material_request_answered'
      ? { type: 'material-request', clientId: CLIENT, threadId: id(900 + n) }
      : { type: 'content', clientId: CLIENT, contentId: id(800 + n) }
});

const sample = (): Notification[] => [
  make(1, 'content_approved', 'Rosana aprovou "Promoção de pães"', 5 * MIN, false),
  make(2, 'content_changes_requested', 'Café Central pediu ajuste em "Reels de maio"', 70 * MIN, false),
  make(3, 'material_request_answered', 'Rosana respondeu "Fotos da equipe"', DAY, true),
  make(4, 'approval_deadline_passed', 'O prazo de "Cardápio" venceu', 3 * DAY, true),
  make(5, 'invitation_accepted', 'Ana aceitou o seu convite', 10 * DAY, true)
];

interface World {
  rows: Notification[];
  countStatus: number;
  listStatus: number;
  listGate: Promise<void> | undefined;
  calls: string[];
}
let world: World;
const unreadOf = (): number => world.rows.filter((row) => row.readAt === null).length;
beforeEach(() => { world = { rows: sample(), countStatus: 200, listStatus: 200, listGate: undefined, calls: [] }; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The API answers in a macrotask, the way a network does: a fake that answers in a microtask hides the states between. */
const answer = (make: () => Response | Promise<Response>): Promise<Response> => new Promise((resolve, reject) => {
  setTimeout(() => { Promise.resolve(make()).then(resolve, reject); }, 0);
});

const notificationsApi = (path: string, search: URLSearchParams, method: string): Promise<Response> | undefined => {
  const base = `/agencies/${AGENCY}/notifications`;
  if (!path.startsWith(base)) return undefined;
  world.calls.push(`${method} ${path.slice(`/agencies/${AGENCY}`.length)}${search.size === 0 ? '' : `?${search}`}`);
  if (method === 'POST') {
    return answer(() => {
      if (path === `${base}/read-all`) world.rows = world.rows.map((row) => ({ ...row, readAt: row.readAt ?? NOW.toISOString() }));
      else world.rows = world.rows.map((row) => (path === `${base}/${row.id}/read` ? { ...row, readAt: row.readAt ?? NOW.toISOString() } : row));
      return new Response(null, { status: 204 });
    });
  }
  if (path === `${base}/unread-count`) return answer(() => (world.countStatus === 200 ? json({ data: { count: unreadOf() } }) : failure(world.countStatus)));
  return answer(async () => {
    await world.listGate;
    if (world.listStatus !== 200) return failure(world.listStatus);
    const page = Number(search.get('page') ?? '1');
    const rows = world.rows.filter((row) => search.get('unread') !== 'true' || row.readAt === null);
    return json({ data: rows.slice((page - 1) * 20, page * 20), meta: { page, pageSize: 20, totalItems: rows.length, totalPages: Math.ceil(rows.length / 20) } });
  });
};

const makeClient = (): HttpClient => new HttpClient('http://127.0.0.1:3001', async (input, init) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const found = notificationsApi(url.pathname, url.searchParams, method);
  if (found !== undefined) return await found;
  if (url.pathname === '/auth/session') return json(sessionBody);
  if (url.pathname === '/health') return json({ status: 'ok' });
  if (url.pathname === `/agencies/${AGENCY}/me`) {
    return json({ agencyId: AGENCY, agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Custom' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions: ['colaborador.visualizar', 'cliente.visualizar', 'conteudo.visualizar'] });
  }
  return json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}<i data-testid="state">{JSON.stringify(location.state)}</i></output>;
}
const where = (): string => screen.getByTestId('where').firstChild?.textContent ?? '';
const walletState = (): unknown => JSON.parse(screen.getByTestId('state').textContent ?? 'null');

const renderBell = () => render(
  <QueryClientProvider client={createQueryClient()}>
    <ApiClientProvider client={makeClient()}>
      <MemoryRouter initialEntries={[{ pathname: `/agencia/${AGENCY}`, state: WALLET_STATE }]}>
        <Where />
        <NotificationsBell agencyId={AGENCY} />
      </MemoryRouter>
    </ApiClientProvider>
  </QueryClientProvider>
);

function Harness({ store }: { store: AuthSessionStore }) {
  return <ApplicationRoutes session={useAuthSession(store)} />;
}
const renderApp = (entry: string) => {
  const client = makeClient();
  const store = createAuthSessionStore(client);
  return render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[{ pathname: entry.split('?')[0]!, search: entry.includes('?') ? `?${entry.split('?')[1]!}` : '', state: WALLET_STATE }]}>
            <Where />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
};
const stubPhone = (): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: !query.includes('min-width'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
};

const bell = async (name: string | RegExp): Promise<HTMLElement> => await screen.findByRole('button', { name });
const hasDot = (button: HTMLElement): boolean => button.querySelector('.ui-icon-button__dot') !== null;
const openPanel = async (name: string | RegExp = /^Notificações/): Promise<HTMLElement> => {
  fireEvent.click(await bell(name));
  return await screen.findByRole('dialog', { name: 'Notificações' });
};
const loadedRows = async (panel: HTMLElement): Promise<HTMLElement[]> => {
  await within(panel).findByRole('link', { name: /Ana aceitou/ });
  return within(panel).getAllByRole('link').filter((link) => link.classList.contains('notif-row'));
};
const settle = async (ms = 10): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe('relativeTime', () => {
  const now = NOW.getTime();
  it.each([
    [30_000, 'agora'],
    [12 * MIN, 'há 12 min'],
    [3 * HOUR, 'há 3 h'],
    [DAY, 'ontem'],
    [3 * DAY, 'há 3 dias'],
    [10 * DAY, '2 nov']
  ])('says %i ms ago as "%s"', (elapsed, text) => {
    expect(relativeTime(ago(elapsed), now)).toBe(text);
  });
});

describe('the bell', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });

  it('shows the dot and the count in the name when something is unread', async () => {
    renderBell();
    const button = await bell('Notificações, 2 não lidas');
    expect(hasDot(button)).toBe(true);
  });

  it('says "1 não lida" in the singular', async () => {
    world.rows = world.rows.map((row) => (row.id === id(2) ? { ...row, readAt: ago(MIN) } : row));
    renderBell();
    expect(hasDot(await bell('Notificações, 1 não lida'))).toBe(true);
  });

  it('has no dot when nothing is unread', async () => {
    world.rows = world.rows.map((row) => ({ ...row, readAt: ago(MIN) }));
    renderBell();
    await waitFor(() => expect(world.calls).toContain('GET /notifications/unread-count'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const button = await bell('Notificações');
    expect(hasDot(button)).toBe(false);
  });

  it('has no dot when the read failed: an error is never "nothing new"', async () => {
    world.countStatus = 404;
    renderBell();
    await waitFor(() => expect(world.calls).toContain('GET /notifications/unread-count'));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const button = await bell('Notificações');
    expect(hasDot(button)).toBe(false);
    expect(button.getAttribute('aria-label')).toBe('Notificações');
  });

  it('drops the dot when a later read fails, instead of keeping the old number', async () => {
    renderBell();
    await bell('Notificações, 2 não lidas');
    world.countStatus = 404;
    fireEvent.click(await bell(/^Notificações/));
    await screen.findByRole('dialog', { name: 'Notificações' });
    fireEvent.click(screen.getByRole('button', { name: 'Marcar todas como lidas' }));
    await waitFor(() => expect(world.calls).toContain('POST /notifications/read-all'));
    expect(await bell('Notificações')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /não lida/ })).toBeNull();
  });
});

describe('the refresh of the count', () => {
  beforeEach(() => { vi.useFakeTimers({ now: NOW }); });
  const countReads = (): number => world.calls.filter((call) => call === 'GET /notifications/unread-count').length;
  const name = (): string | null => screen.getByRole('button', { name: /^Notificações/ }).getAttribute('aria-label');

  it('reads again every 60 seconds, and not before', async () => {
    renderBell();
    await settle();
    expect(name()).toBe('Notificações, 2 não lidas');
    expect(countReads()).toBe(1);
    world.rows = [...world.rows, make(6, 'content_approved', 'Outra aprovação', MIN, false)];
    await settle(58_000);
    expect(countReads()).toBe(1);
    expect(name()).toBe('Notificações, 2 não lidas');
    await settle(2_000);
    expect(countReads()).toBe(2);
    expect(name()).toBe('Notificações, 3 não lidas');
    await settle(60_000);
    expect(countReads()).toBe(3);
  });

  it('reads again when the focus returns to the tab', async () => {
    renderBell();
    await settle();
    expect(countReads()).toBe(1);
    world.rows = [...world.rows, make(6, 'content_approved', 'Outra aprovação', MIN, false)];
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); });
    await settle();
    expect(countReads()).toBe(2);
    expect(name()).toBe('Notificações, 3 não lidas');
  });
});

describe('the panel', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });

  it('shows every text of the board: the title, the action, the filter, the rows with their time, and the way to the page', async () => {
    renderBell();
    const panel = await openPanel();
    expect(within(panel).getByRole('heading', { name: 'Notificações', level: 2 })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Marcar todas como lidas' })).toBeTruthy();
    const filter = within(panel).getByRole('tablist', { name: 'Filtro' });
    expect(within(filter).getByRole('tab', { name: 'Todas' })).toBeTruthy();
    expect(within(filter).getByRole('tab', { name: 'Não lidas 2' })).toBeTruthy();
    await within(panel).findByRole('link', { name: /Rosana aprovou "Promoção de pães"/ });
    for (const group of ['Hoje', 'Ontem']) expect(within(panel).getByRole('heading', { name: group, level: 3 })).toBeTruthy();
    const rows = within(panel).getAllByRole('link').filter((link) => link.classList.contains('notif-row'));
    expect(rows.map((row) => row.textContent)).toEqual([
      'Não lida: Rosana aprovou "Promoção de pães"há 5 min',
      'Não lida: Café Central pediu ajuste em "Reels de maio"há 1 h',
      'Rosana respondeu "Fotos da equipe"ontem',
      'O prazo de "Cardápio" venceuhá 3 dias',
      'Ana aceitou o seu convite2 nov'
    ]);
    expect(within(panel).getByRole('link', { name: 'Ver todas' }).getAttribute('href')).toBe(`/agencia/${AGENCY}/notificacoes`);
  });

  it('marks the unread by the dot and the weight, never by colour alone', async () => {
    renderBell();
    const panel = await openPanel();
    const rows = await loadedRows(panel);
    expect(rows.map((row) => row.hasAttribute('data-unread'))).toEqual([true, true, false, false, false]);
    expect(rows[0]!.querySelector('.notif-row__dot')).not.toBeNull();
    expect(rows[2]!.querySelector('.notif-row__dot')).toBeNull();
    const rules = [...readGlobalCss().matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
    const weight = rules.find((rule) => rule.selector === '.notif-row[data-unread] .notif-row__text');
    expect(weight?.body).toMatch(/font-weight:\s*600/);
  });

  it('opens the right row: reads that one only and goes to its content, keeping the state of the wallet', async () => {
    renderBell();
    const panel = await openPanel();
    fireEvent.click(await within(panel).findByRole('link', { name: /Café Central pediu ajuste/ }));
    await waitFor(() => expect(world.calls).toContain(`POST /notifications/${id(2)}/read`));
    expect(world.calls.filter((call) => call.startsWith('POST'))).toEqual([`POST /notifications/${id(2)}/read`]);
    expect(where()).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT}/${id(802)}`);
    expect(walletState()).toEqual(WALLET_STATE);
    expect(screen.queryByRole('dialog', { name: 'Notificações' })).toBeNull();
    expect(await bell('Notificações, 1 não lida')).toBeTruthy();
  });

  it.each([
    [1, `/agencia/${AGENCY}/conteudos/${CLIENT}/${id(801)}`, true],
    [3, `/agencia/${AGENCY}/clientes/${CLIENT}/geral?pedido=${id(903)}`, false],
    [4, `/agencia/${AGENCY}/conteudos/${CLIENT}/${id(804)}`, false],
    [5, `/agencia/${AGENCY}/colaboradores`, false]
  ])('goes from row %i to its destination, and reads it only if it was unread', async (n, destination, unread) => {
    renderBell();
    const panel = await openPanel();
    const rows = await loadedRows(panel);
    fireEvent.click(rows[n - 1]!);
    await waitFor(() => expect(where()).toBe(destination));
    expect(walletState()).toEqual(WALLET_STATE);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(world.calls.filter((call) => call.startsWith('POST'))).toEqual(unread ? [`POST /notifications/${id(n)}/read`] : []);
  });

  it('reads them all with one call and the dot goes away', async () => {
    renderBell();
    const panel = await openPanel('Notificações, 2 não lidas');
    await within(panel).findByRole('link', { name: /Rosana aprovou/ });
    fireEvent.click(within(panel).getByRole('button', { name: 'Marcar todas como lidas' }));
    await waitFor(() => expect(world.calls).toContain('POST /notifications/read-all'));
    expect(await bell('Notificações')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Não lidas \d/ })).toBeNull());
    await waitFor(() => expect(document.querySelectorAll('.notif-row[data-unread]').length).toBe(0));
    expect(screen.queryByRole('button', { name: /não lida/ })).toBeNull();
    expect((screen.getByRole('button', { name: 'Marcar todas como lidas' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists only the unread in the "Não lidas" filter', async () => {
    renderBell();
    const panel = await openPanel();
    await within(panel).findByRole('link', { name: /Ana aceitou/ });
    fireEvent.click(within(panel).getByRole('tab', { name: 'Não lidas 2' }));
    await waitFor(() => expect(world.calls).toContain('GET /notifications?page=1&unread=true'));
    await waitFor(() => expect(within(panel).queryByRole('link', { name: /Ana aceitou/ })).toBeNull());
    expect(within(panel).getAllByRole('link').filter((link) => link.classList.contains('notif-row'))).toHaveLength(2);
  });

  it('draws a skeleton shaped like the row while it loads, and never "nothing new" before the answer', async () => {
    let release = (): void => undefined;
    world.listGate = new Promise((resolve) => { release = resolve; });
    renderBell();
    const panel = await openPanel();
    await waitFor(() => expect(panel.querySelector('.notif-skeleton__row')).not.toBeNull());
    expect(panel.querySelectorAll('.notif-skeleton__row')).toHaveLength(3);
    expect(within(panel).queryByText('Nada novo por aqui')).toBeNull();
    release();
    expect(await within(panel).findByRole('link', { name: /Rosana aprovou/ })).toBeTruthy();
    expect(panel.querySelector('.notif-skeleton')).toBeNull();
  });

  it('says "Nada novo por aqui" with the tick once the query answered an empty list', async () => {
    world.rows = [];
    renderBell();
    const panel = await openPanel();
    expect(await within(panel).findByRole('heading', { name: 'Nada novo por aqui' })).toBeTruthy();
    expect(within(panel).getByText('Quando um cliente aprovar, pedir ajuste ou responder, você vê aqui.')).toBeTruthy();
    expect(panel.querySelector('.ui-empty-state--good-news .ui-empty-state__icon')).not.toBeNull();
  });

  it('fails with "Tentar de novo", keeps the bell without a dot, and recovers', async () => {
    world.listStatus = 403;
    world.countStatus = 403;
    renderBell();
    const panel = await openPanel('Notificações');
    expect(await within(panel).findByText('Não foi possível carregar as notificações')).toBeTruthy();
    expect(within(panel).queryByText('Nada novo por aqui')).toBeNull();
    expect(screen.queryByRole('button', { name: /não lida/ })).toBeNull();
    world.listStatus = 200;
    fireEvent.click(within(panel).getByRole('button', { name: 'Tentar de novo' }));
    expect(await within(panel).findByRole('link', { name: /Rosana aprovou/ })).toBeTruthy();
    expect(within(panel).queryByText('Não foi possível carregar as notificações')).toBeNull();
  });
});

describe('the page', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });
  const manyRows = (): Notification[] => Array.from({ length: 25 }, (_value, index) => make(index + 1, 'content_approved', `Aprovação ${index + 1}`, (index + 1) * MIN, index >= 2));
  const rowTexts = (): string[] => [...document.querySelectorAll('.notifications-page .notif-row .notif-row__text')].map((row) => row.textContent ?? '');

  it('shows the title, the action, the filter and the list, with the bell in the top bar', async () => {
    renderApp(`/agencia/${AGENCY}/notificacoes`);
    const page = await screen.findByRole('region', { name: 'Notificações' });
    expect(within(page).getByRole('heading', { name: 'Notificações', level: 1 })).toBeTruthy();
    expect(within(page).getByRole('button', { name: 'Marcar todas como lidas' })).toBeTruthy();
    expect(within(page).getByRole('tab', { name: 'Todas' }).getAttribute('aria-selected')).toBe('true');
    expect(await within(page).findByRole('tab', { name: 'Não lidas 2' })).toBeTruthy();
    expect(await within(page).findByRole('link', { name: /Ana aceitou o seu convite/ })).toBeTruthy();
    expect(within(document.querySelector<HTMLElement>('.shell-topbar')!).getByRole('button', { name: 'Notificações, 2 não lidas' })).toBeTruthy();
    expect(document.title).toBe('Notificações — Ageniza');
  });

  it('pages 20 at a time and keeps the page in the address', async () => {
    world.rows = manyRows();
    renderApp(`/agencia/${AGENCY}/notificacoes`);
    await screen.findByText('Aprovação 1');
    expect(rowTexts()).toHaveLength(20);
    expect(screen.getByText('25 notificações')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Página 2' }));
    await waitFor(() => expect(where()).toBe(`/agencia/${AGENCY}/notificacoes?page=2`));
    await screen.findByText('Aprovação 21');
    expect(rowTexts().map((text) => text.replace('Não lida: ', ''))).toEqual(['Aprovação 21', 'Aprovação 22', 'Aprovação 23', 'Aprovação 24', 'Aprovação 25']);
    expect(world.calls).toContain('GET /notifications?page=2');
    expect(walletState()).toEqual(WALLET_STATE);
  });

  it('opens at the page and the filter of the address, and the filter goes back to the first page', async () => {
    world.rows = manyRows();
    renderApp(`/agencia/${AGENCY}/notificacoes?filtro=nao-lidas&page=1`);
    await screen.findByText('Aprovação 1');
    expect(screen.getByRole('tab', { name: /Não lidas/ }).getAttribute('aria-selected')).toBe('true');
    expect(rowTexts().map((text) => text.replace('Não lida: ', ''))).toEqual(['Aprovação 1', 'Aprovação 2']);
    expect(world.calls).toContain('GET /notifications?page=1&unread=true');
    fireEvent.click(screen.getByRole('tab', { name: 'Todas' }));
    await waitFor(() => expect(where()).toBe(`/agencia/${AGENCY}/notificacoes`));
    await screen.findByText('Aprovação 20');
    fireEvent.click(screen.getByRole('button', { name: 'Página 2' }));
    await screen.findByText('Aprovação 21');
    fireEvent.click(screen.getByRole('tab', { name: /Não lidas/ }));
    await waitFor(() => expect(where()).toBe(`/agencia/${AGENCY}/notificacoes?filtro=nao-lidas`));
  });

  it('goes back to the last page when the address points past the end', async () => {
    world.rows = manyRows();
    renderApp(`/agencia/${AGENCY}/notificacoes?page=9`);
    await waitFor(() => expect(where()).toBe(`/agencia/${AGENCY}/notificacoes?page=2`));
    expect(await screen.findByText('Aprovação 21')).toBeTruthy();
  });

  it('reads the row it opens, and reads all, from the page', async () => {
    renderApp(`/agencia/${AGENCY}/notificacoes`);
    fireEvent.click(await screen.findByRole('link', { name: /Café Central pediu ajuste/ }));
    await waitFor(() => expect(where()).toBe(`/agencia/${AGENCY}/conteudos/${CLIENT}/${id(802)}`));
    expect(world.calls.filter((call) => call.startsWith('POST'))).toEqual([`POST /notifications/${id(2)}/read`]);
  });

  it('marks all as read and the dot and the unread rows go away', async () => {
    renderApp(`/agencia/${AGENCY}/notificacoes`);
    const page = await screen.findByRole('region', { name: 'Notificações' });
    await within(page).findByRole('link', { name: /Rosana aprovou/ });
    fireEvent.click(within(page).getByRole('button', { name: 'Marcar todas como lidas' }));
    await waitFor(() => expect(world.calls).toContain('POST /notifications/read-all'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /não lida/ })).toBeNull());
    await waitFor(() => expect(page.querySelectorAll('.notif-row[data-unread]').length).toBe(0));
  });

  it('says "Nada novo por aqui" only after the answer, and "Não foi possível carregar" on a failure', async () => {
    let release = (): void => undefined;
    world.listGate = new Promise((resolve) => { release = resolve; });
    world.rows = [];
    renderApp(`/agencia/${AGENCY}/notificacoes`);
    const page = await screen.findByRole('region', { name: 'Notificações' });
    await waitFor(() => expect(page.querySelector('.notif-skeleton__row')).not.toBeNull());
    expect(within(page).queryByText('Nada novo por aqui')).toBeNull();
    release();
    expect(await within(page).findByRole('heading', { name: 'Nada novo por aqui' })).toBeTruthy();
    cleanup();

    world.listStatus = 403;
    renderApp(`/agencia/${AGENCY}/notificacoes`);
    const failed = await screen.findByRole('region', { name: 'Notificações' });
    expect(await within(failed).findByText('Não foi possível carregar as notificações')).toBeTruthy();
    expect(within(failed).getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
    expect(within(failed).queryByText('Nada novo por aqui')).toBeNull();
  });

  it('says there is nothing unread, in the unread filter, with the same tick', async () => {
    world.rows = world.rows.map((row) => ({ ...row, readAt: ago(MIN) }));
    renderApp(`/agencia/${AGENCY}/notificacoes?filtro=nao-lidas`);
    expect(await screen.findByRole('heading', { name: 'Nada novo por aqui' })).toBeTruthy();
    expect(screen.getByText('Nenhuma notificação por ler.')).toBeTruthy();
  });
});

describe('the bell on the shells', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });

  it('sits in the top bar of the wide shell, before Ajuda', async () => {
    renderApp(`/agencia/${AGENCY}`);
    const bar = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.shell-topbar');
      if (found === null) throw new Error('The top bar is not on screen.');
      return found;
    });
    await within(bar).findByRole('button', { name: 'Notificações, 2 não lidas' });
    expect(within(bar).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual(['Notificações, 2 não lidas', 'Ajuda']);
  });

  it('sits in the top bar of the phone and opens the panel as a sheet inside the screen', async () => {
    stubPhone();
    renderApp(`/agencia/${AGENCY}`);
    const bar = (await screen.findByRole('link', { name: 'Agência Um' })).closest('.agency-mbar') as HTMLElement;
    fireEvent.click(await within(bar).findByRole('button', { name: 'Notificações, 2 não lidas' }));
    const sheet = await screen.findByRole('dialog', { name: 'Notificações' });
    expect(sheet.tagName).toBe('DIALOG');
    expect(await within(sheet).findByRole('link', { name: /Rosana aprovou/ })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Marcar todas como lidas' })).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Fechar as notificações' }));
    expect(screen.queryByRole('dialog', { name: 'Notificações' })).toBeNull();
  });

  it('has no bell in the portal, which has no notifications', async () => {
    renderApp(`/portal/${CLIENT}/inicio`);
    await waitFor(() => expect(document.querySelector('.shell-topbar, .portal-shell')).not.toBeNull());
    expect(screen.queryByRole('button', { name: /^Notificações/ })).toBeNull();
  });
});

describe('CSS contract of the panel', () => {
  const rules = [...readGlobalCss().matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((selector) => selector.trim()),
    body: match[2]!
  }));
  const body = (selector: string): string => rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.body).join(' ');

  it('keeps the card inside a narrow screen and breaks long text instead of scrolling sideways', () => {
    expect(body('.notif-bell .ui-popover')).toContain('min(27rem, calc(100vw - var(--space-8)))');
    expect(body('.notif-row__text')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body('.notif-row')).toContain('minmax(0, 1fr)');
  });

  it('paints no text on the hover background but the primary ink', () => {
    expect(body('.notif-row:hover')).not.toMatch(/color:/);
    expect(body('.notif-row')).toMatch(/color:\s*var\(--text-primary\)/);
  });
});
