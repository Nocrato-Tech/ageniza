import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within, type RenderResult } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';

import {
  ApproveContentByAgencyRequestSchema,
  CreateContentRequestSchema,
  CreateMediaFolderRequestSchema,
  PublishContentRequestSchema,
  RescheduleContentRequestSchema,
  UpdateContentRequestSchema
} from '@ageniza/contracts';

import { createConversationApi } from './conversation-fixture.js';
import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';
import { useCommittedLocation } from './location-probe-fixture.js';

/** The hooks every test of the content modal needs: a dialog that opens, and a clock fixed on the night of the 11th in São Paulo. */
export const setupModalTests = (): void => {
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
};

export const TODAY = '2026-10-11';

const MOVE_PERMISSIONS: Readonly<Record<string, string>> = {
  '/submit': 'conteudo.operar',
  '/approve-by-agency': 'conteudo.aprovar_pela_agencia',
  '/publish': 'conteudo.publicar',
  '/unpublish': 'conteudo.publicar',
  '/cancel': 'conteudo.cancelar',
  '/reschedule': 'conteudo.operar'
};

export const AGENCY = '11111111-1111-4111-8111-111111111111';
export const USER = '99999999-9999-4999-8999-999999999999';
export const sessionBody = { user: { id: USER, name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const failure = (status: number, code: string, message = 'MENSAGEM DO SERVIDOR'): Response => json({ error: { code, message } }, status);
export const invalidField = (path: string): Response =>
  json({ error: { code: 'VALIDATION_ERROR', message: 'MENSAGEM DO SERVIDOR', details: { issues: [{ path, code: 'custom', message: 'MENSAGEM DO SERVIDOR' }] } } }, 400);

export const VISUALIZE = 'conteudo.visualizar';
export const OPERATE = 'conteudo.operar';
export const READ_CLIENTS = 'cliente.visualizar';
export const EDITOR = [VISUALIZE, OPERATE, READ_CLIENTS];

export const client = (id: string, name: string, status: 'active' | 'archived' = 'active') =>
  ({ id, name, photoUrl: null, instagramHandle: name === 'Padaria Central' ? 'padariacentral' : null, status, closingDate: null, threadsAwaitingAgency: 0 });
export const padaria = client('1a1a1a1a-1111-4111-8111-111111111111', 'Padaria Central');
export const barbearia = client('3c3c3c3c-3333-4333-8333-333333333333', 'Barbearia Lima', 'archived');
export const ROSTER = [padaria, barbearia];

export const clientDetail = (row: ReturnType<typeof client>) => ({
  id: row.id, name: row.name, status: row.status, photoUrl: row.photoUrl, instagramHandle: row.instagramHandle, closingDate: row.closingDate,
  legalName: null, taxId: null, segment: null, website: null, contactName: null, contactPhone: null, contactEmail: null,
  archivedAt: row.status === 'archived' ? '2026-10-01T00:00:00.000Z' : null,
  summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 0 }
});

export const VIDEOS = 'f1f1f1f1-0000-4000-8000-000000000001';
export const IMAGES = 'f1f1f1f1-0000-4000-8000-000000000002';
export const LAUNCH = 'f1f1f1f1-0000-4000-8000-000000000003';
export const folder = (id: string, name: string, parentId: string | null = null) => ({ id, parentId, name, isDefault: parentId === null, createdAt: '2026-10-01T12:00:00.000Z' });
export const FOLDERS = [folder(VIDEOS, 'Vídeos'), folder(IMAGES, 'Imagens'), folder(LAUNCH, 'Lançamento', VIDEOS)];

export const asset = (n: number, category: 'image' | 'video', day: string) => ({
  id: `a0a0a0a0-0000-4000-8000-${String(n).padStart(12, '0')}`,
  category,
  contentType: category === 'image' ? 'image/jpeg' : 'video/mp4',
  sizeBytes: 1000,
  videoProcessingStatus: category === 'video' ? 'ready' : 'not_applicable',
  createdAt: `2026-10-${day}T15:00:00.000Z`
});
export const IMG_1 = asset(1, 'image', '03');
export const IMG_2 = asset(2, 'image', '04');
export const IMG_3 = asset(3, 'image', '05');
export const VID_1 = asset(4, 'video', '06');
export const VID_2 = asset(5, 'video', '07');
export const ASSETS: Readonly<Record<string, ReadonlyArray<ReturnType<typeof asset>>>> = {
  [VIDEOS]: [VID_1, VID_2],
  [IMAGES]: [IMG_1, IMG_2, IMG_3],
  [LAUNCH]: [asset(6, 'video', '08'), asset(7, 'image', '09')]
};

export type Format = 'image' | 'carousel' | 'reels' | 'long_video' | 'vsl';
export type Status = 'in_production' | 'awaiting_approval' | 'adjusting' | 'approved' | 'published' | 'cancelled';
export interface Stored {
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
  /** The state of each subtask of the content. */
  tasks: Array<'pending' | 'delivered' | 'approved'>;
  publishedOn: string | null;
}

let counter = 0;
export const stored = (overrides: Partial<Stored> = {}): Stored => {
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
    tasks: [],
    publishedOn: null,
    ...overrides
  };
};

export const detailOf = (row: Stored) => ({
  id: row.id, clientId: row.clientId, title: row.title, platform: 'instagram', format: row.format, publishOn: row.publishOn,
  publishAtTime: row.publishAtTime, caption: row.caption, folderId: row.folderId, coverAssetId: row.coverAssetId, owner: { membershipId: 'e0e0e0e0-0000-4000-8000-000000000001', name: 'Ana Souza' },
  status: row.status, revision: row.revision, approvedBy: null, approvedAt: null, approvedByAgencyReason: null, publishedOn: row.publishedOn,
  cancelledAt: null, createdAt: '2026-10-01T12:00:00.000Z',
  media: row.media.map((id, index) => ({ id, position: index + 1 })), tasks: row.tasks.map((status, index) => ({
    id: `b0b0b0b0-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, title: `Subtarefa ${index + 1}`, description: null,
    assignee: { membershipId: 'e0e0e0e0-0000-4000-8000-000000000001', name: 'Ana Souza' }, dueOn: '2026-10-15', status, returnComment: null, approvedBy: null, approvedAt: null
  })),
  conversation: { threadId: null, commentCount: 0, lastCommentAt: null }
});

export const listItemOf = (row: Stored) => ({
  id: row.id, title: row.title, platform: 'instagram', format: row.format, publishOn: row.publishOn, publishAtTime: row.publishAtTime,
  status: row.status, owner: { membershipId: 'e0e0e0e0-0000-4000-8000-000000000001', name: 'Ana Souza' }, coverAssetId: row.coverAssetId, revision: row.revision, publishedOn: null, tasksTotal: 0, tasksApproved: 0
});

export type ConversationFake = ReturnType<typeof createConversationApi>;

export interface Call { readonly method: string; readonly path: string; readonly body: unknown }

export interface Scenario {
  readonly permissions?: readonly string[];
  readonly contents?: readonly Stored[];
  readonly folders?: ReadonlyArray<ReturnType<typeof folder>>;
  readonly assets?: Readonly<Record<string, ReadonlyArray<ReturnType<typeof asset>>>>;
  /** Fills the conversation routes before the screen reads them (the thread of a content, its messages). */
  readonly seedConversation?: (conversation: ConversationFake, forClient: (clientId: string) => ConversationFake) => void;
  /** Answers instead of the fake for a request, when it returns a response. */
  readonly override?: (call: Call, calls: readonly Call[]) => Response | Promise<Response> | undefined;
}

export const PAGE_MAX = 100;
export const paged = <T,>(rows: readonly T[], url: URL) => {
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
export const makeFetch = (scenario: Scenario = {}) => {
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
      return json({ agencyId: AGENCY, agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Papel' }, permissions });
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

    const scoped = /\/agencies\/[^/]+\/clients\/([^/]+)\/(contents|media-folders)(?:\/([^/]+))?(\/assets|\/submit|\/approve-by-agency|\/publish|\/unpublish|\/cancel|\/reschedule)?$/.exec(url.pathname);
    if (scoped === null) throw new Error(`unexpected ${method} ${url}`);
    const clientId = scoped[1]!;
    const row = ROSTER.find((candidate) => candidate.id === clientId);
    const write = method !== 'GET';
    // Each move has its own permission, and a write needs conteudo.visualizar with it.
    const needed = scoped[2] === 'contents' && scoped[4] !== undefined ? MOVE_PERMISSIONS[scoped[4]] : undefined;
    if (!permissions.includes(VISUALIZE) || (needed === undefined ? write && !permissions.includes(OPERATE) : !permissions.includes(needed))) return failure(403, 'FORBIDDEN');
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
    if (method === 'POST' && scoped[4] !== undefined) {
      const state = (): Response => failure(409, 'CONTENT_STATE');
      switch (scoped[4]) {
        case '/submit': {
          if (found.status !== 'in_production' && found.status !== 'adjusting') return state();
          if (found.tasks.some((task) => task !== 'approved')) return failure(409, 'CONTENT_TASKS_NOT_APPROVED');
          const inFolder = assets[found.folderId] ?? [];
          const items = found.media.map((id) => inFolder.find((candidate) => candidate.id === id));
          const complete = found.format === 'carousel'
            ? items.length >= 2 && items.length <= 20 && items.every((item) => item !== undefined)
            : items.length === 1 && items[0]?.category === (found.format === 'image' ? 'image' : 'video');
          if (!complete) return failure(409, 'CONTENT_MEDIA_INCOMPLETE');
          found.status = 'awaiting_approval';
          break;
        }
        case '/approve-by-agency': {
          const parsed = ApproveContentByAgencyRequestSchema.safeParse(body);
          if (!parsed.success) return invalidField('reason');
          if (found.status !== 'awaiting_approval') return state();
          if (parsed.data.revision !== found.revision) return failure(409, 'CONTENT_REVISION_CHANGED');
          found.status = 'approved';
          break;
        }
        case '/publish': {
          const parsed = PublishContentRequestSchema.safeParse(body ?? {});
          if (!parsed.success) return invalidField('publishedOn');
          if (found.status !== 'approved') return state();
          if ((parsed.data.publishedOn ?? TODAY) > TODAY) return failure(400, 'CONTENT_PUBLISHED_ON_INVALID');
          found.status = 'published';
          found.publishedOn = parsed.data.publishedOn ?? TODAY;
          break;
        }
        case '/unpublish':
          if (found.status !== 'published') return state();
          found.status = 'approved';
          found.publishedOn = null;
          break;
        case '/cancel':
          if (found.status === 'published' || found.status === 'cancelled') return state();
          found.status = 'cancelled';
          break;
        default: {
          const parsed = RescheduleContentRequestSchema.safeParse(body ?? {});
          if (!parsed.success) return invalidField('publishOn');
          if (found.status !== 'cancelled') return state();
          found.status = 'in_production';
          if (parsed.data.publishOn !== undefined) found.publishOn = parsed.data.publishOn;
        }
      }
      return json(detailOf(found));
    }
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

export interface Probe { pathname: string; search: string; state: unknown; navigate: NavigateFunction }

function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.state = location.state;
    probe.navigate = navigate;
  });
  return null;
}

export const base = (clientId = padaria.id) => `/agencia/${AGENCY}/conteudos/${clientId}`;

export const render_ = (impl: typeof fetch, entry: string | { pathname: string; state: unknown } = base()): RenderResult & { probe: Probe } => {
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

export const dialog = (): HTMLElement => screen.getByRole('dialog');
export const field = (label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => within(dialog()).getByLabelText(label) as HTMLInputElement;
export const type = (label: string, value: string): void => { fireEvent.change(field(label), { target: { value } }); };
export const click = (name: string | RegExp): void => { fireEvent.click(within(dialog()).getByRole('button', { name })); };
export const writes = (calls: readonly Call[]): Call[] => calls.filter((call) => call.method !== 'GET');
export const periodCalls = (calls: readonly Call[]): Call[] => calls.filter((call) => /\/contents\?/.test(call.path));
export const contentPath = (id: string) => `/agencies/${AGENCY}/clients/${padaria.id}/contents/${id}`;
export const calendarReady = (): Promise<HTMLElement> => waitFor(() => {
  const calendar = document.querySelector<HTMLElement>('.content-calendar');
  if (calendar === null) throw new Error('The calendar has not rendered yet.');
  return calendar;
});

/** Opens the content straight from its address and waits for the form. */
export const openContent = async (row: Stored, scenario: Scenario = {}, entry?: string): Promise<ReturnType<typeof makeFetch> & ReturnType<typeof render_>> => {
  const fetchers = makeFetch({ ...scenario, contents: [row, ...(scenario.contents ?? [])] });
  const view = render_(fetchers.impl, entry ?? `${base()}/${row.id}`);
  await screen.findByRole('dialog');
  await screen.findByLabelText('Título');
  return { ...fetchers, ...view };
};

