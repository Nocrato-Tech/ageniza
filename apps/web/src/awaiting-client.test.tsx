// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

/** "Parado no cliente" on the Início of the agency (scope telas-melhorias, S8). */

afterEach(cleanup);

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

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLINICA = '1a1a1a1a-1111-4111-8111-111111111111';
const PADARIA = '2b2b2b2b-2222-4222-8222-222222222222';
const ALL = ['conteudo.visualizar', 'cliente.visualizar'];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Item {
  id: string;
  title: string;
  format?: 'image' | 'carousel' | 'reels' | 'long_video' | 'vsl';
  publishOn?: string;
  sentAt?: string | null;
  dueOn?: string | null;
  daysWaiting?: number | null;
  daysToDue?: number | null;
}

const item = (input: Item) => ({
  format: 'reels', publishOn: '2026-10-20', sentAt: '2026-10-09T12:00:00.000Z', dueOn: null, daysWaiting: null, daysToDue: null, ...input
});
const cid = (n: number): string => `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Group = { clientId: string; clientName: string; contents: ReturnType<typeof item>[] };

interface Scenario {
  readonly permissions?: readonly string[];
  readonly groups?: readonly Group[];
  readonly truncated?: boolean;
  /** Answers instead of the fake for the list, when it returns a response. */
  readonly answer?: (call: number) => Response | undefined;
}

const makeFetch = (scenario: Scenario) => {
  const calls: string[] = [];
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
      return json({ data: scenario.groups ?? [], meta: { truncated: scenario.truncated ?? false } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface Probe { pathname: string; search: string; state: unknown }

const STATE = { from: '/agencia/x/clientes?busca=padaria' };

const mount = async (scenario: Scenario) => {
  const fake = makeFetch(scenario);
  const client = new HttpClient('http://127.0.0.1:3001', fake.impl, { onSessionEnded: () => undefined });
  const store = createAuthSessionStore(client);
  const probe: Probe = { pathname: '', search: '', state: undefined };
  function Watch() {
    useCommittedLocation((location) => { probe.pathname = location.pathname; probe.search = location.search; probe.state = location.state; });
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
  await screen.findByRole('heading', { name: 'Agência Um', level: 1 });
  return { ...fake, probe };
};

const section = async (): Promise<HTMLElement> => (await screen.findByRole('heading', { name: 'Parado no cliente', level: 2 })).closest('section')!;

const TWO_CLIENTS: Group[] = [
  {
    clientId: CLINICA,
    clientName: 'Clínica Vida',
    contents: [
      item({ id: cid(1), title: '5 sinais de check-up', daysToDue: -2, dueOn: '2026-10-09', daysWaiting: 5, publishOn: '2026-10-20' }),
      item({ id: cid(2), title: 'Bastidores da recepção', daysToDue: 3, dueOn: '2026-10-14', daysWaiting: 1, publishOn: '2026-10-18' })
    ]
  },
  {
    clientId: PADARIA,
    clientName: 'Padaria Trigo Bom',
    contents: [item({ id: cid(3), title: 'Pão de sábado', format: 'image', daysToDue: null, daysWaiting: 4, publishOn: '2026-10-17' })]
  }
];

describe('the list', () => {
  it('groups by client, in the order of the API, with the title, the format and the day of the publication of each', async () => {
    await mount({ groups: TWO_CLIENTS });
    const block = within(await section());
    const clients = (await block.findAllByRole('heading', { level: 3 })).map((heading) => heading.textContent);
    expect(clients).toEqual(['Clínica Vida (2)', 'Padaria Trigo Bom (1)']);
    expect(block.getByText('3 conteúdos em 2 clientes')).toBeTruthy();
    // The order inside a client is the API's (the most urgent first), not the day of the publication.
    const links = block.getAllByRole('link').map((link) => link.querySelector('.awaiting-client__item-title')?.textContent);
    expect(links).toEqual(['5 sinais de check-up', 'Bastidores da recepção', 'Pão de sábado']);
    expect(block.getByText('Publicação: ter, 20/10')).toBeTruthy();
    expect(block.getByText('Publicação: dom, 18/10')).toBeTruthy();
    expect(block.getAllByText('Reels', { selector: '.ui-format-tag' })).toHaveLength(2);
    expect(block.getByText('Imagem', { selector: '.ui-format-tag' })).toBeTruthy();
  });

  it.each([
    [-3, 'venceu há 3 dias'],
    [-1, 'venceu há 1 dia'],
    [0, 'vence hoje'],
    [1, 'vence amanhã'],
    [2, 'vence em 2 dias'],
    [30, 'vence em 30 dias']
  ])('says the deadline %s as "%s", and never in the words of the publication date', async (daysToDue, text) => {
    await mount({ groups: [{ clientId: CLINICA, clientName: 'Clínica Vida', contents: [item({ id: cid(1), title: 'Post', daysToDue, dueOn: '2026-10-14', daysWaiting: 9 })] }] });
    const block = within(await section());
    expect(await block.findByText(text)).toBeTruthy();
    expect(block.queryByText(/enviado/)).toBeNull();
    expect(block.queryByText(/Atrasado|Prazo em dois dias/i)).toBeNull();
  });

  it.each([
    [0, 'enviado hoje'],
    [1, 'enviado há 1 dia'],
    [6, 'enviado há 6 dias']
  ])('without a deadline it says how long ago it was sent: %s is "%s"', async (daysWaiting, text) => {
    await mount({ groups: [{ clientId: CLINICA, clientName: 'Clínica Vida', contents: [item({ id: cid(1), title: 'Post', daysToDue: null, daysWaiting })] }] });
    expect(await within(await section()).findByText(text)).toBeTruthy();
  });

  it('a content sent before the rounds has neither date: it is listed with no state', async () => {
    await mount({ groups: [{ clientId: CLINICA, clientName: 'Clínica Vida', contents: [item({ id: cid(1), title: 'Antigo', sentAt: null })] }] });
    const block = within(await section());
    expect(await block.findByRole('link', { name: /Antigo/ })).toBeTruthy();
    expect(block.queryByText(/vence|venceu|enviado/)).toBeNull();
  });

  it('says it was cut when the API did not send everything', async () => {
    await mount({ groups: TWO_CLIENTS, truncated: true });
    expect(await within(await section()).findByText('Mostrando os 3 mais urgentes.')).toBeTruthy();
  });

  it('shows the deadline with an icon and words, so it is never only a colour', async () => {
    await mount({ groups: TWO_CLIENTS });
    const block = within(await section());
    const expired = (await block.findByText('venceu há 2 dias')).closest('.approval-state')!;
    expect(expired.classList.contains('approval-state--expired')).toBe(true);
    expect(expired.querySelector('svg')).not.toBeNull();
    expect(block.getByText('vence em 3 dias').closest('.approval-state')!.classList.contains('approval-state--expired')).toBe(false);
  });
});

describe('the links', () => {
  it('opens the content that was clicked, on the calendar of its month, and carries the state of the carteira', async () => {
    const { probe } = await mount({ groups: TWO_CLIENTS });
    const block = within(await section());
    fireEvent.click(await block.findByRole('link', { name: /Bastidores da recepção/ }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos/${CLINICA}/${cid(2)}`));
    expect(probe.search).toBe('?data=2026-10-18');
    expect(probe.state).toEqual(STATE);
  });

  it('acts on the right row: the second client\'s content opens the second client', async () => {
    const { probe } = await mount({ groups: TWO_CLIENTS });
    fireEvent.click(await within(await section()).findByRole('link', { name: /Pão de sábado/ }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos/${PADARIA}/${cid(3)}`));
    expect(probe.search).toBe('?data=2026-10-17');
  });

  it('names each link with what is seen: the title, the format, the day and the state', async () => {
    await mount({ groups: TWO_CLIENTS });
    const block = within(await section());
    expect(await block.findByRole('link', { name: '5 sinais de check-up Reels Publicação: ter, 20/10 venceu há 2 dias' })).toBeTruthy();
  });
});

describe('when there is nothing, and when the list did not answer', () => {
  it('says "Nada parado no cliente" as good news only when the query answered with nothing', async () => {
    await mount({ groups: [] });
    const block = within(await section());
    expect(await block.findByRole('heading', { name: 'Nada parado no cliente', level: 3 })).toBeTruthy();
    expect(block.getByText('Nenhum conteúdo está esperando a aprovação de um cliente.')).toBeTruthy();
    expect(block.queryByRole('alert')).toBeNull();
    expect(block.queryByText(/conteúdos? em \d+ clientes?/)).toBeNull();
    expect(document.querySelector('.ui-empty-state--good-news')).not.toBeNull();
  });

  it('a failure is a failure, never "nada parado": it says so and offers to try again, which reads the list again', async () => {
    const { calls } = await mount({ answer: (call) => (call <= 2 ? json({ error: { code: 'INTERNAL_ERROR', message: 'MENSAGEM DO SERVIDOR' } }, 500) : undefined), groups: TWO_CLIENTS });
    const block = within(await section());
    expect(await block.findByRole('alert')).toBeTruthy();
    expect(block.getByRole('heading', { name: 'Não foi possível carregar o que está parado no cliente', level: 3 })).toBeTruthy();
    expect(block.queryByText('Nada parado no cliente')).toBeNull();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(document.querySelector('.ui-empty-state--failure')).not.toBeNull();

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
  ])('is not on the Início %s, and the list is not even asked for', async (_name, permissions) => {
    const { calls } = await mount({ permissions, groups: TWO_CLIENTS });
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    expect(screen.queryByRole('heading', { name: 'Parado no cliente' })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole('list', { name: SUMMARY })).toBeNull();
  });
});

const SUMMARY = 'Resumo do que espera o cliente';
const cardOf = (label: RegExp): HTMLElement => within(screen.getByRole('list', { name: SUMMARY })).getByText(label).closest('li')!;

describe('the summary cards above the list', () => {
  it('counts what waits for a client and what is past its deadline, each with the way to act on it', async () => {
    const { calls } = await mount({ groups: TWO_CLIENTS });
    expect(await screen.findByRole('list', { name: SUMMARY })).toBeTruthy();
    const waiting = within(cardOf(/^Esperando/));
    expect(waiting.getByText('3')).toBeTruthy();
    expect(waiting.getByText('conteúdos aguardando aprovação')).toBeTruthy();
    expect(waiting.getByRole('link', { name: 'Abrir o calendário' }).getAttribute('href')).toBe(`/agencia/${AGENCY}/conteudos`);
    const late = within(cardOf(/^Atrasados/));
    expect(late.getByText('1')).toBeTruthy();
    expect(late.getByText('o prazo venceu sem resposta')).toBeTruthy();
    expect(late.getByRole('link', { name: 'Abrir o mais atrasado' }).getAttribute('href')).toBe(`/agencia/${AGENCY}/conteudos/${CLINICA}/${cid(1)}?data=2026-10-20`);
    // The cards and the list below share one read.
    expect(calls).toHaveLength(1);
  });

  it('opens the most overdue content of all clients, and carries the state of the carteira', async () => {
    const groups: Group[] = [
      { clientId: CLINICA, clientName: 'Clínica Vida', contents: [item({ id: cid(1), title: 'Há pouco', daysToDue: -1, publishOn: '2026-10-20' })] },
      { clientId: PADARIA, clientName: 'Padaria Trigo Bom', contents: [item({ id: cid(2), title: 'Faz tempo', daysToDue: -9, publishOn: '2026-10-17' }), item({ id: cid(3), title: 'No prazo', daysToDue: 4 })] }
    ];
    const { probe } = await mount({ groups });
    await screen.findByRole('list', { name: SUMMARY });
    expect(within(cardOf(/^Atrasados/)).getByText('2')).toBeTruthy();
    fireEvent.click(within(cardOf(/^Atrasados/)).getByRole('link', { name: 'Abrir o mais atrasado' }));
    await waitFor(() => expect(probe.pathname).toBe(`/agencia/${AGENCY}/conteudos/${PADARIA}/${cid(2)}`));
    expect(probe.search).toBe('?data=2026-10-17');
    expect(probe.state).toEqual(STATE);
  });

  it('shows no card for the late ones when no deadline has passed: a number with nothing to act on is not shown', async () => {
    await mount({ groups: [{ clientId: CLINICA, clientName: 'Clínica Vida', contents: [item({ id: cid(1), title: 'Post', daysToDue: 3 })] }] });
    await screen.findByRole('list', { name: SUMMARY });
    expect(within(cardOf(/^Esperando/)).getByText('conteúdo aguardando aprovação')).toBeTruthy();
    expect(screen.queryByText(/^Atrasados/)).toBeNull();
  });

  it('says it is a floor when the API cut the list', async () => {
    await mount({ groups: TWO_CLIENTS, truncated: true });
    await screen.findByRole('list', { name: SUMMARY });
    expect(within(cardOf(/^Esperando/)).getByText('3+')).toBeTruthy();
  });

  it('shows no card when nothing waits: the good news is the list\'s', async () => {
    await mount({ groups: [] });
    expect(await within(await section()).findByRole('heading', { name: 'Nada parado no cliente', level: 3 })).toBeTruthy();
    expect(screen.queryByRole('list', { name: SUMMARY })).toBeNull();
  });

  it('shows no card when the list did not answer, so a gap is never read as a zero', async () => {
    await mount({ answer: () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500), groups: TWO_CLIENTS });
    expect(await within(await section()).findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('list', { name: SUMMARY })).toBeNull();
  });

  it('shows no card while the list loads', async () => {
    await mount({ answer: () => new Promise<Response>(() => undefined) as unknown as Response });
    expect(document.querySelector('.awaiting-client__skeleton')).not.toBeNull();
    expect(screen.queryByRole('list', { name: SUMMARY })).toBeNull();
  });
});
