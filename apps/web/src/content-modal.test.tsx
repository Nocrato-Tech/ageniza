// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreateContentRequestSchema, CreateMediaFolderRequestSchema, UpdateContentRequestSchema } from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { createConversationApi } from './conversation-fixture.js';
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

/** 01:30Z of the 12th is 22:30 of the 11th in São Paulo: a day computed in UTC is the wrong one. */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T01:30:00Z'));
});
const TODAY = '2026-10-11';

const AGENCY = '11111111-1111-4111-8111-111111111111';
const USER = '99999999-9999-4999-8999-999999999999';
const sessionBody = { user: { id: USER, name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message = 'MENSAGEM DO SERVIDOR'): Response => json({ error: { code, message } }, status);
const invalidField = (path: string): Response =>
  json({ error: { code: 'VALIDATION_ERROR', message: 'MENSAGEM DO SERVIDOR', details: { issues: [{ path, code: 'custom', message: 'MENSAGEM DO SERVIDOR' }] } } }, 400);

const VISUALIZE = 'conteudo.visualizar';
const OPERATE = 'conteudo.operar';
const READ_CLIENTS = 'cliente.visualizar';
const EDITOR = [VISUALIZE, OPERATE, READ_CLIENTS];

const client = (id: string, name: string, status: 'active' | 'archived' = 'active') =>
  ({ id, name, photoUrl: null, instagramHandle: name === 'Padaria Central' ? 'padariacentral' : null, status, closingDate: null, threadsAwaitingAgency: 0 });
const padaria = client('1a1a1a1a-1111-4111-8111-111111111111', 'Padaria Central');
const barbearia = client('3c3c3c3c-3333-4333-8333-333333333333', 'Barbearia Lima', 'archived');
const ROSTER = [padaria, barbearia];

const clientDetail = (row: ReturnType<typeof client>) => ({
  id: row.id, name: row.name, status: row.status, photoUrl: row.photoUrl, instagramHandle: row.instagramHandle, closingDate: row.closingDate,
  legalName: null, taxId: null, segment: null, website: null, contactName: null, contactPhone: null, contactEmail: null,
  archivedAt: row.status === 'archived' ? '2026-10-01T00:00:00.000Z' : null,
  summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 0 }
});

const VIDEOS = 'f1f1f1f1-0000-4000-8000-000000000001';
const IMAGES = 'f1f1f1f1-0000-4000-8000-000000000002';
const LAUNCH = 'f1f1f1f1-0000-4000-8000-000000000003';
const folder = (id: string, name: string, parentId: string | null = null) => ({ id, parentId, name, isDefault: parentId === null, createdAt: '2026-10-01T12:00:00.000Z' });
const FOLDERS = [folder(VIDEOS, 'Vídeos'), folder(IMAGES, 'Imagens'), folder(LAUNCH, 'Lançamento', VIDEOS)];

const asset = (n: number, category: 'image' | 'video', day: string) => ({
  id: `a0a0a0a0-0000-4000-8000-${String(n).padStart(12, '0')}`,
  category,
  contentType: category === 'image' ? 'image/jpeg' : 'video/mp4',
  sizeBytes: 1000,
  videoProcessingStatus: category === 'video' ? 'ready' : 'not_applicable',
  createdAt: `2026-10-${day}T15:00:00.000Z`
});
const IMG_1 = asset(1, 'image', '03');
const IMG_2 = asset(2, 'image', '04');
const IMG_3 = asset(3, 'image', '05');
const VID_1 = asset(4, 'video', '06');
const VID_2 = asset(5, 'video', '07');
const ASSETS: Readonly<Record<string, ReadonlyArray<ReturnType<typeof asset>>>> = {
  [VIDEOS]: [VID_1, VID_2],
  [IMAGES]: [IMG_1, IMG_2, IMG_3],
  [LAUNCH]: [asset(6, 'video', '08'), asset(7, 'image', '09')]
};

type Format = 'image' | 'carousel' | 'reels' | 'long_video' | 'vsl';
type Status = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';
interface Stored {
  id: string;
  clientId: string;
  title: string;
  format: Format;
  publishOn: string;
  publishAtTime: string | null;
  caption: string | null;
  folderId: string;
  coverAssetId: string | null;
  status: Status;
  revision: number;
  media: string[];
}

let counter = 0;
const stored = (overrides: Partial<Stored> = {}): Stored => {
  counter += 1;
  return {
    id: `c0c0c0c0-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    clientId: padaria.id,
    title: 'Lançamento do pão',
    format: 'image',
    publishOn: '2026-10-20',
    publishAtTime: null,
    caption: 'Pão fresquinho',
    folderId: IMAGES,
    coverAssetId: null,
    status: 'in_production',
    revision: 1,
    media: [],
    ...overrides
  };
};

const detailOf = (row: Stored) => ({
  id: row.id, clientId: row.clientId, title: row.title, platform: 'instagram', format: row.format, publishOn: row.publishOn,
  publishAtTime: row.publishAtTime, caption: row.caption, folderId: row.folderId, coverAssetId: row.coverAssetId, owner: { membershipId: 'e0e0e0e0-0000-4000-8000-000000000001', name: 'Ana Souza' },
  status: row.status, revision: row.revision, approvedBy: null, approvedAt: null, approvedByAgencyReason: null, publishedOn: null,
  cancelledAt: null, createdAt: '2026-10-01T12:00:00.000Z',
  media: row.media.map((id, index) => ({ id, position: index + 1 })), tasks: [],
  conversation: { threadId: null, commentCount: 0, lastCommentAt: null }
});

const listItemOf = (row: Stored) => ({
  id: row.id, title: row.title, platform: 'instagram', format: row.format, publishOn: row.publishOn, publishAtTime: row.publishAtTime,
  status: row.status, owner: { membershipId: 'e0e0e0e0-0000-4000-8000-000000000001', name: 'Ana Souza' }, coverAssetId: row.coverAssetId, revision: row.revision, publishedOn: null, tasksTotal: 0, tasksApproved: 0
});

type ConversationFake = ReturnType<typeof createConversationApi>;

interface Call { readonly method: string; readonly path: string; readonly body: unknown }

interface Scenario {
  readonly permissions?: readonly string[];
  readonly contents?: readonly Stored[];
  readonly folders?: ReadonlyArray<ReturnType<typeof folder>>;
  readonly assets?: Readonly<Record<string, ReadonlyArray<ReturnType<typeof asset>>>>;
  /** Fills the conversation routes before the screen reads them (the thread of a content, its messages). */
  readonly seedConversation?: (conversation: ConversationFake, forClient: (clientId: string) => ConversationFake) => void;
  /** Answers instead of the fake for a request, when it returns a response. */
  readonly override?: (call: Call, calls: readonly Call[]) => Response | Promise<Response> | undefined;
}

const PAGE_MAX = 100;
const paged = <T,>(rows: readonly T[], url: URL) => {
  const page = Number(url.searchParams.get('page') ?? '1');
  const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? '20'), PAGE_MAX);
  return json({ data: rows.slice((page - 1) * pageSize, page * pageSize), meta: { page, pageSize, totalItems: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)) } });
};

/**
 * Behaves like the real API: 403 without the permission (a write needs `conteudo.operar` AND `conteudo.visualizar`),
 * 400 by the contract's own schemas, 404 for a content that is not the client's, 409 for a closed content, an archived
 * client, a folder that holds media, and a state the database decides itself (an approved content goes back to
 * "aguardando aprovação" when the caption, the media, the cover or the format changes).
 */
const makeFetch = (scenario: Scenario = {}) => {
  const calls: Call[] = [];
  const contents = [...(scenario.contents ?? [])];
  const folders = [...(scenario.folders ?? FOLDERS)];
  const assets = scenario.assets ?? ASSETS;
  const permissions = scenario.permissions ?? EDITOR;
  let created = 0;
  const conversations = new Map<string, ConversationFake>();
  const conversationFor = (clientId: string): ConversationFake => {
    const known = conversations.get(clientId) ?? createConversationApi({ side: 'agency', clientId });
    conversations.set(clientId, known);
    return known;
  };
  const conversation = conversationFor(padaria.id);
  scenario.seedConversation?.(conversation, conversationFor);

  /** The routes of the conversation, as the API answers them: reading asks `conteudo.visualizar`, writing both, and a content in production or cancelled takes no message. */
  const answerConversation = (url: URL, method: string, body: unknown, clientId: string): Response => {
    const write = method !== 'GET';
    if (!permissions.includes(VISUALIZE) || (write && !permissions.includes(OPERATE))) return failure(403, 'FORBIDDEN');
    const row = ROSTER.find((candidate) => candidate.id === clientId);
    if (row === undefined) return failure(404, 'NOT_FOUND');
    if (write && row.status === 'archived') return failure(409, 'CLIENT_ARCHIVED');
    const named = /\/threads\/([^/]+)\//.exec(url.pathname)?.[1];
    const subject = named === undefined
      ? (body as { subject?: { contentId?: string } } | undefined)?.subject
      : conversationFor(clientId).threads.find((thread) => thread.id === named)?.subject;
    const contentId = subject !== undefined && 'contentId' in subject ? subject.contentId : undefined;
    if (write && contentId !== undefined && !url.pathname.endsWith('/resolve')) {
      const content = contents.find((candidate) => candidate.id === contentId && candidate.clientId === clientId);
      if (content === undefined) return failure(404, 'NOT_FOUND');
      if (content.status === 'in_production' || content.status === 'cancelled') return failure(409, 'CONTENT_NOT_OPEN');
    }
    return conversationFor(clientId).handle(url, method, body) ?? failure(404, 'NOT_FOUND');
  };

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
      return json({ agencyId: AGENCY, agencyName: 'Agência Um', isOwner: false, role: { key: 'custom', name: 'Papel' }, permissions });
    }
    if (/\/agencies\/[^/]+\/clients$/.test(url.pathname)) {
      const rows = ROSTER.filter((row) => row.status === 'active');
      return json({ data: rows, meta: { page: 1, pageSize: 100, totalItems: rows.length, totalPages: 1 } });
    }
    const one = /\/agencies\/[^/]+\/clients\/([^/]+)$/.exec(url.pathname);
    if (one !== null) {
      const row = ROSTER.find((candidate) => candidate.id === one[1]);
      return row === undefined ? failure(404, 'NOT_FOUND') : json(clientDetail(row));
    }
    const conversationRoute = /\/agencies\/[^/]+\/clients\/([^/]+)\/threads(?:\/[^/]+\/(?:comments|resolve))?$/.exec(url.pathname);
    if (conversationRoute !== null) return answerConversation(url, method, body, conversationRoute[1]!);
    const media = /\/agencies\/[^/]+\/media\/([^/]+)\/download-url$/.exec(url.pathname);
    if (media !== null) {
      if (!permissions.includes(VISUALIZE)) return failure(403, 'FORBIDDEN');
      return json({ url: `https://storage.test/${media[1]}.jpg`, expiresAt: '2026-10-12T01:45:00.000Z' });
    }

    const scoped = /\/agencies\/[^/]+\/clients\/([^/]+)\/(contents|media-folders)(?:\/([^/]+))?(?:\/assets)?$/.exec(url.pathname);
    if (scoped === null) throw new Error(`unexpected ${method} ${url}`);
    const clientId = scoped[1]!;
    const row = ROSTER.find((candidate) => candidate.id === clientId);
    const write = method !== 'GET';
    if (!permissions.includes(VISUALIZE) || (write && !permissions.includes(OPERATE))) return failure(403, 'FORBIDDEN');
    if (row === undefined) return failure(404, 'NOT_FOUND');
    if (write && row.status === 'archived') return failure(409, 'CLIENT_ARCHIVED');

    if (scoped[2] === 'media-folders') {
      if (url.pathname.endsWith('/assets')) {
        const folderAssets = assets[scoped[3]!];
        return folderAssets === undefined ? failure(404, 'NOT_FOUND') : paged(folderAssets, url);
      }
      if (method === 'GET') return paged(folders, url);
      const parsed = CreateMediaFolderRequestSchema.safeParse(body);
      if (!parsed.success) return invalidField('name');
      if (parsed.data.parentId !== undefined && folders.find((candidate) => candidate.id === parsed.data.parentId)?.parentId !== null) return invalidField('parentId');
      const made = folder(`f2f2f2f2-0000-4000-8000-${String(folders.length + 1).padStart(12, '0')}`, parsed.data.name, parsed.data.parentId ?? null);
      folders.push(made);
      return json(made, 201);
    }

    if (method === 'GET' && scoped[3] === undefined) {
      const from = url.searchParams.get('from')!;
      const to = url.searchParams.get('to')!;
      const rows = contents.filter((content) => content.clientId === clientId && content.publishOn >= from && content.publishOn <= to).map(listItemOf);
      return json({ data: { contents: rows, storyScripts: [] }, meta: { from, to, count: rows.length } });
    }
    if (method === 'POST' && scoped[3] === undefined) {
      const parsed = CreateContentRequestSchema.safeParse(body);
      if (!parsed.success) return invalidField(String(parsed.error.issues[0]?.path[0] ?? 'title'));
      if (!folders.some((candidate) => candidate.id === parsed.data.folderId)) return failure(400, 'CONTENT_FOLDER_INVALID');
      created += 1;
      const made = stored({
        id: `c1c1c1c1-0000-4000-8000-${String(created).padStart(12, '0')}`,
        clientId,
        title: parsed.data.title,
        format: parsed.data.format,
        publishOn: parsed.data.publishOn,
        publishAtTime: parsed.data.publishAtTime ?? null,
        caption: parsed.data.caption ?? null,
        folderId: parsed.data.folderId
      });
      contents.push(made);
      return json(detailOf(made), 201);
    }
    const found = contents.find((content) => content.id === scoped[3] && content.clientId === clientId);
    if (found === undefined) return failure(404, 'NOT_FOUND');
    if (method === 'GET') return json(detailOf(found));
    if (method === 'PATCH') {
      const parsed = UpdateContentRequestSchema.safeParse(body);
      if (!parsed.success) return invalidField(String(parsed.error.issues[0]?.path[0] ?? 'title'));
      if (found.status === 'published' || found.status === 'cancelled') return failure(409, 'CONTENT_NOT_EDITABLE');
      const change = parsed.data;
      if (change.folderId !== undefined && change.folderId !== found.folderId) {
        if (found.media.length > 0 || found.coverAssetId !== null) return failure(409, 'CONTENT_FOLDER_IN_USE');
        if (!folders.some((candidate) => candidate.id === change.folderId)) return failure(400, 'CONTENT_FOLDER_INVALID');
      }
      const folderId = change.folderId ?? found.folderId;
      const format = change.format ?? found.format;
      if (change.mediaAssetIds !== undefined) {
        const inFolder = (assets[folderId] ?? []).map((candidate) => candidate.id);
        if ((format !== 'carousel' && change.mediaAssetIds.length > 1) || change.mediaAssetIds.some((id) => !inFolder.includes(id))) return failure(400, 'CONTENT_MEDIA_INVALID');
      }
      if (change.coverAssetId !== undefined && change.coverAssetId !== null
        && (assets[folderId] ?? []).find((candidate) => candidate.id === change.coverAssetId)?.category !== 'image') return failure(400, 'CONTENT_MEDIA_INVALID');
      const resets = found.status === 'approved'
        && (change.caption !== undefined || change.mediaAssetIds !== undefined || change.coverAssetId !== undefined || change.format !== undefined);
      if (change.title !== undefined) found.title = change.title.trim();
      if (change.format !== undefined) found.format = change.format;
      if (change.publishOn !== undefined) found.publishOn = change.publishOn;
      if (change.publishAtTime !== undefined) found.publishAtTime = change.publishAtTime;
      if (change.caption !== undefined) found.caption = change.caption === null ? null : change.caption.trim();
      found.folderId = folderId;
      if (change.coverAssetId !== undefined) found.coverAssetId = change.coverAssetId;
      if (change.mediaAssetIds !== undefined) found.media = [...change.mediaAssetIds];
      if (resets) { found.status = 'awaiting_approval'; found.revision += 1; }
      return json(detailOf(found));
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { impl, calls, contents, folders, conversation };
};

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

interface Probe { pathname: string; search: string; state: unknown; navigate: NavigateFunction }

function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.state = location.state;
    probe.navigate = navigate;
  });
  return null;
}

const base = (clientId = padaria.id) => `/agencia/${AGENCY}/conteudos/${clientId}`;

const render_ = (impl: typeof fetch, entry: string | { pathname: string; state: unknown } = base()) => {
  const probe: Probe = { pathname: '', search: '', state: undefined, navigate: () => undefined };
  const sessionEnd = createSessionEndSignal();
  const http = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const store = createAuthSessionStore(http);
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={http}>
          <MemoryRouter initialEntries={[entry]}>
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

const dialog = (): HTMLElement => screen.getByRole('dialog');
const field = (label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => within(dialog()).getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string): void => { fireEvent.change(field(label), { target: { value } }); };
const click = (name: string | RegExp): void => { fireEvent.click(within(dialog()).getByRole('button', { name })); };
const writes = (calls: readonly Call[]): Call[] => calls.filter((call) => call.method !== 'GET');
const periodCalls = (calls: readonly Call[]): Call[] => calls.filter((call) => /\/contents\?/.test(call.path));
const contentPath = (id: string) => `/agencies/${AGENCY}/clients/${padaria.id}/contents/${id}`;
const calendarReady = (): Promise<HTMLElement> => waitFor(() => {
  const calendar = document.querySelector<HTMLElement>('.content-calendar');
  if (calendar === null) throw new Error('The calendar has not rendered yet.');
  return calendar;
});

/** Opens the content straight from its address and waits for the form. */
const openContent = async (row: Stored, scenario: Scenario = {}, entry?: string) => {
  const fetchers = makeFetch({ ...scenario, contents: [row, ...(scenario.contents ?? [])] });
  const view = render_(fetchers.impl, entry ?? `${base()}/${row.id}`);
  await screen.findByRole('dialog');
  await screen.findByLabelText('Título');
  return { ...fetchers, ...view };
};

const closed = (): void => expect(screen.queryByRole('dialog')).toBeNull();

describe('the address of a content', () => {
  it('opens the modal from the shared address, with the form of that content, and again after a reload', async () => {
    const row = stored({ title: 'Lançamento do pão', publishAtTime: '18:00:00', caption: 'Pão fresquinho' });
    const { impl } = makeFetch({ contents: [row] });
    const first = render_(impl, `${base()}/${row.id}`);
    expect(await screen.findByRole('heading', { name: 'Lançamento do pão' })).toBeTruthy();
    expect((field('Título') as HTMLInputElement).value).toBe('Lançamento do pão');
    expect((field('Data') as HTMLInputElement).value).toBe('2026-10-20');
    expect((field('Hora') as HTMLInputElement).value).toBe('18:00');
    expect((field('Legenda') as HTMLTextAreaElement).value).toBe('Pão fresquinho');
    expect((field('Formato') as HTMLSelectElement).value).toBe('image');
    first.unmount();

    render_(impl, `${base()}/${row.id}`);
    expect(await screen.findByRole('heading', { name: 'Lançamento do pão' })).toBeTruthy();
    expect((field('Título') as HTMLInputElement).value).toBe('Lançamento do pão');
  });

  it('opens from the title of a card, keeps the period and the state of the roster, and closes back to the same calendar', async () => {
    const row = stored({ title: 'Receita longa', publishOn: '2026-10-21' });
    const other = stored({ title: 'Outro dia', publishOn: '2026-10-22' });
    const { impl } = makeFetch({ contents: [row, other] });
    const { probe } = render_(impl, { pathname: `${base()}`, state: { from: 'carteira' } });
    await calendarReady();
    await screen.findByText('Receita longa');
    probe.navigate(`${base()}?visao=semana&data=2026-10-21`, { state: { from: 'carteira' } });
    await screen.findByText('Receita longa');

    const link = screen.getByRole('link', { name: 'Receita longa' });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Receita longa' }).getAttribute('href')).toBe(`${base()}/${row.id}?visao=semana&data=2026-10-21`));
    fireEvent.click(link);
    expect(await screen.findByRole('dialog', { name: 'Receita longa' })).toBeTruthy();
    expect(probe.pathname).toBe(`${base()}/${row.id}`);
    expect(probe.search).toBe('?visao=semana&data=2026-10-21');
    expect(probe.state).toEqual({ from: 'carteira' });

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Fechar conteúdo' }));
    await waitFor(closed);
    expect(probe.pathname).toBe(base());
    expect(probe.search).toBe('?visao=semana&data=2026-10-21');
    expect(probe.state).toEqual({ from: 'carteira' });
  });

  it('opens the card of the second content, not of the first', async () => {
    const first = stored({ title: 'Primeiro', publishOn: '2026-10-20' });
    const second = stored({ title: 'Segundo', publishOn: '2026-10-20' });
    const { impl } = makeFetch({ contents: [first, second] });
    const { probe } = render_(impl);
    await screen.findByRole('link', { name: 'Segundo' });
    fireEvent.click(screen.getByRole('link', { name: 'Segundo' }));
    await screen.findByRole('dialog', { name: 'Segundo' });
    expect(probe.pathname).toBe(`${base()}/${second.id}`);
  });

  it.each([
    ['the API says 404', () => failure(404, 'NOT_FOUND')],
    ['the API says 403', () => failure(403, 'FORBIDDEN')]
  ])('says the content does not exist, in the screen\'s own words, when %s', async (_name, answer) => {
    const row = stored();
    const { impl } = makeFetch({
      contents: [row],
      override: (call) => (call.method === 'GET' && call.path === contentPath(row.id) ? answer() : undefined)
    });
    render_(impl, `${base()}/${row.id}`);
    expect(await screen.findByText('Este conteúdo não existe mais ou você não tem acesso a ele.')).toBeTruthy();
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('says the same for a malformed address, without asking the API for it', async () => {
    const { impl, calls } = makeFetch({ contents: [stored()] });
    render_(impl, `${base()}/nao-e-um-id`);
    expect(await screen.findByText('Este conteúdo não existe mais ou você não tem acesso a ele.')).toBeTruthy();
    expect(calls.some((call) => /\/contents\/nao-e-um-id/.test(call.path))).toBe(false);
  });

  it('does not show an answer that is about another content, or another client\'s', async () => {
    const row = stored();
    const elsewhere = stored({ title: 'De outro conteúdo' });
    // The same id, in another client: only the client of the address tells it apart.
    const foreign = { ...detailOf(row), title: 'De outro cliente', clientId: barbearia.id };
    for (const answer of [detailOf(elsewhere), foreign]) {
      const { impl } = makeFetch({
        contents: [row],
        override: (call) => (call.method === 'GET' && call.path === contentPath(row.id) ? json(answer) : undefined)
      });
      const view = render_(impl, `${base()}/${row.id}`);
      expect(await screen.findByText('Este conteúdo não existe mais ou você não tem acesso a ele.')).toBeTruthy();
      expect(screen.queryByText(answer.title)).toBeNull();
      view.unmount();
    }
  });

  it('shows the error with "Tentar de novo", and the retry brings the form back', async () => {
    const row = stored();
    let failing = true;
    const { impl } = makeFetch({
      contents: [row],
      override: (call) => (failing && call.method === 'GET' && call.path === contentPath(row.id) ? failure(500, 'INTERNAL') : undefined)
    });
    render_(impl, `${base()}/${row.id}`);
    expect(await screen.findByText('Não foi possível carregar o conteúdo. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    failing = false;
    click('Tentar de novo');
    expect(await screen.findByLabelText('Título')).toBeTruthy();
  });

  it('has the Geral tab selected and the Atribuição tab closed, until its own issue', async () => {
    await openContent(stored());
    expect(within(dialog()).getByRole('tab', { name: 'Geral' }).getAttribute('aria-selected')).toBe('true');
    const assignment = within(dialog()).getByRole('tab', { name: 'Atribuição' });
    expect(assignment.getAttribute('aria-selected')).toBe('false');
    expect((assignment as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('who may edit', () => {
  it.each([
    ['conteudo.visualizar only', [VISUALIZE, READ_CLIENTS], false],
    ['conteudo.visualizar and conteudo.operar', EDITOR, true]
  ])('%s: the fields are enabled only for who operates', async (_name, permissions, editable) => {
    await openContent(stored(), { permissions });
    await waitFor(() => expect((field('Título') as HTMLInputElement).disabled).toBe(!editable));
    for (const label of ['Título', 'Formato', 'Data', 'Hora', 'Legenda']) expect(field(label).disabled).toBe(!editable);
    expect(within(dialog()).queryByRole('button', { name: 'Salvar' }) !== null).toBe(editable);
    expect(within(dialog()).queryByText('Você pode ver este conteúdo, mas não editar.') !== null).toBe(!editable);
  });

  it('is read-only on an archived client, with its own note', async () => {
    const row = stored({ clientId: barbearia.id });
    const { impl } = makeFetch({ contents: [row] });
    render_(impl, `${base(barbearia.id)}/${row.id}`);
    await screen.findByLabelText('Título');
    expect(await within(dialog()).findByText('Cliente arquivado: o conteúdo é só leitura.')).toBeTruthy();
    expect(field('Título').disabled).toBe(true);
    expect(within(dialog()).queryByRole('button', { name: 'Salvar' })).toBeNull();
  });

  it.each(['published', 'cancelled'] as const)('is read-only on a %s content, with its own note', async (status) => {
    await openContent(stored({ status }));
    expect(await within(dialog()).findByText('Este conteúdo já foi publicado ou cancelado e não pode mais ser editado.')).toBeTruthy();
    expect(field('Título').disabled).toBe(true);
    expect(within(dialog()).queryByRole('button', { name: 'Salvar' })).toBeNull();
  });

  it('shows the state of the content, in the agency\'s words', async () => {
    await openContent(stored({ status: 'approved' }));
    expect(within(dialog()).getByText('Pronto para publicar')).toBeTruthy();
  });
});

describe('editing', () => {
  it('sends only what changed, closes on success, and reads the calendar again', async () => {
    const row = stored({ publishAtTime: '18:00:00' });
    const { calls } = await openContent(row);
    type('Título', '  Pão novo  ');
    type('Hora', '19:30');
    type('Legenda', 'Pão fresquinho, quente');
    const before = periodCalls(calls).length;
    click('Salvar');

    await waitFor(closed);
    expect(writes(calls)).toEqual([{ method: 'PATCH', path: contentPath(row.id), body: { title: '  Pão novo  ', publishAtTime: '19:30', caption: 'Pão fresquinho, quente' } }]);
    await waitFor(() => expect(periodCalls(calls).length).toBeGreaterThan(before));
  });

  it('sends the day and clears the time with null, and a blank caption as null', async () => {
    const row = stored({ publishAtTime: '18:00:00' });
    const { calls } = await openContent(row);
    type('Data', '2026-10-25');
    type('Hora', '');
    type('Legenda', '   ');
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ publishOn: '2026-10-25', publishAtTime: null, caption: null });
  });

  it('keeps Salvar closed until something changes, and again when it is changed back', async () => {
    await openContent(stored());
    const save = within(dialog()).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    type('Título', 'Outro');
    expect(save.disabled).toBe(false);
    type('Título', 'Lançamento do pão');
    expect(save.disabled).toBe(true);
  });

  it('does not close while the save is on its way, and closes when it answers', async () => {
    const row = stored();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { calls } = await openContent(row, {
      override: (call) => (call.method === 'PATCH' ? held.then(() => undefined) as never : undefined)
    });
    type('Título', 'Outro');
    click('Salvar');
    await waitFor(() => expect(writes(calls)).toHaveLength(1));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Fechar conteúdo' }));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    release();
  });

  it.each([
    [409, 'CLIENT_ARCHIVED', 'Este cliente está arquivado: o conteúdo é só leitura.'],
    [409, 'CONTENT_NOT_EDITABLE', 'Este conteúdo já foi publicado ou cancelado e não pode mais ser editado.'],
    [409, 'TRY_AGAIN', 'Outra alteração aconteceu ao mesmo tempo. Salve de novo.'],
    [409, 'CONTENT_MEDIA_INCOMPLETE', 'A mídia não cobre este formato. Depois do envio para aprovação, não se troca entre carrossel e uma mídia só: cancele e reagende o conteúdo.'],
    [409, 'CONTENT_FOLDER_IN_USE', 'A pasta não muda enquanto o conteúdo tem mídia ou capa. Tire as duas, salve, e escolha a outra pasta.'],
    [400, 'CONTENT_MEDIA_INVALID', 'A mídia ou a capa escolhida não pode ser usada neste conteúdo.'],
    [400, 'CONTENT_FOLDER_INVALID', 'A pasta escolhida não é uma pasta deste cliente.'],
    [403, 'FORBIDDEN', 'Você não tem permissão para alterar conteúdos.'],
    [404, 'NOT_FOUND', 'Este conteúdo não existe mais.'],
    [500, 'INTERNAL', 'Não foi possível salvar o conteúdo. Tente de novo.']
  ])('answers %s %s with its own words, keeps the modal open and keeps what was typed', async (status, code, text) => {
    const row = stored();
    await openContent(row, { override: (call) => (call.method === 'PATCH' ? failure(status, code) : undefined) });
    type('Título', 'Título que eu digitei');
    type('Legenda', 'Legenda que eu digitei');
    click('Salvar');

    expect((await within(dialog()).findAllByRole('alert')).some((alert) => alert.textContent === text)).toBe(true);
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect((field('Título') as HTMLInputElement).value).toBe('Título que eu digitei');
    expect((field('Legenda') as HTMLTextAreaElement).value).toBe('Legenda que eu digitei');
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('marks the field the API refused, in the screen\'s own words', async () => {
    const row = stored();
    await openContent(row, { override: (call) => (call.method === 'PATCH' ? invalidField('caption') : undefined) });
    type('Legenda', 'Algo que o servidor recusa');
    click('Salvar');

    const message = await within(dialog()).findByText('A legenda não foi aceita. Revise o texto.');
    expect(message.getAttribute('role')).toBe('alert');
    expect(field('Legenda').getAttribute('aria-invalid')).toBe('true');
    expect(field('Título').getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect(within(dialog()).getByText('Revise os campos marcados.')).toBeTruthy();
  });

  it('clears the mark of a field when that field is edited again', async () => {
    await openContent(stored(), { override: (call) => (call.method === 'PATCH' ? invalidField('title') : undefined) });
    type('Título', 'Recusado');
    click('Salvar');
    await within(dialog()).findByText('O título não foi aceito. Revise o texto.');
    type('Título', 'Aceito');
    expect(within(dialog()).queryByText('O título não foi aceito. Revise o texto.')).toBeNull();
  });

  it.each([
    ['an empty title', 'Título', '   ', 'Informe o título.'],
    ['a title of 121 characters', 'Título', 'a'.repeat(121), 'O título passa de 120 caracteres.'],
    ['a title with an invisible character', 'Título', 'Pão​novo', 'O título tem caracteres que não são aceitos.'],
    ['a caption of 2.201 characters', 'Legenda', 'a'.repeat(2201), 'A legenda passa de 2.200 caracteres.'],
    ['a caption with an invisible character', 'Legenda', 'oi‮tchau', 'A legenda tem caracteres que não são aceitos.'],
    ['no day', 'Data', '', 'Informe o dia da publicação.']
  ])('sends nothing for %s, and says why', async (_name, label, value, text) => {
    const { calls } = await openContent(stored());
    type(label, value);
    click('Salvar');
    expect(await within(dialog()).findByText(text)).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it('accepts a title of 120 characters and a caption of 2.200, counted as people count (an emoji is one)', async () => {
    const { calls } = await openContent(stored());
    type('Título', '😀'.repeat(120));
    type('Legenda', '😀'.repeat(2200));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)).toHaveLength(1);
  });

  it('counts the caption as people read it, with the thousands separator', async () => {
    await openContent(stored({ caption: null }));
    expect(within(dialog()).getByText('0/2.200')).toBeTruthy();
    type('Legenda', 'a'.repeat(1204));
    expect(within(dialog()).getByText('1.204/2.200')).toBeTruthy();
    type('Legenda', '😀😀😀');
    expect(within(dialog()).getByText('3/2.200')).toBeTruthy();
  });

  it('shows the post as it is typed: title, caption, format, day (in São Paulo) and time', async () => {
    await openContent(stored({ title: 'Lançamento do pão', caption: 'Pão fresquinho', publishAtTime: null }));
    const preview = within(dialog()).getByRole('figure', { name: 'Prévia do post' });
    expect(within(preview).getByText('@padariacentral')).toBeTruthy();
    expect(within(preview).getByText('Lançamento do pão')).toBeTruthy();
    expect(within(preview).getByText('terça-feira, 20 de outubro de 2026')).toBeTruthy();

    type('Título', 'Pão de queijo');
    type('Legenda', 'Linha 1\nLinha 2');
    type('Formato', 'reels');
    type('Data', '2026-10-25');
    type('Hora', '09:15');
    expect(within(preview).getByText('Pão de queijo')).toBeTruthy();
    expect(within(preview).getByText((_text, element) => element?.tagName === 'P' && element.textContent === 'Linha 1\nLinha 2')).toBeTruthy();
    expect(within(preview).getByText('Reels')).toBeTruthy();
    expect(preview.querySelector('.content-preview__when')?.textContent).toBe('domingo, 25 de outubro de 2026 · 09:15');
    type('Legenda', '');
    expect(within(preview).getByText('Sem legenda')).toBeTruthy();
  });

  it.each([
    ['approved', 'the caption', 'Legenda', 'Outra legenda', true],
    ['approved', 'the format', 'Formato', 'carousel', true],
    ['approved', 'the title only', 'Título', 'Outro título', false],
    ['approved', 'the time only', 'Hora', '10:00', false],
    ['approved', 'the day only', 'Data', '2026-10-27', false],
    ['in_production', 'the caption', 'Legenda', 'Outra legenda', false],
    ['adjusting', 'the caption', 'Legenda', 'Outra legenda', false]
  ] as const)('a %s content, when you change %s, %s the warning that it goes back to waiting for approval', async (status, _what, label, value, warns) => {
    await openContent(stored({ status }));
    type(label, value);
    expect(within(dialog()).queryByText(/o devolve para “Aguardando aprovação”/) !== null).toBe(warns);
  });

  it('names what goes back in the warning of an approved content, and the save is what the API does', async () => {
    const row = stored({ status: 'approved' });
    const { calls, contents } = await openContent(row);
    type('Legenda', 'Outra legenda');
    expect(within(dialog()).getByText('Este conteúdo está aprovado. Mudar a legenda, a mídia, a capa ou o formato o devolve para “Aguardando aprovação”.')).toBeTruthy();
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ caption: 'Outra legenda' });
    expect(contents.find((content) => content.id === row.id)!.status).toBe('awaiting_approval');
  });

  it('warns for a change of the media of an approved content', async () => {
    await openContent(stored({ status: 'approved', format: 'reels', folderId: VIDEOS }));
    expect(within(dialog()).queryByText(/o devolve para “Aguardando aprovação”/)).toBeNull();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Adicionar Vídeo de 06/10' }));
    expect(within(dialog()).queryByText(/o devolve para “Aguardando aprovação”/)).not.toBeNull();
  });

  it('warns for a change of the cover of an approved content, and not for the title beside it', async () => {
    await openContent(stored({ status: 'approved', format: 'reels', folderId: LAUNCH }));
    type('Título', 'Só o título');
    expect(within(dialog()).queryByText(/o devolve para “Aguardando aprovação”/)).toBeNull();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Usar Imagem de 09/10 como capa' }));
    expect(within(dialog()).queryByText(/o devolve para “Aguardando aprovação”/)).not.toBeNull();
  });
});

describe('the folder and the media', () => {
  it('reads every page of folders and of media: the 101st is there', async () => {
    const many = Array.from({ length: 101 }, (_value, index) => folder(`f3f3f3f3-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, `Pasta ${index + 1}`));
    const images = Array.from({ length: 101 }, (_value, index) => asset(100 + index, 'image', '10'));
    const row = stored({ folderId: many[0]!.id });
    const { calls } = await openContent(row, { folders: many, assets: { [many[0]!.id]: images } });
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(102));
    expect(within(field('Pasta') as HTMLSelectElement).getByRole('option', { name: 'Pasta 101' })).toBeTruthy();
    await waitFor(() => expect(within(dialog()).getAllByRole('button', { name: /^Adicionar Imagem de 10\/10$/ })).toHaveLength(101));
    expect(calls.filter((call) => /media-folders\?/.test(call.path)).map((call) => call.path.split('?')[1])).toEqual(['page=1&pageSize=100', 'page=2&pageSize=100']);
  });

  it('names a working folder with the one it lives in', async () => {
    await openContent(stored());
    await within(dialog()).findByLabelText('Pasta');
    const select = field('Pasta') as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Escolha a pasta', 'Vídeos', 'Imagens', 'Vídeos / Lançamento']));
    expect(select.value).toBe(IMAGES);
  });

  it('lists only the media that fits the format: images for an image, videos for a video, both for a carousel', async () => {
    await openContent(stored({ folderId: LAUNCH, format: 'image' }));
    expect(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 09/10' })).toBeTruthy();
    expect(within(dialog()).queryByRole('button', { name: 'Adicionar Vídeo de 08/10' })).toBeNull();
    type('Formato', 'reels');
    expect(within(dialog()).queryByRole('button', { name: 'Adicionar Imagem de 09/10' })).toBeNull();
    expect(within(dialog()).getByRole('button', { name: 'Adicionar Vídeo de 08/10' })).toBeTruthy();
    type('Formato', 'carousel');
    expect(within(dialog()).getByRole('button', { name: 'Adicionar Imagem de 09/10' })).toBeTruthy();
    expect(within(dialog()).getByRole('button', { name: 'Adicionar Vídeo de 08/10' })).toBeTruthy();
  });

  it('says the folder has no media for the format, in its own words', async () => {
    await openContent(stored({ folderId: VIDEOS, format: 'image' }));
    expect(await within(dialog()).findByText('Esta pasta não tem imagens para este formato.')).toBeTruthy();
  });

  it('a format that takes one media replaces it when another is added', async () => {
    const row = stored();
    const { calls } = await openContent(row);
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 03/10' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Adicionar Imagem de 04/10' }));
    expect(within(dialog()).getAllByText(/^Mídia \d$/)).toHaveLength(1);
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ mediaAssetIds: [IMG_2.id] });
  });

  it('a carousel keeps the order that was made by hand, and sends the whole list', async () => {
    const row = stored({ format: 'carousel' });
    const { calls } = await openContent(row);
    for (const label of ['03/10', '04/10', '05/10']) fireEvent.click(await within(dialog()).findByRole('button', { name: `Adicionar Imagem de ${label}` }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mover mídia 3 para antes' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Tirar mídia 1' }));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ mediaAssetIds: [IMG_3.id, IMG_2.id] });
  });

  it('sends the new order when two media of a carousel change places', async () => {
    const row = stored({ format: 'carousel', media: [IMG_1.id, IMG_2.id] });
    const { calls } = await openContent(row);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Mover mídia 2 para antes' }));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ mediaAssetIds: [IMG_2.id, IMG_1.id] });
  });

  it('shows the cover of a video in the preview, and its first video once the cover is off', async () => {
    const cover = asset(7, 'image', '09').id;
    const video = asset(6, 'video', '08').id;
    await openContent(stored({ format: 'reels', folderId: LAUNCH, media: [video], coverAssetId: cover }));
    const preview = within(dialog()).getByRole('figure', { name: 'Prévia do post' });
    await waitFor(() => expect(preview.querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${cover}.jpg`));
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Tirar a capa' }));
    await waitFor(() => expect(preview.querySelector('img')?.getAttribute('src')).toBe(`https://storage.test/${video}.jpg`));
  });

  it('does not offer to add the same media twice', async () => {
    await openContent(stored({ format: 'carousel' }));
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 03/10' }));
    expect((within(dialog()).getByRole('button', { name: 'Adicionar Imagem de 03/10' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends nothing when a format that takes one media has several, and says why', async () => {
    const { calls } = await openContent(stored({ format: 'carousel', media: [IMG_1.id, IMG_2.id] }));
    type('Formato', 'image');
    click('Salvar');
    expect(await within(dialog()).findByText('Este formato leva uma mídia só.')).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it('sends the format and the media of a change of format in the same request', async () => {
    const row = stored({ format: 'image', media: [IMG_1.id] });
    const { calls } = await openContent(row);
    type('Formato', 'carousel');
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 04/10' }));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ format: 'carousel', mediaAssetIds: [IMG_1.id, IMG_2.id] });
  });

  it('a cover belongs to a video only: it is chosen, removed, and gone when the format stops being a video', async () => {
    const row = stored({ format: 'reels', folderId: LAUNCH, media: [] });
    const { calls } = await openContent(row);
    expect(within(dialog()).getByRole('group', { name: 'Capa' })).toBeTruthy();
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Usar Imagem de 09/10 como capa' }));
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ coverAssetId: asset(7, 'image', '09').id });
  });

  it('takes the cover off with null, and drops it when the format becomes an image', async () => {
    const cover = asset(7, 'image', '09').id;
    const row = stored({ format: 'reels', folderId: LAUNCH, coverAssetId: cover });
    const { calls } = await openContent(row);
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Tirar a capa' }));
    expect(within(dialog()).getByText('Sem capa: vale o quadro automático do vídeo.')).toBeTruthy();
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ coverAssetId: null });
  });

  it('drops the cover with the format that has none, in the same request', async () => {
    const cover = asset(7, 'image', '09').id;
    const { calls } = await openContent(stored({ format: 'reels', folderId: LAUNCH, coverAssetId: cover }));
    type('Formato', 'image');
    expect(within(dialog()).queryByRole('group', { name: 'Capa' })).toBeNull();
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ format: 'image', coverAssetId: null });
  });

  it.each([
    ['media', { media: [IMG_1.id] }],
    ['a cover', { format: 'reels' as const, coverAssetId: asset(7, 'image', '09').id, folderId: LAUNCH }]
  ])('keeps the folder while the content has %s, with the reason on screen', async (_name, extra) => {
    await openContent(stored(extra));
    await within(dialog()).findByLabelText('Pasta');
    expect((field('Pasta') as HTMLSelectElement).disabled).toBe(true);
    expect(within(dialog()).getByText('A pasta não muda enquanto o conteúdo tem mídia ou capa.')).toBeTruthy();
    expect(within(dialog()).queryByRole('button', { name: 'Nova pasta' })).toBeNull();
  });

  it('changes the folder of a content with no media, and sends only the folder', async () => {
    const { calls } = await openContent(stored());
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Pasta', VIDEOS);
    click('Salvar');
    await waitFor(closed);
    expect(writes(calls)[0]!.body).toEqual({ folderId: VIDEOS });
  });

  it('creates a folder inside the first level, chooses it, and sends the name and the parent', async () => {
    const { calls } = await openContent(stored());
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    click('Nova pasta');
    type('Nome da pasta', 'Verão');
    type('Dentro de', VIDEOS);
    click('Criar pasta');

    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getByRole('option', { name: 'Vídeos / Verão' })).toBeTruthy());
    expect(calls.filter((call) => call.method === 'POST')[0]).toEqual({
      method: 'POST', path: `/agencies/${AGENCY}/clients/${padaria.id}/media-folders`, body: { name: 'Verão', parentId: VIDEOS }
    });
    expect((field('Pasta') as HTMLSelectElement).selectedOptions[0]!.textContent).toBe('Vídeos / Verão');
    expect(within(dialog()).queryByLabelText('Nome da pasta')).toBeNull();
  });

  it('creates a first-level folder with no parent in the body', async () => {
    const { calls } = await openContent(stored());
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    click('Nova pasta');
    type('Nome da pasta', 'Promoções');
    click('Criar pasta');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getByRole('option', { name: 'Promoções' })).toBeTruthy());
    expect(calls.filter((call) => call.method === 'POST')[0]!.body).toEqual({ name: 'Promoções' });
  });

  it.each([
    ['an empty name', '  ', undefined, 'Informe o nome da pasta.'],
    ['a name with an invisible character', 'Pa​sta', undefined, 'O nome da pasta tem caracteres que não são aceitos, ou passa de 80 caracteres.']
  ])('sends nothing for a folder with %s', async (_name, value, _x, text) => {
    const { calls } = await openContent(stored());
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    click('Nova pasta');
    type('Nome da pasta', value);
    click('Criar pasta');
    expect(await within(dialog()).findByText(text)).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it.each([
    [409, 'CLIENT_ARCHIVED', 'Este cliente está arquivado: não é possível criar pastas.'],
    [403, 'FORBIDDEN', 'Você não tem permissão para criar pastas.'],
    [400, 'VALIDATION_ERROR', 'O nome da pasta tem caracteres que não são aceitos, ou passa de 80 caracteres.'],
    [500, 'INTERNAL', 'Não foi possível criar a pasta. Tente de novo.']
  ])('answers %s %s to a new folder with its own words, and keeps the name', async (status, code, text) => {
    await openContent(stored(), { override: (call) => (call.method === 'POST' && /media-folders$/.test(call.path) ? failure(status, code) : undefined) });
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    click('Nova pasta');
    type('Nome da pasta', 'Verão');
    click('Criar pasta');
    expect(await within(dialog()).findByText(text)).toBeTruthy();
    expect((field('Nome da pasta') as HTMLInputElement).value).toBe('Verão');
  });

  it('shows the error of the folders with "Tentar de novo"', async () => {
    let failing = true;
    await openContent(stored(), { override: (call) => (failing && /media-folders\?/.test(call.path) ? failure(500, 'INTERNAL') : undefined) });
    expect(await within(dialog()).findByText('Não foi possível carregar as pastas. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    failing = false;
    click('Tentar de novo');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
  });

  it('shows the error of the media of the folder with "Tentar de novo"', async () => {
    let failing = true;
    await openContent(stored(), { override: (call) => (failing && /\/assets\?/.test(call.path) ? failure(500, 'INTERNAL') : undefined) });
    expect(await within(dialog()).findByText('Não foi possível carregar as mídias da pasta. Tente de novo.', undefined, { timeout: 5000 })).toBeTruthy();
    failing = false;
    click('Tentar de novo');
    expect(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 03/10' })).toBeTruthy();
  });

  it('draws no way to add media or a folder for who only reads', async () => {
    await openContent(stored(), { permissions: [VISUALIZE, READ_CLIENTS] });
    await waitFor(() => expect((field('Pasta') as HTMLSelectElement).disabled).toBe(true));
    expect(within(dialog()).queryByRole('button', { name: /^Adicionar / })).toBeNull();
    expect(within(dialog()).queryByRole('button', { name: 'Nova pasta' })).toBeNull();
  });
});

describe('creating a content', () => {
  const createButton = (): HTMLElement | null => screen.queryByRole('button', { name: 'Criar conteúdo' });

  it.each([
    ['conteudo.visualizar only', [VISUALIZE, READ_CLIENTS], false],
    ['conteudo.operar with visualizar', EDITOR, true]
  ])('%s: the "Criar conteúdo" button exists only for who operates', async (_name, permissions, shown) => {
    const { impl } = makeFetch({ permissions });
    render_(impl);
    await calendarReady();
    await waitFor(() => expect(createButton() !== null).toBe(shown));
  });

  it('has no "Criar conteúdo" on an archived client', async () => {
    const { impl } = makeFetch();
    render_(impl, base(barbearia.id));
    await calendarReady();
    await screen.findByText('Cliente arquivado: o calendário é só leitura.');
    expect(createButton()).toBeNull();
  });

  it('opens on today in São Paulo, with the address that says so', async () => {
    const { impl } = makeFetch();
    const { probe } = render_(impl);
    await calendarReady();
    fireEvent.click(await screen.findByRole('button', { name: 'Criar conteúdo' }));

    expect(await screen.findByRole('dialog', { name: 'Novo conteúdo' })).toBeTruthy();
    await screen.findByLabelText('Data');
    expect((field('Data') as HTMLInputElement).value).toBe(TODAY);
    expect(probe.pathname).toBe(`${base()}/novo`);
    expect(probe.search).toBe(`?dia=${TODAY}`);
  });

  it('opens from the "Conteúdo" of the + of a day, on that day, and keeps it after a reload', async () => {
    const { impl } = makeFetch();
    const first = render_(impl);
    await calendarReady();
    const plus = within(document.querySelector('time[datetime="2026-10-22"]')!.closest('li')!).getByRole('button', { name: /^Adicionar no dia/ });
    fireEvent.click(plus);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Conteúdo' }));

    expect(await screen.findByRole('dialog', { name: 'Novo conteúdo' })).toBeTruthy();
    await screen.findByLabelText('Data');
    expect((field('Data') as HTMLInputElement).value).toBe('2026-10-22');
    expect(first.probe.search).toBe('?dia=2026-10-22');
    first.unmount();

    render_(impl, `${base()}/novo?dia=2026-10-22`);
    await screen.findByLabelText('Data');
    expect((field('Data') as HTMLInputElement).value).toBe('2026-10-22');
  });

  it('keeps the period of the calendar in the address, and drops the day of the "+" when it closes', async () => {
    const { impl } = makeFetch();
    const { probe } = render_(impl, `${base()}/novo?visao=semana&data=2026-10-21&dia=2026-10-22`);
    await screen.findByLabelText('Data');
    click('Cancelar');
    await waitFor(closed);
    expect(probe.pathname).toBe(base());
    expect(probe.search).toBe('?visao=semana&data=2026-10-21');
  });

  it.each(['2026-02-30', 'amanhã', ''])('falls back to today when the day of the address is "%s"', async (day) => {
    const { impl } = makeFetch();
    render_(impl, `${base()}/novo?dia=${day}`);
    await screen.findByLabelText('Data');
    expect((field('Data') as HTMLInputElement).value).toBe(TODAY);
  });

  it('sends the content as typed, closes, and the new card is on the calendar', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, `${base()}/novo?dia=2026-10-22`);
    await screen.findByLabelText('Título');
    type('Título', '  Pão de queijo  ');
    type('Formato', 'reels');
    type('Hora', '09:15');
    type('Legenda', 'Quentinho');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Pasta', VIDEOS);
    click('Criar conteúdo');

    await waitFor(closed);
    expect(writes(calls)).toEqual([{
      method: 'POST',
      path: `/agencies/${AGENCY}/clients/${padaria.id}/contents`,
      body: { title: '  Pão de queijo  ', format: 'reels', publishOn: '2026-10-22', publishAtTime: '09:15', caption: 'Quentinho', folderId: VIDEOS }
    }]);
    expect(await screen.findByRole('link', { name: 'Pão de queijo' })).toBeTruthy();
  });

  it('asks for the folder before sending anything', async () => {
    const { impl, calls } = makeFetch();
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    type('Título', 'Sem pasta');
    click('Criar conteúdo');
    expect(await within(dialog()).findByText('Escolha a pasta.')).toBeTruthy();
    expect(writes(calls)).toHaveLength(0);
  });

  it.each([
    ['a refused title', () => invalidField('title'), 'O título não foi aceito. Revise o texto.'],
    ['an archived client', () => failure(409, 'CLIENT_ARCHIVED'), 'Este cliente está arquivado: o conteúdo é só leitura.'],
    ['a client that is gone', () => failure(404, 'NOT_FOUND'), 'Este cliente não existe mais.'],
    ['a lost race', () => failure(409, 'TRY_AGAIN'), 'Outra alteração aconteceu ao mesmo tempo. Salve de novo.']
  ])('answers %s with its own words, keeps the modal open and what was typed', async (_name, answer, text) => {
    const { impl } = makeFetch({ override: (call) => (call.method === 'POST' ? answer() : undefined) });
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Título', 'Pão novo');
    type('Pasta', IMAGES);
    click('Criar conteúdo');

    expect((await within(dialog()).findAllByText(text)).length).toBeGreaterThan(0);
    expect(screen.queryByText('MENSAGEM DO SERVIDOR')).toBeNull();
    expect((field('Título') as HTMLInputElement).value).toBe('Pão novo');
    expect((field('Pasta') as HTMLSelectElement).value).toBe(IMAGES);
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('creates once and sends only the rest again when the media of the first try is refused', async () => {
    let refusing = true;
    const { impl, calls, contents } = makeFetch({
      override: (call) => (refusing && call.method === 'PATCH' ? failure(409, 'TRY_AGAIN') : undefined)
    });
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    await waitFor(() => expect(within(field('Pasta') as HTMLSelectElement).getAllByRole('option')).toHaveLength(4));
    type('Título', 'Pão novo');
    type('Pasta', IMAGES);
    fireEvent.click(await within(dialog()).findByRole('button', { name: 'Adicionar Imagem de 04/10' }));
    click('Criar conteúdo');

    expect(await within(dialog()).findByText(/O conteúdo já foi criado: ao salvar de novo, só o que falta é enviado\./)).toBeTruthy();
    expect(contents).toHaveLength(1);
    refusing = false;
    // The content exists now: the button says so, and saving edits it.
    click('Salvar');
    await waitFor(closed);

    expect(writes(calls).map((call) => call.method)).toEqual(['POST', 'PATCH', 'PATCH']);
    expect(contents).toHaveLength(1);
    expect(contents[0]!.media).toEqual([IMG_2.id]);
    expect(writes(calls)[2]!.path).toBe(contentPath(contents[0]!.id));
    expect(writes(calls)[2]!.body).toEqual({ mediaAssetIds: [IMG_2.id] });
  });

  it.each([
    ['conteudo.visualizar only', [VISUALIZE, READ_CLIENTS], 'Você não tem permissão para criar conteúdos.'],
  ])('shows no form to who cannot create (%s)', async (_name, permissions, text) => {
    const { impl } = makeFetch({ permissions });
    render_(impl, `${base()}/novo`);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('shows no form on an archived client, and says why', async () => {
    const { impl } = makeFetch();
    render_(impl, `${base(barbearia.id)}/novo`);
    expect(await screen.findByText('Este cliente está arquivado: não recebe conteúdo novo.')).toBeTruthy();
    expect(screen.queryByLabelText('Título')).toBeNull();
  });

  it('does not show a form before it knows who the client is', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { impl } = makeFetch({
      override: (call) => (call.method === 'GET' && call.path === `/agencies/${AGENCY}/clients/${padaria.id}` ? held.then(() => undefined) as never : undefined)
    });
    render_(impl, `${base()}/novo`);
    await screen.findByRole('dialog', { name: 'Novo conteúdo' });
    expect(screen.queryByText('Você não tem permissão para criar conteúdos.')).toBeNull();
    expect(screen.queryByLabelText('Título')).toBeNull();
    release();
    expect(await screen.findByLabelText('Título')).toBeTruthy();
  });
});

describe('the conversation of the content (#266)', () => {
  const LATE = '2026-10-13T01:30:00.000Z';
  const IN_PRODUCTION = 'A conversa só aceita mensagens a partir de "Aguardando aprovação"; este conteúdo ainda está em produção.';
  const CANCELLED = 'Este conteúdo foi cancelado: a conversa não recebe mais mensagens.';
  const NOT_OPEN = 'A conversa só aceita mensagens a partir de "Aguardando aprovação". Este conteúdo está em produção ou foi cancelado.';
  const awaiting = (overrides: Partial<Stored> = {}): Stored => stored({ status: 'awaiting_approval', ...overrides });
  const withThread = (row: Stored, comments: ReadonlyArray<{ side: 'agency' | 'client'; body: string; at: string }>): Scenario['seedConversation'] =>
    (conversation) => { conversation.seed({ contentId: row.id }, comments); };
  const conversationOf = async (row: Stored): Promise<HTMLElement> => await screen.findByRole('region', { name: `Conversa sobre ${row.title}` });
  const threadDialog = async (row: Stored): Promise<HTMLElement> => await screen.findByRole('dialog', { name: `Conversa sobre ${row.title}` });
  const openThread = async (row: Stored, excerpt: RegExp | string): Promise<HTMLElement> => {
    fireEvent.click(await within(await conversationOf(row)).findByRole('button', { name: excerpt }));
    return await threadDialog(row);
  };

  it('sits at the end of the Geral tab, after the form and outside it', async () => {
    const row = awaiting();
    await openContent(row);
    const region = await conversationOf(row);
    const form = dialog().querySelector('form.content-modal__form')!;
    expect(form.contains(region)).toBe(false);
    expect(region.closest('[role="tabpanel"]')?.getAttribute('aria-label')).toBe('Geral');
    expect(form.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(region).getByRole('heading', { name: 'Conversa' })).toBeTruthy();
    await within(region).findByText('Nenhuma conversa sobre este conteúdo');
  });

  it('is not there while the content is not created yet', async () => {
    const { impl } = makeFetch();
    render_(impl, `${base()}/novo`);
    await screen.findByLabelText('Título');
    expect(screen.queryByRole('region', { name: /Conversa/ })).toBeNull();
  });

  it('shows the thread of this content only, with the side and the day in São Paulo, and no id on the screen', async () => {
    const row = awaiting();
    const other = awaiting({ title: 'Outro conteúdo' });
    await openContent(row, {
      contents: [other],
      seedConversation: (conversation) => {
        conversation.seed({ contentId: other.id }, [{ side: 'client', body: 'Mensagem do outro conteúdo', at: LATE }]);
        conversation.seed({ contentId: row.id }, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]);
      }
    });
    const region = await conversationOf(row);
    await within(region).findByText('Gostei, mas troquem a foto');
    expect(within(region).queryByText('Mensagem do outro conteúdo')).toBeNull();
    const thread = await openThread(row, /Gostei, mas troquem a foto/);
    await within(thread).findByText('Gostei, mas troquem a foto');
    expect(Array.from(thread.querySelectorAll('.conversation__comment-meta')).map((meta) => meta.textContent)).toEqual(['Maria · cliente · 12/10 22:30']);
    expect(region.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(thread.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('starts the conversation of the content, writes it as the content\'s, and reads the calendar again', async () => {
    const row = awaiting();
    const { calls } = await openContent(row);
    const region = await conversationOf(row);
    await calendarReady();
    const before = periodCalls(calls).length;

    fireEvent.click(await within(region).findByRole('button', { name: `Nova conversa sobre ${row.title}` }));
    const opening = await screen.findByRole('dialog', { name: `Nova conversa sobre ${row.title}` });
    fireEvent.change(within(opening).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Podemos usar outra foto?' } });
    fireEvent.click(within(opening).getByRole('button', { name: 'Iniciar conversa' }));

    await within(region).findByText('Podemos usar outra foto?');
    expect(writes(calls)).toEqual([{ method: 'POST', path: `/agencies/${AGENCY}/clients/${padaria.id}/threads`, body: { subject: { contentId: row.id }, body: 'Podemos usar outra foto?' } }]);
    await waitFor(() => expect(periodCalls(calls).length).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog', { name: `Nova conversa sobre ${row.title}` })).toBeNull();
    expect(screen.getByRole('dialog', { name: row.title })).toBeTruthy();
  });

  it('answers a thread without saving the content or closing its modal', async () => {
    const row = awaiting();
    const { calls, probe } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]) });
    const thread = await openThread(row, /Gostei, mas troquem a foto/);

    fireEvent.change(within(thread).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Trocamos hoje' } });
    fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
    await within(thread).findByText('Trocamos hoje');
    // A submit that also reached the form of the content would save it and close the modal a moment later.
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    expect(probe.pathname).toBe(`${base()}/${row.id}`);

    expect(writes(calls).map((call) => `${call.method} ${call.path.replace(/threads\/[^/]+/, 'threads/:id')}`)).toEqual([
      `POST /agencies/${AGENCY}/clients/${padaria.id}/threads/:id/comments`
    ]);
    expect(screen.getByRole('dialog', { name: row.title })).toBeTruthy();
    expect((within(screen.getByRole('dialog', { name: row.title })).getByLabelText('Título') as HTMLInputElement).value).toBe(row.title);
  });

  it('keeps what was typed when the answer is refused, and clears it when it goes through', async () => {
    const row = awaiting();
    const { conversation } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]) });
    const thread = await openThread(row, /Gostei, mas troquem a foto/);
    const box = (): HTMLTextAreaElement => within(thread).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement;

    conversation.failNextWrite(() => failure(500, 'INTERNAL_ERROR'));
    fireEvent.change(box(), { target: { value: 'Trocamos hoje' } });
    fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
    await within(thread).findByText('Não foi possível enviar. Tente de novo.');
    expect(box().value).toBe('Trocamos hoje');

    fireEvent.click(within(thread).getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => expect(box().value).toBe(''));
    await within(thread).findByText('Trocamos hoje');
  });

  it('refuses a text the rule refuses, in the screen\'s words, and sends nothing', async () => {
    const row = awaiting();
    const { calls } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei', at: LATE }]) });
    const thread = await openThread(row, /Gostei/);
    fireEvent.change(within(thread).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'texto ‮oculto' } });
    fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
    expect(within(thread).getByText('O texto contém caracteres que não são aceitos.')).toBeTruthy();
    expect(writes(calls)).toEqual([]);
  });

  it('shows what a client wrote as text, even when it looks like markup', async () => {
    const row = awaiting();
    const hostile = '<script>window.__hacked = 1</script><img src="x" onerror="window.__hacked = 2">';
    await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: hostile, at: LATE }]) });
    const thread = await openThread(row, /script/);
    await within(thread).findByText(hostile);
    expect(thread.querySelector('script, img')).toBeNull();
    expect(screen.getByRole('dialog', { name: row.title }).querySelector('.content-modal__conversation script, .content-modal__conversation img')).toBeNull();
    expect((window as unknown as { __hacked?: number }).__hacked).toBeUndefined();
  });

  describe('who may write', () => {
    it('reads and nothing else with only conteudo.visualizar: no composer, no Resolver, no new conversation', async () => {
      const row = awaiting();
      const empty = awaiting({ title: 'Sem conversa' });
      const { calls } = await openContent(row, {
        permissions: [VISUALIZE, READ_CLIENTS],
        contents: [empty],
        seedConversation: withThread(row, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }])
      });
      const region = await conversationOf(row);
      expect(within(region).queryByRole('button', { name: /Nova conversa/ })).toBeNull();
      const thread = await openThread(row, /Gostei, mas troquem a foto/);
      await within(thread).findByText('Gostei, mas troquem a foto');
      expect(within(thread).getByText('Esta conversa é somente leitura.')).toBeTruthy();
      expect(within(thread).queryByRole('textbox')).toBeNull();
      expect(within(thread).queryByRole('button', { name: 'Responder' })).toBeNull();
      expect(within(thread).queryByRole('button', { name: 'Resolver' })).toBeNull();
      expect(writes(calls)).toEqual([]);
    });

    it('offers no way to start a conversation with only conteudo.visualizar', async () => {
      const row = awaiting();
      await openContent(row, { permissions: [VISUALIZE, READ_CLIENTS] });
      const region = await conversationOf(row);
      await within(region).findByText('Nenhuma conversa sobre este conteúdo');
      expect(within(region).queryByRole('button')).toBeNull();
    });

    it('resolves with conteudo.operar and conteudo.visualizar, and the thread reads as resolved', async () => {
      const row = awaiting();
      const other = awaiting({ title: 'Outro conteúdo' });
      const ids: { mine?: string; other?: string } = {};
      const { calls, conversation } = await openContent(row, {
        contents: [other],
        seedConversation: (fake) => {
          ids.other = fake.seed({ contentId: other.id }, [{ side: 'client', body: 'Mensagem do outro conteúdo', at: LATE }]);
          ids.mine = fake.seed({ contentId: row.id }, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]);
        }
      });
      const thread = await openThread(row, /Gostei, mas troquem a foto/);
      fireEvent.click(within(thread).getByRole('button', { name: 'Resolver' }));
      await within(thread).findByText(/Resolvida por Ana em /);
      expect(writes(calls).map((call) => call.path)).toEqual([`/agencies/${AGENCY}/clients/${padaria.id}/threads/${ids.mine}/resolve`]);
      expect(conversation.threads.find((candidate) => candidate.id === ids.other)?.resolvedAt).toBeNull();
    });

    it('is read-only on an archived client', async () => {
      const row = awaiting({ clientId: barbearia.id });
      const { impl, calls } = makeFetch({
        contents: [row],
        seedConversation: (_padaria, forClient) => { forClient(barbearia.id).seed({ contentId: row.id }, [{ side: 'client', body: 'Gostei', at: LATE }]); }
      });
      render_(impl, `${base(barbearia.id)}/${row.id}`);
      await screen.findByLabelText('Título');
      const thread = await openThread(row, /Gostei/);
      await within(thread).findByText('Gostei');
      expect(within(thread).getByText('Esta conversa é somente leitura.')).toBeTruthy();
      expect(within(thread).queryByRole('textbox')).toBeNull();
      expect(within(thread).queryByRole('button', { name: 'Resolver' })).toBeNull();
      expect(writes(calls)).toEqual([]);
    });
  });

  describe('where the agency writes: every state of the content, written by hand', () => {
    // The API takes a message in every state but production and cancelled (decision 2026-10-11, item 4): "em ajuste" is
    // where the client asked for a change by the conversation and the agency has to answer it.
    const WRITES = ['awaiting_approval', 'adjusting', 'approved', 'published'] as const;
    const REFUSES: ReadonlyArray<readonly ['in_production' | 'cancelled', string]> = [['in_production', IN_PRODUCTION], ['cancelled', CANCELLED]];

    it.each(WRITES)('answers in a %s content: the reply box, Responder and no reason', async (state) => {
      const row = stored({ status: state });
      const { calls } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]) });
      const region = await conversationOf(row);
      expect(within(region).queryByText(IN_PRODUCTION)).toBeNull();
      expect(within(region).queryByText(CANCELLED)).toBeNull();
      const thread = await openThread(row, /Gostei, mas troquem a foto/);
      expect(within(thread).queryByText(IN_PRODUCTION)).toBeNull();
      expect(within(thread).queryByText(CANCELLED)).toBeNull();

      fireEvent.change(within(thread).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Trocamos hoje' } });
      fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
      await within(thread).findByText('Trocamos hoje');
      expect(writes(calls).map((call) => call.path.split('/').pop())).toEqual(['comments']);
    });

    it.each(WRITES)('starts the conversation of a %s content, with no reason', async (state) => {
      const row = stored({ status: state });
      const { calls } = await openContent(row);
      const region = await conversationOf(row);
      await within(region).findByText('Nenhuma conversa sobre este conteúdo');
      expect(within(region).queryByText(IN_PRODUCTION)).toBeNull();
      expect(within(region).queryByText(CANCELLED)).toBeNull();

      fireEvent.click(within(region).getByRole('button', { name: `Nova conversa sobre ${row.title}` }));
      const opening = await screen.findByRole('dialog', { name: `Nova conversa sobre ${row.title}` });
      fireEvent.change(within(opening).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Podemos usar outra foto?' } });
      fireEvent.click(within(opening).getByRole('button', { name: 'Iniciar conversa' }));
      await within(region).findByText('Podemos usar outra foto?');
      expect(writes(calls).map((call) => call.path.split('/').pop())).toEqual(['threads']);
    });

    it.each(REFUSES)('refuses in a %s content: the reason, no reply box and no new conversation', async (state, reason) => {
      const row = stored({ status: state });
      const other = stored({ status: state, title: 'Sem conversa' });
      const { calls } = await openContent(row, { contents: [other], seedConversation: withThread(row, [{ side: 'client', body: 'Gostei', at: LATE }]) });
      const region = await conversationOf(row);
      expect(await within(region).findByText(reason)).toBeTruthy();
      const thread = await openThread(row, /Gostei/);
      expect(within(thread).getByText(reason)).toBeTruthy();
      expect(within(thread).queryByRole('textbox')).toBeNull();
      expect(within(thread).queryByRole('button', { name: 'Responder' })).toBeNull();
      expect(writes(calls)).toEqual([]);
    });
  });

  it('shows the conversation of the content that was opened, never the one of the content opened before it while its answer is on its way', async () => {
    const first = awaiting({ title: 'Primeiro conteúdo' });
    const second = awaiting({ title: 'Segundo conteúdo' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const { probe } = await openContent(first, {
      contents: [second],
      seedConversation: (conversation) => {
        conversation.seed({ contentId: first.id }, [{ side: 'client', body: 'Mensagem do primeiro', at: LATE }]);
        conversation.seed({ contentId: second.id }, [{ side: 'client', body: 'Mensagem do segundo', at: LATE }]);
      },
      override: (call) => (call.method === 'GET' && call.path.includes('/threads?') && call.path.includes(`contentId=${second.id}`) ? held.then(() => undefined) as never : undefined)
    });
    const region = await conversationOf(first);
    await within(region).findByText('Mensagem do primeiro');

    probe.navigate(`${base()}/${second.id}`);
    const next = await conversationOf(second);
    expect(next.querySelector('.conversation__threads-skeleton')?.getAttribute('aria-busy')).toBe('true');
    expect(next.textContent).not.toContain('Mensagem do primeiro');
    expect(within(next).queryByRole('button', { name: /Mensagem do primeiro/ })).toBeNull();

    release();
    await within(next).findByText('Mensagem do segundo');
    expect(next.textContent).not.toContain('Mensagem do primeiro');
  });

  describe('a content that is not open to the client', () => {
    it.each([
      ['in_production', IN_PRODUCTION],
      ['cancelled', CANCELLED]
    ] as const)('says why nobody writes to a %s content, still reads it and still resolves', async (status, reason) => {
      const row = stored({ status });
      const { calls } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei, mas troquem a foto', at: LATE }]) });
      const region = await conversationOf(row);
      expect(await within(region).findByText(reason)).toBeTruthy();
      const thread = await openThread(row, /Gostei, mas troquem a foto/);
      expect(within(thread).getByText(reason)).toBeTruthy();
      expect(within(thread).queryByRole('textbox')).toBeNull();
      expect(within(thread).queryByRole('button', { name: 'Responder' })).toBeNull();
      fireEvent.click(within(thread).getByRole('button', { name: 'Resolver' }));
      await within(thread).findByText(/Resolvida por Ana em /);
      expect(writes(calls)).toHaveLength(1);
    });

    it.each([
      ['in_production', IN_PRODUCTION],
      ['cancelled', CANCELLED]
    ] as const)('offers no new conversation on a %s content, and says why', async (status, reason) => {
      const row = stored({ status });
      await openContent(row);
      const region = await conversationOf(row);
      await within(region).findByText('Nenhuma conversa sobre este conteúdo');
      expect(within(region).getByText(reason)).toBeTruthy();
      expect(within(region).queryByRole('button')).toBeNull();
    });

    it('does not tell who only reads that the content is in production: that person reads "somente leitura"', async () => {
      const row = stored({ status: 'in_production' });
      await openContent(row, { permissions: [VISUALIZE, READ_CLIENTS], seedConversation: withThread(row, [{ side: 'client', body: 'Gostei', at: LATE }]) });
      const region = await conversationOf(row);
      const thread = await openThread(row, /Gostei/);
      expect(within(region).queryByText(IN_PRODUCTION)).toBeNull();
      expect(within(thread).queryByText(IN_PRODUCTION)).toBeNull();
      expect(within(thread).getByText('Esta conversa é somente leitura.')).toBeTruthy();
    });

    it('says it with the words of the screen when the API refuses a message the screen thought was open, and keeps the text', async () => {
      const row = awaiting();
      const { calls } = await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei', at: LATE }]) });
      const thread = await openThread(row, /Gostei/);
      // Another operator sent it back to production after this screen opened.
      row.status = 'in_production';
      await calendarReady();
      const before = periodCalls(calls).length;

      fireEvent.change(within(thread).getByRole('textbox', { name: 'Escrever resposta' }), { target: { value: 'Texto que não pode sumir' } });
      fireEvent.click(within(thread).getByRole('button', { name: 'Responder' }));
      await within(thread).findByText(NOT_OPEN);
      expect((within(thread).getByRole('textbox', { name: 'Escrever resposta' }) as HTMLTextAreaElement).value).toBe('Texto que não pode sumir');
      expect(writes(calls).map((call) => call.method)).toEqual(['POST']);
      await waitFor(() => expect(periodCalls(calls).length).toBeGreaterThan(before));
      expect(screen.getByRole('dialog', { name: row.title })).toBeTruthy();
    });

    it('says it too when the API refuses to open the conversation', async () => {
      const row = awaiting();
      await openContent(row);
      const region = await conversationOf(row);
      await within(region).findByText('Nenhuma conversa sobre este conteúdo');
      row.status = 'in_production';
      fireEvent.click(within(region).getByRole('button', { name: `Nova conversa sobre ${row.title}` }));
      const opening = await screen.findByRole('dialog', { name: `Nova conversa sobre ${row.title}` });
      fireEvent.change(within(opening).getByRole('textbox', { name: 'Escreva a primeira mensagem' }), { target: { value: 'Texto que não pode sumir' } });
      fireEvent.click(within(opening).getByRole('button', { name: 'Iniciar conversa' }));
      await within(opening).findByText(NOT_OPEN);
      expect((within(opening).getByRole('textbox', { name: 'Escreva a primeira mensagem' }) as HTMLTextAreaElement).value).toBe('Texto que não pode sumir');
    });
  });

  it('closes only the conversation with Esc, and the content stays open', async () => {
    const row = awaiting();
    await openContent(row, { seedConversation: withThread(row, [{ side: 'client', body: 'Gostei', at: LATE }]) });
    const thread = await openThread(row, /Gostei/);
    fireEvent(thread, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `Conversa sobre ${row.title}` })).toBeNull());
    expect(screen.getByRole('dialog', { name: row.title })).toBeTruthy();
  });
});
