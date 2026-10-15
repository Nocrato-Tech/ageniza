// @vitest-environment jsdom
import { randomUUID } from 'node:crypto';

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreateStoryScriptRequestSchema, UpdateStoryScriptRequestSchema } from '@ageniza/contracts';

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
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T01:30:00Z'));
});

const AGENCY = '11111111-1111-4111-8111-111111111111';
const sessionBody = { user: { id: '99999999-9999-4999-8999-999999999999', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);

const VISUALIZE = 'conteudo.visualizar';
const OPERATE = 'conteudo.operar';
const READ_CLIENTS = 'cliente.visualizar';

const client = (id: string, name: string, status: 'active' | 'archived' = 'active') =>
  ({ id, name, photoUrl: null, instagramHandle: null, status, closingDate: null, threadsAwaitingAgency: 0 });
const padaria = client('1a1a1a1a-1111-4111-8111-111111111111', 'Padaria Central');
const academia = client('2b2b2b2b-2222-4222-8222-222222222222', 'Academia Corpo');
const barbearia = client('3c3c3c3c-3333-4333-8333-333333333333', 'Barbearia Lima', 'archived');
const ROSTER = [padaria, academia, barbearia];

const detailOf = (row: ReturnType<typeof client>) => ({
  id: row.id, name: row.name, status: row.status, photoUrl: row.photoUrl, instagramHandle: row.instagramHandle, closingDate: row.closingDate,
  legalName: null, taxId: null, segment: null, website: null, contactName: null, contactPhone: null, contactEmail: null,
  archivedAt: row.status === 'archived' ? '2026-10-01T00:00:00.000Z' : null,
  summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 0 }
});

interface Scene { id: string; position: number; text: string; guidance: string | null }
interface Script { id: string; clientId: string; scriptOn: string; status: 'draft' | 'sent' | 'recorded'; scenes: Scene[] }

const scriptOf = (clientId: string, overrides: Partial<Script> & { texts?: readonly string[] } = {}): Script => {
  const texts = overrides.texts ?? ['Abrir a loja', 'Mostrar a vitrine'];
  return {
    id: randomUUID(),
    clientId,
    scriptOn: '2026-10-20',
    status: 'draft',
    scenes: texts.map((text, index) => ({ id: randomUUID(), position: index + 1, text, guidance: index === 0 ? 'Filmar na vertical' : null })),
    ...overrides
  };
};

const shown = (script: Script) => ({
  id: script.id, scriptOn: script.scriptOn, status: script.status,
  scenes: [...script.scenes].sort((a, b) => a.position - b.position), recordedBy: null, recordedAt: null, createdAt: '2026-10-11T12:00:00.000Z'
});

interface Call { readonly method: string; readonly path: string; readonly body: unknown }

interface Scenario {
  readonly permissions?: readonly string[];
  readonly scripts?: readonly Script[];
  /** Answers instead of the fake for a request, when it returns a response. */
  readonly override?: (call: Call, calls: readonly Call[]) => Response | Promise<Response> | undefined;
}

/**
 * Behaves like the real API: 403 without the permission (a write needs `conteudo.operar` AND `conteudo.visualizar`),
 * 400 by the contract's own schemas, 404 for a script that is not the client's, 409 for a script that is no draft or
 * a list of scenes that is not the script's. Positions come from the order of the list it receives, never from the test.
 */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: Call[] = [];
  const store = [...(scenario.scripts ?? [])];
  const permissions = scenario.permissions ?? [VISUALIZE, OPERATE, READ_CLIENTS];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    const call: Call = { method, path: `${url.pathname}${url.search}`, body };
    calls.push(call);
    const custom = await scenario.override?.(call, calls);
    if (custom !== undefined) return custom;

    if (url.pathname.endsWith('/auth/session')) return json(sessionBody);
    if (/\/agencies\/[^/]+\/me$/.test(url.pathname)) {
      return json({ agencyId: AGENCY, agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Papel' }, permissions });
    }
    const list = /\/agencies\/[^/]+\/clients$/.exec(url.pathname);
    if (list !== null) {
      const rows = ROSTER.filter((row) => row.status === 'active');
      return json({ data: rows, meta: { page: 1, pageSize: 100, totalItems: rows.length, totalPages: 1 } });
    }
    const period = /\/agencies\/[^/]+\/clients\/([^/]+)\/contents$/.exec(url.pathname);
    if (period !== null) {
      if (!permissions.includes(VISUALIZE)) return failure(403, 'FORBIDDEN', 'Forbidden');
      const from = url.searchParams.get('from')!;
      const to = url.searchParams.get('to')!;
      const scripts = store
        .filter((script) => script.clientId === period[1] && script.scriptOn >= from && script.scriptOn <= to)
        .map((script) => ({ id: script.id, scriptOn: script.scriptOn, status: script.status }));
      return json({ data: { contents: [], storyScripts: scripts }, meta: { from, to, count: scripts.length } });
    }
    const detail = /\/agencies\/[^/]+\/clients\/([^/]+)$/.exec(url.pathname);
    if (detail !== null) {
      const row = ROSTER.find((candidate) => candidate.id === detail[1]);
      return row === undefined ? failure(404, 'NOT_FOUND', 'Client not found.') : json(detailOf(row));
    }

    const scripts = /\/agencies\/[^/]+\/clients\/([^/]+)\/story-scripts(?:\/([^/]+))?(\/send)?$/.exec(url.pathname);
    if (scripts !== null) {
      const clientId = scripts[1]!;
      const row = ROSTER.find((candidate) => candidate.id === clientId);
      const write = method !== 'GET';
      if (!permissions.includes(VISUALIZE) || (write && !permissions.includes(OPERATE))) return failure(403, 'FORBIDDEN', 'Forbidden');
      if (row === undefined) return failure(404, 'NOT_FOUND', 'Client not found.');
      const found = scripts[2] === undefined ? undefined : store.find((script) => script.id === scripts[2] && script.clientId === clientId);
      if (scripts[2] !== undefined && found === undefined) return failure(404, 'NOT_FOUND', 'Story script not found.');
      if (write && row.status === 'archived') return failure(409, 'CLIENT_ARCHIVED', 'Cliente arquivado não pode ser editado.');

      if (method === 'GET' && found !== undefined) return json(shown(found));
      if (method === 'POST' && scripts[2] === undefined) {
        const parsed = CreateStoryScriptRequestSchema.safeParse(body);
        if (!parsed.success) return failure(400, 'VALIDATION_ERROR', 'Request validation failed');
        const created: Script = {
          id: randomUUID(), clientId, scriptOn: parsed.data.scriptOn, status: 'draft',
          scenes: parsed.data.scenes.map((scene, index) => ({ id: randomUUID(), position: index + 1, text: scene.text, guidance: scene.guidance }))
        };
        store.push(created);
        return json(shown(created), 201);
      }
      if (method === 'PATCH' && found !== undefined) {
        const parsed = UpdateStoryScriptRequestSchema.safeParse(body);
        if (!parsed.success) return failure(400, 'VALIDATION_ERROR', 'Request validation failed');
        if (found.status !== 'draft') return failure(409, 'STORY_SCRIPT_STATE', 'Roteiro já enviado não é editado.');
        if (parsed.data.scenes !== undefined) {
          const given = parsed.data.scenes.flatMap((scene) => (scene.id === undefined ? [] : [scene.id]));
          const have = found.scenes.map((scene) => scene.id);
          if (given.some((id) => !have.includes(id)) || have.some((id) => !given.includes(id))) return failure(409, 'STORY_SCENES_MISMATCH', 'O roteiro mudou.');
          found.scenes = parsed.data.scenes.map((scene, index) => ({ id: scene.id ?? randomUUID(), position: index + 1, text: scene.text, guidance: scene.guidance }));
        }
        if (parsed.data.scriptOn !== undefined) found.scriptOn = parsed.data.scriptOn;
        return json(shown(found));
      }
      if (method === 'POST' && scripts[3] !== undefined && found !== undefined) {
        if (found.status === 'recorded') return failure(409, 'STORY_SCRIPT_STATE', 'Só um roteiro em rascunho é enviado.');
        found.status = 'sent';
        return json(shown(found));
      }
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls, store };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface Probe { navigate: NavigateFunction }

function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((_location, navigate) => { probe.navigate = navigate; });
  return null;
}

const render_ = (impl: typeof fetch, clientId = padaria.id) => {
  const probe: Probe = { navigate: () => undefined };
  const sessionEnd = createSessionEndSignal();
  const http = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const store = createAuthSessionStore(http);
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={http}>
          <MemoryRouter initialEntries={[`/agencia/${AGENCY}/conteudos/${clientId}`]}>
            <SessionEndRedirect signal={sessionEnd} authStore={store} />
            <LocationProbe probe={probe} />
            <Harness store={store} />
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </AuthSessionProvider>
  );
  return { ...rendered, probe };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const dayCell = (day: string): HTMLElement => {
  const cell = document.querySelector(`time[datetime="${day}"]`)?.closest('li');
  if (cell === null || cell === undefined) throw new Error(`The day ${day} was not rendered.`);
  return cell;
};
const calendarReady = (): Promise<HTMLElement> => waitFor(() => {
  const calendar = document.querySelector<HTMLElement>('.content-calendar');
  if (calendar === null) throw new Error('The calendar has not rendered yet.');
  return calendar;
});
const plusOf = (day: string): HTMLElement => within(dayCell(day)).getByRole('button', { name: /^Adicionar no dia/ });
const scriptMarks = (day: string): string[] => within(dayCell(day)).queryAllByRole('button', { name: /^Stories/ }).map((button) => button.textContent ?? '');
const dialog = (): HTMLElement => screen.getByRole('dialog');
const writes = (calls: readonly Call[]): string[] => calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path.replace(`/agencies/${AGENCY}/clients/${padaria.id}/story-scripts`, '')}`);
const periodCalls = (calls: readonly Call[]): Call[] => calls.filter((call) => /\/contents\?/.test(call.path));
const typeInto = (label: string, value: string): void => { fireEvent.change(within(dialog()).getByLabelText(label), { target: { value } }); };
const textsOnScreen = (): string[] => within(dialog()).getAllByLabelText(/^Texto da cena/).map((field) => (field as HTMLTextAreaElement).value);

const openNewScriptOn = async (day: string): Promise<void> => {
  await calendarReady();
  fireEvent.click(plusOf(day));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Roteiro de stories' }));
  await screen.findByRole('dialog', { name: 'Novo roteiro de stories' });
};

const openScript = async (day: string): Promise<void> => {
  await calendarReady();
  fireEvent.click(within(dayCell(day)).getByRole('button', { name: /^Stories/ }));
};

describe('the + of the day and the mark of a script', () => {
  it('offers the + to whoever has conteudo.operar, with "Conteúdo" and "Roteiro de stories" as its options', async () => {
    const { impl } = makeFetch({ permissions: [VISUALIZE, OPERATE, READ_CLIENTS] });
    render_(impl);
    await calendarReady();

    expect(document.querySelectorAll('.content-day').length).toBeGreaterThan(28);
    expect(screen.getAllByRole('button', { name: /^Adicionar no dia/ })).toHaveLength(document.querySelectorAll('.content-day').length);
    fireEvent.click(plusOf('2026-10-20'));
    const items = within(await screen.findByRole('menu', { name: 'Adicionar ao dia' })).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Conteúdo', 'Roteiro de stories']);
  });

  it('draws no + without conteudo.operar, and the stories mark stays', async () => {
    const script = scriptOf(padaria.id);
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS], scripts: [script] });
    render_(impl);
    await calendarReady();

    expect(screen.queryAllByRole('button', { name: /^Adicionar no dia/ })).toHaveLength(0);
    expect(scriptMarks('2026-10-20')).toEqual(['Stories · Rascunho']);
  });

  it('draws no + on an archived client, whose scripts still open', async () => {
    const script = scriptOf(barbearia.id, { status: 'sent' });
    const { impl } = makeFetch({ scripts: [script] });
    render_(impl, barbearia.id);
    await calendarReady();

    expect(screen.queryAllByRole('button', { name: /^Adicionar no dia/ })).toHaveLength(0);
    expect(scriptMarks('2026-10-20')).toEqual(['Stories · Enviado']);
  });

  it('marks each day with its own scripts and their state, and no other day or client', async () => {
    const { impl } = makeFetch({
      scripts: [
        scriptOf(padaria.id, { scriptOn: '2026-10-20', status: 'draft' }),
        scriptOf(padaria.id, { scriptOn: '2026-10-22', status: 'sent' }),
        scriptOf(padaria.id, { scriptOn: '2026-10-22', status: 'recorded' }),
        scriptOf(academia.id, { scriptOn: '2026-10-21', status: 'draft' })
      ]
    });
    render_(impl);
    await calendarReady();

    expect(scriptMarks('2026-10-20')).toEqual(['Stories · Rascunho']);
    expect(scriptMarks('2026-10-22')).toEqual(['Stories · Enviado', 'Stories · Gravado']);
    expect(scriptMarks('2026-10-21')).toEqual([]);
    expect(document.querySelectorAll('.content-day__script')).toHaveLength(3);
  });
});

describe('creating a script', () => {
  it('opens on the chosen day, saves the draft with the scenes in the order typed, closes, and marks the day', async () => {
    const { impl, calls } = makeFetch();
    render_(impl);
    await openNewScriptOn('2026-10-20');

    expect((within(dialog()).getByLabelText('Dia dos stories') as HTMLInputElement).value).toBe('2026-10-20');
    typeInto('Texto da cena 1', 'Abrir a loja');
    typeInto('Orientação da cena 1', 'Filmar na vertical');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Adicionar cena' }));
    typeInto('Texto da cena 2', 'Mostrar a vitrine');
    const before = periodCalls(calls).length;
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const create = calls.find((call) => call.method === 'POST')!;
    expect(create.path).toBe(`/agencies/${AGENCY}/clients/${padaria.id}/story-scripts`);
    expect(create.body).toEqual({
      scriptOn: '2026-10-20',
      scenes: [{ text: 'Abrir a loja', guidance: 'Filmar na vertical' }, { text: 'Mostrar a vitrine', guidance: '' }]
    });
    await waitFor(() => expect(periodCalls(calls).length).toBeGreaterThan(before));
    await waitFor(() => expect(scriptMarks('2026-10-20')).toEqual(['Stories · Rascunho']));
  });

  it('keeps everything typed when the save fails, says it in its own words and never shows the server\'s text', async () => {
    let attempts = 0;
    const { impl, calls } = makeFetch({
      override: (call) => {
        if (call.method === 'POST' && ++attempts === 1) return failure(500, 'INTERNAL_ERROR', 'Boom <b>do servidor</b>');
        return undefined;
      }
    });
    render_(impl);
    await openNewScriptOn('2026-10-20');
    typeInto('Texto da cena 1', 'Texto que não pode sumir');
    typeInto('Orientação da cena 1', 'Orientação que não pode sumir');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));

    expect(await within(dialog()).findByText('Não foi possível salvar o roteiro. Tente de novo.')).toBeTruthy();
    expect(dialog().textContent).not.toContain('Boom');
    expect((within(dialog()).getByLabelText('Texto da cena 1') as HTMLTextAreaElement).value).toBe('Texto que não pode sumir');
    expect((within(dialog()).getByLabelText('Orientação da cena 1') as HTMLTextAreaElement).value).toBe('Orientação que não pode sumir');

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(calls)).toEqual(['POST ', 'POST ']);
  });

  it.each([
    [409, 'CLIENT_ARCHIVED', 'Este cliente está arquivado: o roteiro é só leitura.'],
    [403, 'FORBIDDEN', 'Você não tem permissão para alterar roteiros.'],
    [400, 'VALIDATION_ERROR', 'Revise os dados do roteiro.']
  ])('answers a %i %s with its own sentence and keeps the modal and the text', async (status, code, sentence) => {
    const { impl } = makeFetch({ override: (call) => (call.method === 'POST' ? failure(status, code, 'Texto do servidor <i>x</i>') : undefined) });
    render_(impl);
    await openNewScriptOn('2026-10-20');
    typeInto('Texto da cena 1', 'Fica');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));

    expect(await within(dialog()).findByText(sentence)).toBeTruthy();
    expect(dialog().textContent).not.toContain('Texto do servidor');
    expect((within(dialog()).getByLabelText('Texto da cena 1') as HTMLTextAreaElement).value).toBe('Fica');
  });

  it('asks for the text before calling the server, and refuses an invisible character, per scene', async () => {
    const { impl, calls } = makeFetch();
    render_(impl);
    await openNewScriptOn('2026-10-20');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Adicionar cena' }));
    typeInto('Texto da cena 1', '   ');
    typeInto('Texto da cena 2', `Olá${String.fromCodePoint(0x200b)}mundo`);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));

    expect(await within(dialog()).findByText('Escreva o texto da cena.')).toBeTruthy();
    expect(within(dialog()).getByText('O texto da cena tem caracteres invisíveis ou de controle.')).toBeTruthy();
    expect(within(dialog()).getByLabelText('Texto da cena 1').getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog()).getByLabelText('Texto da cena 2').getAttribute('aria-invalid')).toBe('true');
    expect(writes(calls)).toEqual([]);
  });

  it('stops at 30 scenes and bounds the fields to the API\'s own limits', async () => {
    const { impl } = makeFetch();
    render_(impl);
    await openNewScriptOn('2026-10-20');
    const add = within(dialog()).getByRole('button', { name: 'Adicionar cena' });
    for (let count = 1; count < 30; count += 1) fireEvent.click(add);

    expect(within(dialog()).getAllByLabelText(/^Texto da cena/)).toHaveLength(30);
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog()).getByText('Um roteiro tem no máximo 30 cenas.')).toBeTruthy();
    expect(within(dialog()).getByLabelText('Texto da cena 1').getAttribute('maxlength')).toBe('2000');
    expect(within(dialog()).getByLabelText('Orientação da cena 1').getAttribute('maxlength')).toBe('1000');
  });

  it('does not close while the write is on its way, and closes by itself when it succeeds', async () => {
    const answer = deferred<Response>();
    const { impl } = makeFetch({ override: (call) => (call.method === 'POST' ? answer.promise : undefined) });
    render_(impl);
    await openNewScriptOn('2026-10-20');
    typeInto('Texto da cena 1', 'Cena');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));
    await waitFor(() => expect((within(dialog()).getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement).disabled).toBe(true));

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Fechar roteiro de stories' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();

    await act(async () => { answer.resolve(json({ id: randomUUID(), scriptOn: '2026-10-20', status: 'draft', scenes: [], recordedBy: null, recordedAt: null, createdAt: '2026-10-11T12:00:00.000Z' }, 201)); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('opening, editing and reordering', () => {
  it('reads the script by its route, shows the scenes in the order of their positions, and writes the whole list with ids', async () => {
    const script = scriptOf(padaria.id, { texts: ['Primeira', 'Segunda'] });
    const { impl, calls } = makeFetch({ scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');

    await screen.findByRole('dialog', { name: 'Roteiro de stories' });
    await waitFor(() => expect(textsOnScreen()).toEqual(['Primeira', 'Segunda']));
    expect(calls.some((call) => call.method === 'GET' && call.path === `/agencies/${AGENCY}/clients/${padaria.id}/story-scripts/${script.id}`)).toBe(true);

    typeInto('Texto da cena 2', 'Segunda editada');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.path).toBe(`/agencies/${AGENCY}/clients/${padaria.id}/story-scripts/${script.id}`);
    expect(patch.body).toEqual({
      scriptOn: '2026-10-20',
      scenes: [
        { id: script.scenes[0]!.id, text: 'Primeira', guidance: 'Filmar na vertical' },
        { id: script.scenes[1]!.id, text: 'Segunda editada', guidance: '' }
      ]
    });
  });

  it('moves the scene whose button was pressed and no other: two scenes', async () => {
    const script = scriptOf(padaria.id, { texts: ['Um', 'Dois'] });
    const [idUm, idDois] = script.scenes.map((scene) => scene.id);
    const { impl, calls } = makeFetch({ scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toEqual(['Um', 'Dois']));

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mover cena 2 para cima' }));
    expect(textsOnScreen()).toEqual(['Dois', 'Um']);
    expect((within(dialog()).getByRole('button', { name: 'Mover cena 1 para cima' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const sent = (calls.find((call) => call.method === 'PATCH')!.body as { scenes: { id: string; text: string }[] }).scenes;
    expect(sent.map((scene) => [scene.id, scene.text])).toEqual([[idDois, 'Dois'], [idUm, 'Um']]);
  });

  it('moves the middle scene of three up and down without touching the others', async () => {
    const script = scriptOf(padaria.id, { texts: ['A', 'B', 'C'] });
    const { impl } = makeFetch({ scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toEqual(['A', 'B', 'C']));

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mover cena 2 para baixo' }));
    expect(textsOnScreen()).toEqual(['A', 'C', 'B']);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mover cena 3 para cima' }));
    expect(textsOnScreen()).toEqual(['A', 'B', 'C']);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mover cena 2 para cima' }));
    expect(textsOnScreen()).toEqual(['B', 'A', 'C']);
    expect((within(dialog()).getByRole('button', { name: 'Mover cena 3 para baixo' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reorders with the keyboard: real buttons in the tab order, the focus follows the scene, and the move is announced', async () => {
    const script = scriptOf(padaria.id, { texts: ['A', 'B', 'C'] });
    const { impl } = makeFetch({ scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toEqual(['A', 'B', 'C']));

    const up = within(dialog()).getByRole('button', { name: 'Mover cena 2 para cima' });
    expect(up.tagName).toBe('BUTTON');
    expect(up.getAttribute('tabindex')).toBeNull();
    up.focus();
    fireEvent.click(up);

    expect(textsOnScreen()).toEqual(['B', 'A', 'C']);
    // The moved scene is now the first: its "up" is at the edge, so the focus stays on its "down".
    expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: 'Mover cena 1 para baixo' }));
    expect(within(dialog()).getByText('Cena movida para a posição 1 de 3.')).toBeTruthy();

    fireEvent.click(document.activeElement as HTMLElement);
    expect(textsOnScreen()).toEqual(['A', 'B', 'C']);
    expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: 'Mover cena 2 para baixo' }));
  });

  it('adds a scene at the end, focused and ready, and sends it without an id', async () => {
    const script = scriptOf(padaria.id, { texts: ['A'] });
    const { impl, calls } = makeFetch({ scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toEqual(['A']));

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Adicionar cena' }));
    expect(document.activeElement).toBe(within(dialog()).getByLabelText('Texto da cena 2'));
    typeInto('Texto da cena 2', 'B');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const scenes = (calls.find((call) => call.method === 'PATCH')!.body as { scenes: { id?: string; text: string }[] }).scenes;
    expect(scenes.map((scene) => [scene.id ?? null, scene.text])).toEqual([[script.scenes[0]!.id, 'A'], [null, 'B']]);
  });

  it('changes the day of the script', async () => {
    const script = scriptOf(padaria.id, { texts: ['A'] });
    const { impl, calls } = makeFetch({ scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toEqual(['A']));

    typeInto('Dia dos stories', '2026-10-25');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((calls.find((call) => call.method === 'PATCH')!.body as { scriptOn: string }).scriptOn).toBe('2026-10-25');
    await waitFor(() => expect(scriptMarks('2026-10-25')).toEqual(['Stories · Rascunho']));
    expect(scriptMarks('2026-10-20')).toEqual([]);
  });
});

describe('sending to the client', () => {
  it('sends an unchanged draft with the send route alone, closes, and the day reads "Enviado"', async () => {
    const script = scriptOf(padaria.id);
    const { impl, calls } = makeFetch({ scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toHaveLength(2));

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Enviar ao cliente' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(calls)).toEqual([`POST /${script.id}/send`]);
    await waitFor(() => expect(scriptMarks('2026-10-20')).toEqual(['Stories · Enviado']));
  });

  it('saves a changed draft first and then sends the same script, in that order', async () => {
    const script = scriptOf(padaria.id);
    const { impl, calls } = makeFetch({ scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toHaveLength(2));

    typeInto('Texto da cena 1', 'Mudou');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Enviar ao cliente' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(writes(calls)).toEqual([`PATCH /${script.id}`, `POST /${script.id}/send`]);
  });

  it('creates and sends a new script, and when the send fails the retry sends the one that was created, never another', async () => {
    let sends = 0;
    const { impl, calls, store } = makeFetch({
      override: (call) => (call.method === 'POST' && call.path.endsWith('/send') && ++sends === 1 ? failure(500, 'INTERNAL_ERROR', 'Boom') : undefined)
    });
    render_(impl);
    await openNewScriptOn('2026-10-21');
    typeInto('Texto da cena 1', 'Cena única');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Enviar ao cliente' }));

    expect(await within(dialog()).findByText('O roteiro foi salvo como rascunho, mas não foi enviado. Tente enviar de novo.')).toBeTruthy();
    expect((within(dialog()).getByLabelText('Texto da cena 1') as HTMLTextAreaElement).value).toBe('Cena única');
    expect(store).toHaveLength(1);

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Enviar ao cliente' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const id = store[0]!.id;
    expect(store).toHaveLength(1);
    expect(writes(calls)).toEqual(['POST ', `POST /${id}/send`, `POST /${id}/send`]);
    expect(store[0]!.status).toBe('sent');
  });

  it('keeps the text and says so when the script was sent by someone else meanwhile (409), without the server\'s words', async () => {
    const script = scriptOf(padaria.id);
    const { impl } = makeFetch({ scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toHaveLength(2));
    script.status = 'sent';

    typeInto('Texto da cena 1', 'Minha edição');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));

    expect(await within(dialog()).findByText(/Este roteiro já foi enviado e não pode mais ser editado/)).toBeTruthy();
    expect(dialog().textContent).not.toContain('Roteiro já enviado não é editado.');
    expect((within(dialog()).getByLabelText('Texto da cena 1') as HTMLTextAreaElement).value).toBe('Minha edição');
  });
});

describe('read-only', () => {
  it.each([
    ['a draft, without conteudo.operar', 'draft', [VISUALIZE, READ_CLIENTS]],
    ['a sent script, without conteudo.operar', 'sent', [VISUALIZE, READ_CLIENTS]],
    ['a recorded script, without conteudo.operar', 'recorded', [VISUALIZE, READ_CLIENTS]],
    ['a sent script, with conteudo.operar', 'sent', [VISUALIZE, OPERATE, READ_CLIENTS]],
    ['a recorded script, with conteudo.operar', 'recorded', [VISUALIZE, OPERATE, READ_CLIENTS]]
  ] as const)('opens %s as text: no field, no save, no send, no write', async (_name, status, permissions) => {
    const script = scriptOf(padaria.id, { status, texts: ['Cena <img src=x onerror=alert(1)>', 'Segunda'] });
    script.scenes[0]!.guidance = '<b>negrito</b> literal';
    const { impl, calls } = makeFetch({ permissions, scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');

    const modal = await screen.findByRole('dialog', { name: 'Roteiro de stories' });
    await within(modal).findByText('Cena <img src=x onerror=alert(1)>');
    expect(within(modal).getByText(/<b>negrito<\/b> literal/)).toBeTruthy();
    expect(modal.querySelector('img')).toBeNull();
    expect(modal.querySelector('b')).toBeNull();
    expect(within(modal).getByText('Cena 1')).toBeTruthy();
    expect(within(modal).getByText({ draft: 'Rascunho', sent: 'Enviado', recorded: 'Gravado' }[status])).toBeTruthy();
    expect(within(modal).queryAllByRole('textbox')).toHaveLength(0);
    for (const name of ['Salvar rascunho', 'Enviar ao cliente', 'Adicionar cena', /^Mover cena/]) expect(within(modal).queryByRole('button', { name })).toBeNull();
    expect(writes(calls)).toEqual([]);

    fireEvent.click(within(modal).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the modal belongs to its client', () => {
  it('is gone when the same screen shows another client, whose days carry no script of the first', async () => {
    const script = scriptOf(padaria.id, { texts: ['Da padaria'] });
    const { impl } = makeFetch({ scripts: [script] });
    const { probe } = render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toEqual(['Da padaria']));

    act(() => { probe.navigate(`/agencia/${AGENCY}/conteudos/${academia.id}`); });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await calendarReady();
    expect(scriptMarks('2026-10-20')).toEqual([]);
  });
});

describe('the states of the modal', () => {
  it('shows a skeleton while the script is read, then the script', async () => {
    const script = scriptOf(padaria.id, { texts: ['Pronto'] });
    const answer = deferred<Response>();
    const { impl } = makeFetch({
      scripts: [script],
      override: (call) => (call.method === 'GET' && call.path.endsWith(`/story-scripts/${script.id}`) ? answer.promise : undefined)
    });
    render_(impl);
    await openScript('2026-10-20');

    await screen.findByRole('dialog', { name: 'Roteiro de stories' });
    expect(document.querySelector('.story-script__loading')).not.toBeNull();
    expect(within(dialog()).queryAllByRole('textbox')).toHaveLength(0);
    await act(async () => { answer.resolve(json({ id: script.id, scriptOn: '2026-10-20', status: 'draft', scenes: script.scenes, recordedBy: null, recordedAt: null, createdAt: '2026-10-11T12:00:00.000Z' })); });
    await waitFor(() => expect(textsOnScreen()).toEqual(['Pronto']));
    expect(document.querySelector('.story-script__loading')).toBeNull();
  });

  it('offers "Tentar de novo" when the read fails, and reads again', async () => {
    const script = scriptOf(padaria.id, { texts: ['Voltou'] });
    let reads = 0;
    // A 4xx is not retried by the query client, so the error shows at once; a 5xx would be asked once more first.
    const { impl } = makeFetch({
      scripts: [script],
      override: (call) => (call.method === 'GET' && call.path.endsWith(`/story-scripts/${script.id}`) && ++reads === 1 ? failure(403, 'FORBIDDEN', 'Boom') : undefined)
    });
    render_(impl);
    await openScript('2026-10-20');

    expect(await within(await screen.findByRole('dialog')).findByText('Não foi possível carregar o roteiro. Tente de novo.')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(textsOnScreen()).toEqual(['Voltou']));
  });

  it('says the script is gone on a 404, with nothing to retry', async () => {
    const script = scriptOf(padaria.id);
    const { impl, store } = makeFetch({ scripts: [script] });
    render_(impl);
    await calendarReady();
    store.length = 0;
    fireEvent.click(within(dayCell('2026-10-20')).getByRole('button', { name: /^Stories/ }));

    expect(await within(await screen.findByRole('dialog')).findByText('Este roteiro não existe mais.')).toBeTruthy();
    expect(within(dialog()).queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
  });
});

const iconOf = (tag: Element): string => tag.querySelector('svg')?.getAttribute('class') ?? '';
const listRows = (): HTMLElement[] => within(document.querySelector<HTMLElement>('.story-list')!).queryAllByRole('listitem');

describe('the list of scripts of the period (#635)', () => {
  it('says there is none and offers "Novo roteiro", which opens the new script on today', async () => {
    const { impl } = makeFetch();
    render_(impl);
    await calendarReady();

    const list = document.querySelector<HTMLElement>('.story-list')!;
    expect(within(list).getByRole('heading', { name: 'Roteiros de stories' })).toBeTruthy();
    expect(within(list).getByRole('heading', { name: 'Nenhum roteiro de stories neste período' })).toBeTruthy();
    expect(within(list).queryAllByRole('listitem')).toHaveLength(0);
    fireEvent.click(within(list).getByRole('button', { name: 'Novo roteiro' }));

    await screen.findByRole('dialog', { name: 'Novo roteiro de stories' });
    expect((within(dialog()).getByLabelText('Dia dos stories') as HTMLInputElement).value).toBe('2026-10-11');
  });

  it('lays the empty state out like the clients roster (no mascot, centred text), through its own class', async () => {
    const { impl } = makeFetch();
    render_(impl);
    await calendarReady();

    const empty = document.querySelector<HTMLElement>('.story-list .ui-empty-state')!;
    expect(empty.classList.contains('story-list__empty')).toBe(true);
    expect(empty.classList.contains('ui-empty-state--mascot')).toBe(false);
    expect(empty.querySelector('img')).toBeNull();
  });

  it('offers no way to write one without conteudo.operar, and still says there is none', async () => {
    const { impl } = makeFetch({ permissions: [VISUALIZE, READ_CLIENTS] });
    render_(impl);
    await calendarReady();

    const list = document.querySelector<HTMLElement>('.story-list')!;
    expect(within(list).getByRole('heading', { name: 'Nenhum roteiro de stories neste período' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Novo roteiro' })).toBeNull();
  });

  it('lists each script by day with its state, in the order of the days, and opens the one that was chosen', async () => {
    const later = scriptOf(padaria.id, { scriptOn: '2026-10-22', status: 'recorded', texts: ['Depois'] });
    const first = scriptOf(padaria.id, { scriptOn: '2026-10-05', status: 'draft', texts: ['Primeiro'] });
    const middle = scriptOf(padaria.id, { scriptOn: '2026-10-20', status: 'sent', texts: ['Meio'] });
    const { impl } = makeFetch({ scripts: [later, first, middle] });
    render_(impl);
    await calendarReady();

    expect(listRows().map((row) => row.textContent)).toEqual([
      'segunda-feira, 5 de outubro de 2026RascunhoAbrir',
      'terça-feira, 20 de outubro de 2026EnviadoAbrir',
      'quinta-feira, 22 de outubro de 2026GravadoAbrir'
    ]);
    expect(within(document.querySelector<HTMLElement>('.story-list')!).getByRole('button', { name: 'Novo roteiro' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Nenhum roteiro de stories neste período' })).toBeNull();

    fireEvent.click(within(listRows()[1]!).getByRole('button', { name: 'Abrir o roteiro de terça-feira, 20 de outubro de 2026' }));
    await screen.findByRole('dialog', { name: 'Roteiro de stories' });
    expect(await within(dialog()).findByText('Meio')).toBeTruthy();
    expect(within(dialog()).queryByText('Primeiro')).toBeNull();
  });

  it('keeps the other clients and the other periods out of the list', async () => {
    const { impl } = makeFetch({
      scripts: [
        scriptOf(padaria.id, { scriptOn: '2026-10-20' }),
        scriptOf(academia.id, { scriptOn: '2026-10-21' }),
        scriptOf(padaria.id, { scriptOn: '2026-11-03' })
      ]
    });
    render_(impl);
    await calendarReady();

    expect(listRows()).toHaveLength(1);
  });

  it('is not shown on the feed view, which has no calendar to complete', async () => {
    const { impl } = makeFetch({ scripts: [scriptOf(padaria.id)] });
    render_(impl);
    await calendarReady();
    expect(document.querySelector('.story-list')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Feed' }));
    await waitFor(() => expect(document.querySelector('.content-calendar')).toBeNull());
    expect(document.querySelector('.story-list')).toBeNull();
  });
});

describe('the three states of a script (#635)', () => {
  it('tells draft, sent and recorded apart by word and by icon shape, in the list, on the day and in the modal', async () => {
    const scripts = [
      scriptOf(padaria.id, { scriptOn: '2026-10-05', status: 'draft' }),
      scriptOf(padaria.id, { scriptOn: '2026-10-06', status: 'sent' }),
      scriptOf(padaria.id, { scriptOn: '2026-10-07', status: 'recorded' })
    ];
    const { impl } = makeFetch({ scripts });
    render_(impl);
    await calendarReady();

    const inList = listRows().map((row) => row.querySelector('.ui-status-tag')!);
    const onDays = ['2026-10-05', '2026-10-06', '2026-10-07'].map((day) => within(dayCell(day)).getByRole('button', { name: /^Stories/ }).querySelector('.ui-status-tag')!);
    for (const tags of [inList, onDays]) {
      expect(tags.map((tag) => tag.textContent)).toEqual(['Rascunho', 'Enviado', 'Gravado']);
      expect(new Set(tags.map(iconOf)).size).toBe(3);
      for (const tag of tags) expect(tag.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(inList.map(iconOf)).toEqual(onDays.map(iconOf));

    fireEvent.click(within(dayCell('2026-10-06')).getByRole('button', { name: /^Stories/ }));
    const modal = await screen.findByRole('dialog', { name: 'Roteiro de stories' });
    await waitFor(() => expect(modal.querySelector('.story-script__status .ui-status-tag')?.textContent).toBe('Enviado'));
    expect(iconOf(modal.querySelector('.story-script__status .ui-status-tag')!)).toBe(iconOf(inList[1]!));
  });

  it('shows the state of a draft in the editor, and who recorded a recorded one', async () => {
    const draft = scriptOf(padaria.id, { scriptOn: '2026-10-05' });
    const recorded = scriptOf(padaria.id, { scriptOn: '2026-10-06', status: 'recorded' });
    const { impl } = makeFetch({
      scripts: [draft, recorded],
      override: (call) => (call.method === 'GET' && call.path.endsWith(`/story-scripts/${recorded.id}`)
        ? json({ ...shown(recorded), recordedBy: { name: 'Dona Rosa' }, recordedAt: '2026-10-10T12:00:00.000Z' })
        : undefined)
    });
    render_(impl);
    await openScript('2026-10-05');
    await waitFor(() => expect(textsOnScreen()).toHaveLength(2));
    expect(dialog().querySelector('.story-script__status')?.textContent).toBe('Rascunho');

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(within(dayCell('2026-10-06')).getByRole('button', { name: /^Stories/ }));
    await within(await screen.findByRole('dialog')).findByText('Gravado por Dona Rosa');
    expect(dialog().querySelector('.story-script__status')?.textContent).toBe('GravadoGravado por Dona Rosa');
  });
});

describe('the modal in the Pauta look (#635)', () => {
  it('puts every field in a Field, and sending is the one primary action, last in the foot', async () => {
    const script = scriptOf(padaria.id);
    const { impl } = makeFetch({ scripts: [script] });
    render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toHaveLength(2));

    for (const label of ['Dia dos stories', 'Texto da cena 1', 'Orientação da cena 1', 'Texto da cena 2']) {
      expect(within(dialog()).getByLabelText(label).closest('.ui-field'), label).not.toBeNull();
    }
    const buttons = within(dialog().querySelector<HTMLElement>('.form-actions')!).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(['Cancelar', 'Salvar rascunho', 'Enviar ao cliente']);
    expect(buttons.map((button) => button.className.match(/ui-button--(primary|secondary|ghost)/)![1])).toEqual(['ghost', 'secondary', 'primary']);
    expect(dialog().querySelectorAll('.ui-button--primary')).toHaveLength(1);
  });

  it('gives the dialog a description and moves a scene with icon buttons that keep their names', async () => {
    const { impl } = makeFetch({ scripts: [scriptOf(padaria.id)] });
    render_(impl);
    await openScript('2026-10-20');
    await waitFor(() => expect(textsOnScreen()).toHaveLength(2));

    expect(document.getElementById(dialog().getAttribute('aria-describedby') ?? '')?.textContent).toBe('Cada cena leva o texto e, se quiser, a orientação para gravar.');
    const down = within(dialog()).getByRole('button', { name: 'Mover cena 1 para baixo' });
    expect(down.classList.contains('ui-icon-button')).toBe(true);
    expect(down.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(down.textContent).toBe('');
  });

  it('puts the focus on the first invalid field and gives one alert that names the three, each field keeping its own description', async () => {
    const { impl } = makeFetch();
    render_(impl);
    await openNewScriptOn('2026-10-20');
    typeInto('Dia dos stories', '');
    typeInto('Orientação da cena 1', `Luz${String.fromCodePoint(0x200b)}natural`);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));

    for (const [label, text] of [
      ['Dia dos stories', 'Informe o dia dos stories.'],
      ['Texto da cena 1', 'Escreva o texto da cena.'],
      ['Orientação da cena 1', 'A orientação tem caracteres invisíveis ou de controle.']
    ] as const) {
      const message = await within(dialog()).findByText(text);
      const control = within(dialog()).getByLabelText(label);
      expect(message.querySelector('.ui-icon svg'), label).not.toBeNull();
      expect(message.getAttribute('role'), label).toBeNull();
      expect(control.getAttribute('aria-invalid'), label).toBe('true');
      expect(control.getAttribute('aria-describedby'), label).toBe(message.id);
    }
    expect(document.activeElement).toBe(within(dialog()).getByLabelText('Dia dos stories'));
    const alerts = within(dialog()).getAllByRole('alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe('Corrija 3 campos: Dia dos stories, Texto da cena 1, Orientação da cena 1.');
  });

  it('also asks for the focus and the summary when the send button, which is not a submit, refuses the script', async () => {
    const { impl, calls } = makeFetch();
    render_(impl);
    await openNewScriptOn('2026-10-20');
    typeInto('Dia dos stories', '');
    within(dialog()).getByRole('button', { name: 'Enviar ao cliente' }).focus();

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Enviar ao cliente' }));

    await within(dialog()).findByText('Informe o dia dos stories.');
    expect(document.activeElement).toBe(within(dialog()).getByLabelText('Dia dos stories'));
    expect(within(dialog()).getAllByRole('alert')).toHaveLength(1);
    expect(within(dialog()).getByRole('alert').textContent).toBe('Corrija 2 campos: Dia dos stories, Texto da cena 1.');
    expect(writes(calls)).toEqual([]);
  });

  it('keeps an invalid scene marked and described by its own message', async () => {
    const { impl } = makeFetch();
    render_(impl);
    await openNewScriptOn('2026-10-20');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Salvar rascunho' }));

    const field = within(dialog()).getByLabelText('Texto da cena 1');
    const message = await within(dialog()).findByText('Escreva o texto da cena.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(message.id);
    // One field is wrong: the focus takes the person to it and the description is read there, with no alert of its own.
    expect(message.getAttribute('role')).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(within(dialog()).queryByRole('alert')).toBeNull();
  });
});
