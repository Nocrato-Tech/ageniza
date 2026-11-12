// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SubmitContentsBatchRequestSchema } from '@ageniza/contracts';
import { invalidDayMessage } from '@ageniza/ui';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { clientRegistrationExtras } from './client-registration-fixture.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';

/**
 * The batch send of "Enviar vários para aprovação" (scope telas-melhorias, S8): one dialog on the contents of ONE client, the
 * request to the batch route, the cap of 30, and what the screen says when the API refuses all of it.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

/** 01:30Z of the 12th is 22:30 of the 11th in São Paulo: today is the 11th, and a day computed in UTC would be the wrong one. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T01:30:00Z'));
});

const AGENCY = '11111111-1111-4111-8111-111111111111';
const CLIENT = '1a1a1a1a-1111-4111-8111-111111111111';
const OTHER_CLIENT = '2b2b2b2b-2222-4222-8222-222222222222';
const VISUALIZE = 'conteudo.visualizar';
const READ_CLIENTS = 'cliente.visualizar';
const OPERATE = 'conteudo.operar';
const EDITOR = [VISUALIZE, READ_CLIENTS, OPERATE];
const COVER = 'a0a0a0a0-0000-4000-8000-000000000001';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string): Response => json({ error: { code, message: 'MENSAGEM DO SERVIDOR' } }, status);

type Status = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved';

interface Row {
  id: string;
  title: string;
  format: 'image' | 'carousel' | 'reels';
  publishOn: string;
  publishAtTime: string | null;
  status: Status;
  thumbnailAssetId: string | null;
  tasksTotal: number;
  tasksApproved: number;
}

let sequence = 0;
const row = (overrides: Partial<Row> = {}): Row => {
  sequence += 1;
  return {
    id: `c0c0c0c0-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    title: `Conteúdo ${sequence}`,
    format: 'image',
    publishOn: '2026-10-20',
    publishAtTime: null,
    status: 'in_production',
    thumbnailAssetId: COVER,
    tasksTotal: 0,
    tasksApproved: 0,
    ...overrides
  };
};

const listItem = (content: Row) => ({
  id: content.id, title: content.title, platform: 'instagram', format: content.format, publishOn: content.publishOn, publishAtTime: content.publishAtTime,
  status: content.status, owner: { membershipId: '99999999-9999-4999-8999-999999999999', name: 'Ana Souza' }, coverAssetId: null,
  thumbnailAssetId: content.thumbnailAssetId, revision: 1, publishedOn: null, tasksTotal: content.tasksTotal, tasksApproved: content.tasksApproved, approval: null
});

interface Scenario {
  readonly permissions?: readonly string[];
  readonly clientStatus?: 'active' | 'archived';
  readonly rows: Row[];
  /** Answers instead of the fake for the batch route, when it returns a response. */
  readonly batch?: (body: { contentIds: string[]; dueOn?: string; note?: string }, rows: Row[]) => Response | Promise<Response> | undefined;
}

const makeFetch = (scenario: Scenario) => {
  const batches: Array<{ path: string; body: unknown }> = [];
  const periodCalls: string[] = [];
  const permissions = scenario.permissions ?? EDITOR;
  const client = { id: CLIENT, name: 'Padaria Central', photoUrl: null, instagramHandle: 'padariacentral', status: scenario.clientStatus ?? 'active', closingDate: null, threadsAwaitingAgency: 0 };
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    if (path.endsWith('/auth/session')) return json({ user: { id: '99999999-9999-4999-8999-999999999999', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } });
    if (path === `/agencies/${AGENCY}/me`) return json({ agencyId: AGENCY, agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Papel' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions });
    if (path === `/agencies/${AGENCY}/clients` && method === 'GET') return json({ data: [client], meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } });
    if (path === `/agencies/${AGENCY}/clients/${CLIENT}` && method === 'GET') {
      return json({ id: client.id, name: client.name, status: client.status, photoUrl: null, instagramHandle: client.instagramHandle, legalName: null, taxId: null, segment: null, website: null, contactName: null, contactPhone: null, contactEmail: null, closingDate: null, archivedAt: null, ...clientRegistrationExtras, summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 0 } });
    }
    if (path === `/agencies/${AGENCY}/clients/${CLIENT}/contents` && method === 'GET') {
      periodCalls.push(url.search);
      const from = url.searchParams.get('from')!;
      const to = url.searchParams.get('to')!;
      const found = scenario.rows.filter((content) => content.publishOn >= from && content.publishOn <= to);
      return json({ data: { contents: found.map(listItem), storyScripts: [] }, meta: { from, to, count: found.length } });
    }
    if (path === `/agencies/${AGENCY}/clients/${CLIENT}/contents/feed`) {
      return json({ data: { contents: [], nextCursor: null, counters: { posts: 0, approved: 0, awaitingApproval: 0 } }, meta: { count: 0 } });
    }
    if (/\/media\/[^/]+\/download-url$/.test(path)) return json({ url: 'https://storage.test/cover.jpg', expiresAt: '2026-10-12T01:45:00.000Z' });
    if (path === `/agencies/${AGENCY}/clients/${CLIENT}/contents/submit` && method === 'POST') {
      const body: unknown = JSON.parse(String(init?.body));
      batches.push({ path, body });
      const parsed = SubmitContentsBatchRequestSchema.safeParse(body);
      if (!parsed.success) return failure(400, 'VALIDATION_ERROR');
      const custom = scenario.batch?.(parsed.data, scenario.rows);
      if (custom !== undefined) return custom;
      const sent = scenario.rows.filter((content) => parsed.data.contentIds.includes(content.id));
      for (const content of sent) content.status = 'awaiting_approval';
      return json({ data: { batchId: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e', contents: sent.map(listItem) } });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, batches, periodCalls };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

const mount = async (scenario: Scenario) => {
  const fake = makeFetch(scenario);
  const client = new HttpClient('http://127.0.0.1:3001', fake.impl, { onSessionEnded: () => undefined });
  const store = createAuthSessionStore(client);
  render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={[`/agencia/${AGENCY}/conteudos/${CLIENT}`]}>
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  await waitFor(() => expect(document.querySelector('.content-calendar')).not.toBeNull());
  return fake;
};

const OPEN = 'Enviar vários para aprovação';
const batchDialog = (): HTMLElement => screen.getByRole('dialog', { name: 'Enviar conteúdos para aprovação' });
const openBatch = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole('button', { name: OPEN }));
  return batchDialog();
};
const box = (name: string | RegExp): HTMLInputElement => within(batchDialog()).getByRole('checkbox', { name }) as HTMLInputElement;
const send = (name: string | RegExp = /^Enviar( \d+)? para aprovação$/): void => { fireEvent.click(within(batchDialog()).getByRole('button', { name })); };

describe('the entry point', () => {
  it('shows "Enviar vários para aprovação" to who operates, when there is a content that can start a send', async () => {
    await mount({ rows: [row({ title: 'Reels da semana' })] });
    expect(await screen.findByRole('button', { name: OPEN })).toBeTruthy();
  });

  it.each([
    ['who cannot operate', { permissions: [VISUALIZE, READ_CLIENTS], rows: [row()] }],
    ['a period where every content already waits', { rows: [row({ status: 'awaiting_approval' }), row({ status: 'approved' })] }],
    ['an archived client', { clientStatus: 'archived' as const, rows: [row()] }]
  ])('does not show it for %s', async (_name, scenario) => {
    await mount(scenario);
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    expect(screen.queryByRole('button', { name: OPEN })).toBeNull();
  });
});

describe('the dialog', () => {
  it('lists what can start a send, with its format and day, and leaves out what already waits', async () => {
    await mount({
      rows: [
        row({ title: 'Bastidores da recepção', format: 'reels', publishOn: '2026-10-20', publishAtTime: '18:30' }),
        row({ title: 'Em ajuste ainda', status: 'adjusting', publishOn: '2026-10-21' }),
        row({ title: 'Já está com o cliente', status: 'awaiting_approval' })
      ]
    });
    await openBatch();
    expect(box(/Bastidores da recepção/).checked).toBe(false);
    expect(within(batchDialog()).getByText('Reels')).toBeTruthy();
    expect(within(batchDialog()).getByText('ter, 20/10 · 18:30')).toBeTruthy();
    expect(box(/Em ajuste ainda/)).toBeTruthy();
    expect(within(batchDialog()).queryByText('Já está com o cliente')).toBeNull();
    expect(within(batchDialog()).getByText(/Escolha os conteúdos do mês/)).toBeTruthy();
  });

  it('holds what cannot go yet, and says why: no media, subtasks open', async () => {
    await mount({
      rows: [
        row({ title: 'Sem mídia', thumbnailAssetId: null }),
        row({ title: 'Duas subtarefas abertas', tasksTotal: 3, tasksApproved: 1 }),
        row({ title: 'Uma subtarefa aberta', tasksTotal: 2, tasksApproved: 1 }),
        row({ title: 'Pronto' })
      ]
    });
    await openBatch();
    expect(box(/Sem mídia/).disabled).toBe(true);
    expect(within(batchDialog()).getByText('Falta a mídia do post.')).toBeTruthy();
    expect(box(/Duas subtarefas abertas/).disabled).toBe(true);
    expect(within(batchDialog()).getByText('Faltam aprovar 2 subtarefas.')).toBeTruthy();
    expect(box(/Uma subtarefa aberta/).disabled).toBe(true);
    expect(within(batchDialog()).getByText('Falta aprovar 1 subtarefa.')).toBeTruthy();
    expect(box(/Pronto/).disabled).toBe(false);
  });

  it('counts the chosen ones on the button, and sends nothing while none is chosen', async () => {
    const { batches } = await mount({ rows: [row({ title: 'Um' }), row({ title: 'Dois' })] });
    await openBatch();
    expect(within(batchDialog()).getByRole('button', { name: 'Enviar para aprovação' })).toBeTruthy();
    send();
    expect(await within(batchDialog()).findByText('Escolha ao menos um conteúdo.')).toBeTruthy();
    expect(batches).toHaveLength(0);
    fireEvent.click(box(/Um/));
    expect(within(batchDialog()).getByRole('button', { name: 'Enviar 1 para aprovação' })).toBeTruthy();
    fireEvent.click(box(/Dois/));
    expect(within(batchDialog()).getByRole('button', { name: 'Enviar 2 para aprovação' })).toBeTruthy();
  });

  it('"Marcar todos" marks only what can go, and "Desmarcar todos" clears them', async () => {
    await mount({ rows: [row({ title: 'Um' }), row({ title: 'Dois' }), row({ title: 'Sem mídia', thumbnailAssetId: null })] });
    await openBatch();
    fireEvent.click(within(batchDialog()).getByRole('button', { name: 'Marcar todos' }));
    expect(box(/Um/).checked && box(/Dois/).checked).toBe(true);
    expect(box(/Sem mídia/).checked).toBe(false);
    fireEvent.click(within(batchDialog()).getByRole('button', { name: 'Desmarcar todos' }));
    expect(box(/Um/).checked || box(/Dois/).checked).toBe(false);
  });
});

describe('the send', () => {
  it('sends the chosen contents, and only them, to the batch route with the deadline and the note', async () => {
    const rows = [row({ title: 'Primeiro' }), row({ title: 'Segundo' }), row({ title: 'Terceiro' })];
    const { batches, periodCalls } = await mount({ rows });
    await openBatch();
    fireEvent.click(box(/Primeiro/));
    fireEvent.click(box(/Terceiro/));
    fireEvent.change(within(batchDialog()).getByLabelText('Aprovar até'), { target: { value: '14/10/2026' } });
    fireEvent.change(within(batchDialog()).getByLabelText('Recado para o cliente'), { target: { value: ' Confira a legenda. ' } });
    const before = periodCalls.length;
    send('Enviar 2 para aprovação');

    expect(await screen.findByText('2 conteúdos enviados para aprovação.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(batches).toEqual([{
      path: `/agencies/${AGENCY}/clients/${CLIENT}/contents/submit`,
      body: { contentIds: [rows[0]!.id, rows[2]!.id], dueOn: '2026-10-14', note: 'Confira a legenda.' }
    }]);
    expect(rows.map((content) => content.status)).toEqual(['awaiting_approval', 'in_production', 'awaiting_approval']);
    await waitFor(() => expect(periodCalls.length).toBeGreaterThan(before));
  });

  it('sends no deadline and no note when none was given, and says "1 conteúdo" in the singular', async () => {
    const rows = [row({ title: 'Único' })];
    const { batches } = await mount({ rows });
    await openBatch();
    fireEvent.click(box(/Único/));
    send('Enviar 1 para aprovação');
    expect(await screen.findByText('1 conteúdo enviado para aprovação.')).toBeTruthy();
    expect(batches[0]!.body).toEqual({ contentIds: [rows[0]!.id] });
  });

  it('is of one client: the ids are the ones the screen of that client lists', async () => {
    const rows = [row({ title: 'Do cliente' })];
    const { batches } = await mount({ rows });
    await openBatch();
    fireEvent.click(box(/Do cliente/));
    send('Enviar 1 para aprovação');
    await screen.findByText('1 conteúdo enviado para aprovação.');
    expect(batches[0]!.path).toContain(CLIENT);
    expect(batches[0]!.path).not.toContain(OTHER_CLIENT);
  });

  it('refuses a deadline out of the range on the field, before any request', async () => {
    const { batches } = await mount({ rows: [row({ title: 'Um' })] });
    await openBatch();
    fireEvent.click(box(/Um/));
    fireEvent.change(within(batchDialog()).getByLabelText('Aprovar até'), { target: { value: '10/10/2026' } });
    send('Enviar 1 para aprovação');
    expect(await within(batchDialog()).findByText('Escolha um dia de hoje até 90 dias à frente.')).toBeTruthy();
    expect(batches).toHaveLength(0);
  });

  it.each([
    ['a year of two digits', '14/10/26'],
    ['a day that does not exist', '31/02/2026'],
    ['half a date', '14/10']
  ])('refuses %s as "Data inválida" on the field, sends nothing and keeps the dialog open with what was typed', async (_name, typed) => {
    const { batches } = await mount({ rows: [row({ title: 'Um' })] });
    await openBatch();
    fireEvent.click(box(/Um/));
    fireEvent.change(within(batchDialog()).getByLabelText('Aprovar até'), { target: { value: typed } });
    fireEvent.change(within(batchDialog()).getByLabelText('Recado para o cliente'), { target: { value: 'Até sábado.' } });
    send('Enviar 1 para aprovação');
    expect(await within(batchDialog()).findByText(invalidDayMessage)).toBeTruthy();
    expect(within(batchDialog()).getByLabelText('Aprovar até').getAttribute('aria-invalid')).toBe('true');
    expect((within(batchDialog()).getByLabelText('Aprovar até') as HTMLInputElement).value).toBe(typed);
    expect((within(batchDialog()).getByLabelText('Recado para o cliente') as HTMLTextAreaElement).value).toBe('Até sábado.');
    expect(box(/Um/).checked).toBe(true);
    expect(batches).toHaveLength(0);
  });

  it('still sends no dueOn when the field was typed into and then emptied', async () => {
    const { batches } = await mount({ rows: [row({ title: 'Um' })] });
    await openBatch();
    fireEvent.click(box(/Um/));
    fireEvent.change(within(batchDialog()).getByLabelText('Aprovar até'), { target: { value: '14/10/26' } });
    fireEvent.change(within(batchDialog()).getByLabelText('Aprovar até'), { target: { value: '' } });
    send('Enviar 1 para aprovação');
    await waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0]!.body).toEqual({ contentIds: expect.any(Array) });
  });

  it.each([
    ['X', () => { fireEvent.click(within(batchDialog()).getByRole('button', { name: 'Fechar envio para aprovação' })); }],
    ['Esc', () => { fireEvent(batchDialog(), new Event('cancel', { bubbles: true, cancelable: true })); }]
  ])('asks before %s discards a deadline that was only half typed, with nothing else chosen', async (_name, close) => {
    await mount({ rows: [row({ title: 'Um' })] });
    await openBatch();
    fireEvent.change(within(batchDialog()).getByLabelText('Aprovar até'), { target: { value: '14/10' } });
    close();
    expect(await screen.findByRole('dialog', { name: 'Descartar o que você escreveu?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar editando' }));
    expect((within(batchDialog()).getByLabelText('Aprovar até') as HTMLInputElement).value).toBe('14/10');
  });

  it('asks before it closes with something chosen, and closes at once with nothing', async () => {
    await mount({ rows: [row({ title: 'Um' })] });
    await openBatch();
    fireEvent.click(within(batchDialog()).getByRole('button', { name: 'Fechar envio para aprovação' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await openBatch();
    fireEvent.click(box(/Um/));
    fireEvent.click(within(batchDialog()).getByRole('button', { name: 'Fechar envio para aprovação' }));
    expect(await screen.findByRole('dialog', { name: 'Descartar o que você escreveu?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Continuar editando' }));
    expect(box(/Um/).checked).toBe(true);
  });
});

describe('the cap of 30', () => {
  const many = (count: number): Row[] => Array.from({ length: count }, (_value, index) => row({
    title: `Post ${String(index + 1).padStart(2, '0')}`,
    publishOn: `2026-10-${String((index % 28) + 1).padStart(2, '0')}`
  }));

  it('marks at most 30, blocks the 31st with the reason, and frees it when one is unmarked', async () => {
    const rows = many(31);
    const { batches } = await mount({ rows });
    await openBatch();
    fireEvent.click(within(batchDialog()).getByRole('button', { name: 'Marcar os primeiros 30' }));
    expect(within(batchDialog()).getByRole('button', { name: 'Enviar 30 para aprovação' })).toBeTruthy();
    expect(within(batchDialog()).getByText('Um envio leva até 30 conteúdos.')).toBeTruthy();
    expect(box(/Post 31/).disabled).toBe(true);
    expect(box(/Post 30/).checked).toBe(true);

    fireEvent.click(box(/Post 01/));
    expect(box(/Post 31/).disabled).toBe(false);
    fireEvent.click(box(/Post 31/));
    expect(within(batchDialog()).getByRole('button', { name: 'Enviar 30 para aprovação' })).toBeTruthy();
    send('Enviar 30 para aprovação');
    await screen.findByText('30 conteúdos enviados para aprovação.');
    const sent = (batches[0]!.body as { contentIds: string[] }).contentIds;
    expect(sent).toHaveLength(30);
    expect(sent).not.toContain(rows[0]!.id);
    expect(sent).toContain(rows[30]!.id);
  });

  it('with exactly 30 there is nothing to cut, and "Marcar todos" says so', async () => {
    await mount({ rows: many(30) });
    await openBatch();
    expect(within(batchDialog()).queryByRole('button', { name: /Marcar os primeiros/ })).toBeNull();
    fireEvent.click(within(batchDialog()).getByRole('button', { name: 'Marcar todos' }));
    expect(within(batchDialog()).getByRole('button', { name: 'Enviar 30 para aprovação' })).toBeTruthy();
  });
});

describe('what the API refuses', () => {
  it('all or nothing: says nothing was sent, keeps what was typed, and shows which content left the batch', async () => {
    const rows = [row({ title: 'Primeiro' }), row({ title: 'Segundo' })];
    const { batches, periodCalls } = await mount({
      rows,
      batch: (_body, all) => {
        // Another operator sent the second one in the meantime: the whole batch is refused.
        all[1]!.status = 'awaiting_approval';
        return failure(409, 'CONTENT_STATE');
      }
    });
    await openBatch();
    fireEvent.click(box(/Primeiro/));
    fireEvent.click(box(/Segundo/));
    fireEvent.change(within(batchDialog()).getByLabelText('Recado para o cliente'), { target: { value: 'Até sexta.' } });
    const before = periodCalls.length;
    send('Enviar 2 para aprovação');

    expect(await within(batchDialog()).findByText('Algum dos conteúdos já não está em produção nem em ajuste. Nenhum conteúdo foi enviado: confira a lista abaixo.')).toBeTruthy();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(batches).toHaveLength(1);
    expect((within(batchDialog()).getByLabelText('Recado para o cliente') as HTMLTextAreaElement).value).toBe('Até sexta.');
    await waitFor(() => expect(periodCalls.length).toBeGreaterThan(before));
    // The list is read again: the one that changed says why it cannot go, and the other stays chosen.
    expect(await within(batchDialog()).findByText('Já aguarda aprovação.')).toBeTruthy();
    expect(box(/Segundo/).disabled).toBe(true);
    expect(box(/Segundo/).checked).toBe(false);
    expect(box(/Primeiro/).checked).toBe(true);
    expect(within(batchDialog()).getByRole('button', { name: 'Enviar 1 para aprovação' })).toBeTruthy();
  });

  it.each([
    [409, 'CONTENT_TASKS_NOT_APPROVED', 'Todas as subtarefas precisam estar aprovadas antes do envio. Nenhum conteúdo foi enviado.'],
    [409, 'CONTENT_MEDIA_INCOMPLETE', 'A mídia ou a capa não está completa para este formato: falta mídia, ou a mídia ou a capa saiu da pasta. Nenhum conteúdo foi enviado.'],
    [404, 'NOT_FOUND', 'Algum dos conteúdos não existe mais. Nenhum conteúdo foi enviado: confira a lista abaixo.'],
    [409, 'TRY_AGAIN', 'Outra alteração aconteceu ao mesmo tempo. Tente de novo.'],
    [409, 'CLIENT_ARCHIVED', 'Este cliente está arquivado: o conteúdo é só leitura.'],
    [403, 'FORBIDDEN', 'Você não tem permissão para esta ação.'],
    [500, 'INTERNAL', 'Não foi possível enviar os conteúdos para aprovação. Tente de novo.']
  ])('says %s %s in its own words and keeps the dialog open', async (status, code, text) => {
    const rows = [row({ title: 'Um' })];
    await mount({ rows, batch: () => failure(status, code) });
    await openBatch();
    fireEvent.click(box(/Um/));
    send('Enviar 1 para aprovação');
    expect(await within(batchDialog()).findByText(text)).toBeTruthy();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(box(/Um/).checked).toBe(true);
  });

  it.each([
    ['CONTENT_APPROVAL_DUE_INVALID', 'O prazo vai de hoje até 90 dias à frente. Escolha outro dia.'],
    ['CONTENT_APPROVAL_NOTE_INVALID', 'O recado tem até 500 caracteres e não pode ter caracteres especiais. Deixe em branco para enviar sem recado.']
  ])('puts %s on its own field', async (code, text) => {
    await mount({ rows: [row({ title: 'Um' })], batch: () => failure(400, code) });
    await openBatch();
    fireEvent.click(box(/Um/));
    send('Enviar 1 para aprovação');
    expect(await within(batchDialog()).findByText(text)).toBeTruthy();
    expect(batchDialog().querySelectorAll('[aria-invalid="true"]')).toHaveLength(1);
  });

  it('is ready for the next try: the second send goes through and closes the dialog', async () => {
    let refusing = true;
    const rows = [row({ title: 'Um' })];
    const { batches } = await mount({ rows, batch: () => (refusing ? failure(409, 'TRY_AGAIN') : undefined) });
    await openBatch();
    fireEvent.click(box(/Um/));
    send('Enviar 1 para aprovação');
    await within(batchDialog()).findByText('Outra alteração aconteceu ao mesmo tempo. Tente de novo.');
    refusing = false;
    send('Enviar 1 para aprovação');
    await screen.findByText('1 conteúdo enviado para aprovação.');
    expect(batches).toHaveLength(2);
    expect(rows[0]!.status).toBe('awaiting_approval');
  });
});
