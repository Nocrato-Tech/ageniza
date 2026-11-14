// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

/** "Parado no cliente" and the four blocks of the week on the Início of the agency (scope redesign igual ao quadro, 4.B). */

afterEach(() => { cleanup(); vi.useRealTimers(); });

// A click on an item opens the modal of the content: jsdom has no top layer, so these stubs only model opening and closing.
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

/** 01:30Z is still the evening of the 11th (Wednesday) in São Paulo. */
const NIGHT = '2026-11-12T01:30:00.000Z';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLINICA = '1a1a1a1a-1111-4111-8111-111111111111';
const PADARIA = '2b2b2b2b-2222-4222-8222-222222222222';
const ASSET = '5a5a5a5a-5555-4555-8555-555555555555';
const ALL = ['conteudo.visualizar', 'cliente.visualizar'];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Item {
  id: string;
  title: string;
  format?: 'image' | 'carousel' | 'reels' | 'long_video' | 'vsl';
  publishOn?: string;
  thumbnailAssetId?: string | null;
  sentAt?: string | null;
  dueAt?: string | null;
  dueOn?: string | null;
  daysWaiting?: number | null;
  daysToDue?: number | null;
  daysLate?: number | null;
}

const item = (input: Item) => ({
  format: 'reels', publishOn: '2026-10-20', sentAt: '2026-10-09T12:00:00.000Z', dueOn: null, dueAt: null, daysWaiting: null, daysToDue: null,
  thumbnailAssetId: null, daysLate: null, ...input
});
const cid = (n: number): string => `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Group = { clientId: string; clientName: string; approvers?: string[] | null; contents: ReturnType<typeof item>[] };

interface Summary {
  awaitingClient: number;
  overdueAwaitingClient: number;
  approvedThisMonth: number;
  approvedLastMonth: number;
  scheduled: { count: number; lastPublishOn: string | null };
}

const SUMMARY_DATA: Summary = { awaitingClient: 5, overdueAwaitingClient: 1, approvedThisMonth: 12, approvedLastMonth: 9, scheduled: { count: 6, lastPublishOn: '2026-11-20' } };

interface Scenario {
  readonly permissions?: readonly string[];
  readonly groups?: readonly Group[];
  readonly truncated?: boolean;
  readonly summary?: Summary;
  /** Answers instead of the fake for the list, when it returns a response. */
  readonly answer?: (call: number) => Response | undefined;
  readonly summaryAnswer?: (call: number) => Response | undefined;
}

const makeFetch = (scenario: Scenario) => {
  const calls: string[] = [];
  const summaryCalls: string[] = [];
  const permissions = scenario.permissions ?? ALL;
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname.endsWith('/auth/session')) return json({ user: { id: '99999999-9999-4999-8999-999999999999', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } });
    if (url.pathname === `/agencies/${AGENCY}/me`) return json({ agencyId: AGENCY, agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Papel' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions });
    if (url.pathname === `/agencies/${AGENCY}/contents/awaiting-client`) {
      calls.push(`${method} ${url.pathname}`);
      const custom = scenario.answer?.(calls.length);
      if (custom !== undefined) return custom;
      return json({ data: (scenario.groups ?? []).map((group) => ({ approvers: null, ...group })), meta: { truncated: scenario.truncated ?? false } });
    }
    if (url.pathname === `/agencies/${AGENCY}/contents/summary`) {
      summaryCalls.push(`${method} ${url.pathname}`);
      const custom = scenario.summaryAnswer?.(summaryCalls.length);
      if (custom !== undefined) return custom;
      return json({ data: scenario.summary ?? SUMMARY_DATA });
    }
    if (url.pathname === `/agencies/${AGENCY}/media/${ASSET}/download-url`) return json({ url: 'https://files.example.test/capa.png', expiresAt: '2026-11-12T02:00:00.000Z' });
    if (/\/(contents\/activation|clients)$/.test(url.pathname)) return json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404);
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls, summaryCalls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface Probe { pathname: string; search: string; hash: string; state: unknown }

const STATE = { from: '/agencia/x/clientes?busca=padaria' };

const mount = async (scenario: Scenario) => {
  const fake = makeFetch(scenario);
  const client = new HttpClient('http://127.0.0.1:3001', fake.impl, { onSessionEnded: () => undefined });
  const store = createAuthSessionStore(client);
  const probe: Probe = { pathname: '', search: '', hash: '', state: undefined };
  function Watch() {
    useCommittedLocation((location) => { probe.pathname = location.pathname; probe.search = location.search; probe.hash = location.hash; probe.state = location.state; });
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
  await screen.findByRole('heading', { level: 1, name: /, Pessoa$/ });
  return { ...fake, probe };
};

const section = async (): Promise<HTMLElement> => (await screen.findByRole('heading', { name: 'Parado no cliente', level: 2 })).closest('section')!;

const at = (instant: string): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(instant));
};

const TWO_CLIENTS: Group[] = [
  {
    clientId: CLINICA,
    clientName: 'Clínica Vida',
    approvers: ['Rosana Teixeira', 'Carla Menezes'],
    contents: [
      item({ id: cid(1), title: '5 sinais de check-up', daysWaiting: 5, publishOn: '2026-11-09', daysLate: 2, format: 'image' }),
      item({ id: cid(2), title: 'Bastidores da recepção', daysWaiting: 1, publishOn: '2026-11-18', format: 'carousel' })
    ]
  },
  {
    clientId: PADARIA,
    clientName: 'Padaria Trigo Bom',
    approvers: [],
    contents: [item({ id: cid(3), title: 'Pão de sábado', format: 'reels', daysWaiting: 0, publishOn: '2026-11-17' })]
  }
];

describe('the list', () => {
  it('groups by client in the order of the API, with who answers, the count and the way the board says it', async () => {
    await mount({ groups: TWO_CLIENTS });
    const block = within(await section());
    expect((await block.findAllByRole('heading', { level: 3 })).map((heading) => heading.textContent)).toEqual(['Clínica Vida', 'Padaria Trigo Bom']);
    expect(block.getByText('Do mais antigo para o mais novo. O cliente responde pelo link.')).toBeTruthy();
    expect(block.getByText('3 posts', { selector: '.ui-pill' })).toBeTruthy();
    expect(block.getByText('2 posts · Rosana Teixeira e mais 1')).toBeTruthy();
    // A client with nobody who entered the portal yet has the count only.
    expect(block.getByText('1 post')).toBeTruthy();
    // The order inside a client is the API's (the oldest sent first), not the day of the publication.
    const titles = block.getAllByRole('link').filter((link) => link.classList.contains('awaiting-client__item')).map((link) => link.querySelector('.awaiting-client__item-title')?.textContent);
    expect(titles).toEqual(['5 sinais de check-up', 'Bastidores da recepção', 'Pão de sábado']);
  });

  it('says the late one by the day it should have gone out, and the others by how long ago they were sent', async () => {
    await mount({ groups: TWO_CLIENTS });
    const block = within(await section());
    expect(await block.findByText('Estático · deveria ter saído em 9 de novembro')).toBeTruthy();
    expect(block.getByText('Atrasado 2 dias', { selector: '.ui-late-badge' })).toBeTruthy();
    expect(block.getByText('Carrossel · enviado há 1 dia')).toBeTruthy();
    expect(block.getByText('Reels · enviado hoje')).toBeTruthy();
    expect(block.getAllByText('Aguardando aprovação', { selector: '.ui-status-tag' })).toHaveLength(2);
  });

  it('counts "atrasado" in the singular and plural, and a late content is never "aguardando"', async () => {
    await mount({ groups: [{ clientId: CLINICA, clientName: 'Clínica Vida', contents: [item({ id: cid(1), title: 'Um dia', daysLate: 1, publishOn: '2026-11-10' }), item({ id: cid(2), title: 'Dez dias', daysLate: 10, publishOn: '2026-11-01' })] }] });
    const block = within(await section());
    expect(await block.findByText('Atrasado 1 dia')).toBeTruthy();
    expect(block.getByText('Atrasado 10 dias')).toBeTruthy();
    expect(block.queryByText('Aguardando aprovação')).toBeNull();
  });

  it.each([
    // 15:00Z is noon in São Paulo; 01:30Z is 22h30 of the evening before.
    ['2026-11-14T15:00:00.000Z', '2026-11-14', 2, 'vence sáb, 14/11, às 12h'],
    ['2026-11-12T01:30:00.000Z', '2026-11-11', 0, 'vence qua, 11/11, às 22h30'],
    ['2026-11-10T01:30:00.000Z', '2026-11-09', -2, 'venceu seg, 09/11, às 22h30']
  ])('says the deadline of the approval with its hour, in São Paulo: %s is "%s"', async (dueAt, dueOn, daysToDue, text) => {
    await mount({ groups: [{ clientId: CLINICA, clientName: 'Clínica Vida', contents: [item({ id: cid(1), title: 'Post', format: 'carousel', daysWaiting: 2, daysToDue, dueAt, dueOn })] }] });
    expect(await within(await section()).findByText(`Carrossel · enviado há 2 dias · ${text}`)).toBeTruthy();
  });

  it('a content sent before the rounds has neither date: only the format and the state', async () => {
    await mount({ groups: [{ clientId: CLINICA, clientName: 'Clínica Vida', contents: [item({ id: cid(1), title: 'Antigo', sentAt: null, format: 'carousel' })] }] });
    const block = within(await section());
    expect(await block.findByText('Carrossel')).toBeTruthy();
    expect(block.queryByText(/vence|venceu|enviado/)).toBeNull();
    expect(block.getByText('Aguardando aprovação')).toBeTruthy();
  });

  it('draws the cover of the content, and the shape of its format while there is none', async () => {
    await mount({ groups: [{ clientId: CLINICA, clientName: 'Clínica Vida', contents: [item({ id: cid(1), title: 'Com capa', thumbnailAssetId: ASSET }), item({ id: cid(2), title: 'Sem capa' })] }] });
    const block = await section();
    await waitFor(() => { expect(block.querySelector('img[src="https://files.example.test/capa.png"]')).not.toBeNull(); });
    const covers = Array.from(block.querySelectorAll('.awaiting-client__cover'));
    expect(covers.map((cover) => cover.classList.contains('awaiting-client__cover--placeholder'))).toEqual([false, true]);
  });

  it('says it was cut when the API did not send everything, and that the count is a floor', async () => {
    await mount({ groups: TWO_CLIENTS, truncated: true });
    const block = within(await section());
    expect(await block.findByText('Mostrando os 3 mais antigos.')).toBeTruthy();
    expect(block.getByText('3+ posts', { selector: '.ui-pill' })).toBeTruthy();
  });
});

describe('"Reenviar o link"', () => {
  it('shares the portal address by WhatsApp in a new tab, in the name of the agency, with the first person of the client', async () => {
    await mount({ groups: TWO_CLIENTS });
    const link = await within(await section()).findByRole('link', { name: 'Reenviar o link para Clínica Vida (abre em nova aba)' });
    expect(link.textContent).toBe('Reenviar o link');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    const message = decodeURIComponent((link.getAttribute('href') ?? '').replace('https://wa.me/?text=', ''));
    expect(message).toContain('Olá, Rosana!');
    expect(message).toContain('Aqui é Agência Um.');
    expect(message).toContain('portal de aprovação de Clínica Vida');
    expect(message).toContain(`${window.location.origin}/entrar`);
  });

  it('acts on its own client: the second group names the second client and nobody to greet', async () => {
    await mount({ groups: TWO_CLIENTS });
    const links = within(await section()).getAllByRole('link', { name: /^Reenviar o link/ });
    expect(links).toHaveLength(2);
    const message = decodeURIComponent((links[1]!.getAttribute('href') ?? '').replace('https://wa.me/?text=', ''));
    expect(links[1]!.getAttribute('aria-label')).toBe('Reenviar o link para Padaria Trigo Bom (abre em nova aba)');
    expect(message).toContain('Olá!');
    expect(message).toContain('portal de aprovação de Padaria Trigo Bom');
    expect(message).not.toContain('Clínica Vida');
  });

  it('is not offered to a person who may not read who answers for the client', async () => {
    await mount({ groups: [{ ...TWO_CLIENTS[0]!, approvers: null }] });
    await within(await section()).findByRole('heading', { name: 'Clínica Vida', level: 3 });
    expect(screen.queryByRole('link', { name: /Reenviar o link/ })).toBeNull();
  });
});

describe('the links', () => {
  it('opens the content that was clicked, on the calendar of its month, and carries the state of the carteira', async () => {
    const { probe } = await mount({ groups: TWO_CLIENTS });
    const block = within(await section());
    fireEvent.click(await block.findByRole('link', { name: /Bastidores da recepção/ }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos/${CLINICA}/${cid(2)}`));
    expect(probe.search).toBe('?data=2026-11-18');
    expect(probe.state).toEqual(STATE);
  });

  it('acts on the right row: the second client\'s content opens the second client', async () => {
    const { probe } = await mount({ groups: TWO_CLIENTS });
    fireEvent.click(await within(await section()).findByRole('link', { name: /Pão de sábado/ }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos/${PADARIA}/${cid(3)}`));
    expect(probe.search).toBe('?data=2026-11-17');
  });

  it('names each link with what is seen: the title, the format and the day it should have gone out, and the state', async () => {
    await mount({ groups: TWO_CLIENTS });
    const block = within(await section());
    expect(await block.findByRole('link', { name: '5 sinais de check-up Estático · deveria ter saído em 9 de novembro Atrasado 2 dias' })).toBeTruthy();
    expect(block.getByRole('link', { name: 'Pão de sábado Reels · enviado hoje Aguardando aprovação' })).toBeTruthy();
  });
});

describe('when there is nothing, and when the list did not answer', () => {
  it('says "Nada parado no cliente" as good news only when the query answered with nothing', async () => {
    await mount({ groups: [] });
    const block = within(await section());
    expect(await block.findByRole('heading', { name: 'Nada parado no cliente', level: 3 })).toBeTruthy();
    expect(block.getByText('Nenhum conteúdo está esperando a aprovação de um cliente.')).toBeTruthy();
    expect(block.queryByRole('alert')).toBeNull();
    expect(block.queryByText(/posts?$/)).toBeNull();
    expect(document.querySelector('.ui-empty-state--good-news')).not.toBeNull();
  });

  it('a failure is a failure, never "nada parado": the mascot says so, and "Tentar de novo" reads the list again', async () => {
    const { calls } = await mount({ answer: (call) => (call <= 2 ? json({ error: { code: 'INTERNAL_ERROR', message: 'MENSAGEM DO SERVIDOR' } }, 500) : undefined), groups: TWO_CLIENTS });
    const block = within(await section());
    expect(await block.findByRole('alert')).toBeTruthy();
    expect(block.getByRole('heading', { name: 'Não foi possível carregar o que está parado no cliente', level: 3 })).toBeTruthy();
    expect(block.getByText('A lista não respondeu. Isso não quer dizer que nada está esperando.')).toBeTruthy();
    expect(block.queryByText('Nada parado no cliente')).toBeNull();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(document.querySelector('.ui-empty-state--failure')).not.toBeNull();
    expect((await section()).querySelector('img.ui-mascot')).not.toBeNull();

    fireEvent.click(block.getByRole('button', { name: 'Tentar de novo' }));
    expect(await block.findByRole('link', { name: /Pão de sábado/ })).toBeTruthy();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(block.queryByRole('alert')).toBeNull();
  });

  it('shows a skeleton while it loads, and no empty state yet', async () => {
    await mount({ answer: () => new Promise<Response>(() => undefined) as unknown as Response });
    const block = within(await section());
    expect(block.queryByText('Nada parado no cliente')).toBeNull();
    expect(document.querySelector('.awaiting-client__skeleton')).not.toBeNull();
  });
});

describe('who sees it', () => {
  it.each([
    ['without the contents', ['cliente.visualizar']],
    ['without the roster behind the contents', ['conteudo.visualizar']]
  ])('is not on the Início %s, and neither the list nor the counters are asked for', async (_name, permissions) => {
    const { calls, summaryCalls } = await mount({ permissions, groups: TWO_CLIENTS });
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    expect(screen.queryByRole('heading', { name: 'Parado no cliente' })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(summaryCalls).toHaveLength(0);
    expect(screen.queryByRole('list', { name: SUMMARY })).toBeNull();
  });
});

const SUMMARY = 'Resumo da semana';
const blockOf = (label: RegExp): HTMLElement => within(screen.getByRole('list', { name: SUMMARY })).getByText(label).closest('a')!;

describe('the four blocks of the week', () => {
  it('says each count in the words of the board, with its way forward', async () => {
    at(NIGHT);
    const { summaryCalls } = await mount({ groups: TWO_CLIENTS });
    expect(await screen.findByRole('list', { name: SUMMARY })).toBeTruthy();
    const waiting = within(blockOf(/^Esperando/));
    expect(waiting.getByText('5')).toBeTruthy();
    expect(waiting.getByText('posts aguardando aprovação')).toBeTruthy();
    expect(waiting.getByText('Ver quem está parado')).toBeTruthy();
    const late = within(blockOf(/^Atrasados/));
    expect(late.getByText('1')).toBeTruthy();
    expect(late.getByText('a data passou sem aprovação')).toBeTruthy();
    expect(late.getByText('Cobrar o cliente')).toBeTruthy();
    const approved = within(blockOf(/^Aprovados/));
    expect(approved.getByText('12')).toBeTruthy();
    // The evening of the 11th: the month before is October, and the comparison is today's count of each.
    expect(approved.getByText('3 a mais que em outubro')).toBeTruthy();
    expect(approved.getByText('Agendar os aprovados')).toBeTruthy();
    const scheduled = within(blockOf(/^Agendados/));
    expect(scheduled.getByText('6')).toBeTruthy();
    expect(scheduled.getByText('programados até dia 20')).toBeTruthy();
    expect(scheduled.getByText('Abrir o calendário')).toBeTruthy();
    expect(screen.queryByText(/saem sozinhos/)).toBeNull();
    // The blocks and the header's sentence share one read.
    expect(summaryCalls).toHaveLength(1);
  });

  it('takes the month before from the São Paulo day: 01:30Z of the 1st of December is still the 30th of November', async () => {
    at('2026-12-01T01:30:00.000Z');
    await mount({ groups: TWO_CLIENTS });
    await screen.findByRole('list', { name: SUMMARY });
    expect(within(blockOf(/^Aprovados/)).getByText('3 a mais que em outubro')).toBeTruthy();
    cleanup();
    at('2026-12-01T04:00:00.000Z');
    await mount({ groups: TWO_CLIENTS });
    await screen.findByRole('list', { name: SUMMARY });
    expect(within(blockOf(/^Aprovados/)).getByText('3 a mais que em novembro')).toBeTruthy();
  });

  it.each([
    [12, 15, '3 a menos que em outubro'],
    [12, 12, 'igual a outubro'],
    [1, 0, '1 a mais que em outubro'],
    [0, 0, 'igual a outubro']
  ])('compares this month (%s) with the month before (%s): "%s"', async (approvedThisMonth, approvedLastMonth, text) => {
    at(NIGHT);
    await mount({ groups: TWO_CLIENTS, summary: { ...SUMMARY_DATA, approvedThisMonth, approvedLastMonth } });
    await screen.findByRole('list', { name: SUMMARY });
    expect(within(blockOf(/^Aprovados/)).getByText(text)).toBeTruthy();
    expect(within(blockOf(/^Aprovados/)).getByText(String(approvedThisMonth))).toBeTruthy();
  });

  it.each([
    [1, '2026-11-07', 'programado até dia 7'],
    [6, '2026-11-20', 'programados até dia 20'],
    [0, null, 'nada programado ainda']
  ])('says the scheduled ones with the day of the last (%s, %s): "%s"', async (count, lastPublishOn, text) => {
    await mount({ groups: TWO_CLIENTS, summary: { ...SUMMARY_DATA, scheduled: { count, lastPublishOn } } });
    await screen.findByRole('list', { name: SUMMARY });
    expect(within(blockOf(/^Agendados/)).getByText(text)).toBeTruthy();
  });

  it('says "post" for one, and shows a zero as a zero when the counter answered it', async () => {
    await mount({ groups: [], summary: { ...SUMMARY_DATA, awaitingClient: 1, overdueAwaitingClient: 0 } });
    await screen.findByRole('list', { name: SUMMARY });
    expect(within(blockOf(/^Esperando/)).getByText('post aguardando aprovação')).toBeTruthy();
    expect(within(blockOf(/^Atrasados/)).getByText('0')).toBeTruthy();
  });

  it('leads "Esperando" and "Atrasados" to the list below, and the section is there to receive them', async () => {
    await mount({ groups: TWO_CLIENTS });
    await screen.findByRole('list', { name: SUMMARY });
    for (const label of [/^Esperando/, /^Atrasados/]) {
      const link = blockOf(label);
      expect(link.getAttribute('href')).toBe('#parado');
      fireEvent.click(link);
      await waitFor(() => { expect(window.location.hash).toBe('#parado'); });
      window.location.hash = '';
    }
    const target = document.getElementById('parado');
    expect(target?.tagName).toBe('SECTION');
    expect(target?.querySelector('#awaiting-client-title')?.textContent).toBe('Parado no cliente');
  });

  it('leads "Aprovados" and "Agendados" to the calendar, carrying the state of the carteira', async () => {
    const { probe } = await mount({ groups: TWO_CLIENTS });
    await screen.findByRole('list', { name: SUMMARY });
    expect(blockOf(/^Aprovados/).getAttribute('href')).toBe(`/agencia/${AGENCY}/conteudos?estado=aprovado`);
    fireEvent.click(blockOf(/^Aprovados/));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos`));
    expect(probe.search).toBe('?estado=aprovado');
    expect(probe.state).toEqual(STATE);
  });

  it('opens the calendar from "Agendados" too', async () => {
    const { probe } = await mount({ groups: TWO_CLIENTS });
    await screen.findByRole('list', { name: SUMMARY });
    expect(blockOf(/^Agendados/).getAttribute('href')).toBe(`/agencia/${AGENCY}/conteudos?estado=agendado`);
    fireEvent.click(blockOf(/^Agendados/));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos`));
    expect(probe.search).toBe('?estado=agendado');
    expect(probe.state).toEqual(STATE);
  });

  it('shows skeletons while the counters load, and no number', async () => {
    await mount({ summaryAnswer: () => new Promise<Response>(() => undefined) as unknown as Response });
    expect(document.querySelector('.home-summary--loading')).not.toBeNull();
    expect(screen.queryByRole('list', { name: SUMMARY })).toBeNull();
    expect(screen.queryByText('Esperando')).toBeNull();
  });

  it('says the counters did not answer, with the mascot, instead of showing zeros; "Tentar de novo" reads them again', async () => {
    const { summaryCalls } = await mount({ summaryAnswer: (call) => (call <= 2 ? json({ error: { code: 'INTERNAL_ERROR', message: 'MENSAGEM DO SERVIDOR' } }, 500) : undefined) });
    const alert = await screen.findByRole('heading', { name: 'Não foi possível carregar o resumo', level: 2 });
    const failure = alert.closest('.ui-empty-state') as HTMLElement;
    expect(failure.getAttribute('role')).toBe('alert');
    expect(within(failure).getByText('Os números não responderam. Isso não quer dizer que está tudo zerado.')).toBeTruthy();
    expect(failure.querySelector('img.ui-mascot')).not.toBeNull();
    expect(screen.queryByRole('list', { name: SUMMARY })).toBeNull();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();

    fireEvent.click(within(failure).getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('list', { name: SUMMARY })).toBeTruthy();
    expect(summaryCalls.length).toBeGreaterThanOrEqual(2);
  });
});
