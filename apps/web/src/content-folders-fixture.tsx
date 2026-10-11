import { QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';

import {
  CreateMediaFolderRequestSchema,
  MediaDownloadUrlQuerySchema,
  MediaFolderAssetListQuerySchema,
  MediaFolderListQuerySchema,
  type MediaFolder,
  type MediaFolderAsset
} from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { ApiClientProvider, HttpClient } from './http.js';
import { useCommittedLocation } from './location-probe-fixture.js';
import { createQueryClient } from './query.js';
import { ApplicationRoutes } from './routes.js';
import { createSessionEndSignal, SessionEndRedirect } from './session-end.js';

export const AGENCY_A = '11111111-1111-4111-8111-111111111111';
const sessionBody = { user: { id: '99999999-9999-4999-8999-999999999999', name: 'Pessoa', email: 'pessoa@example.test' }, session: { expiresAt: '2026-01-01T00:00:00.000Z' } };

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const apiError = (status: number, code: string, message: string, details?: unknown): Response =>
  json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);

export const padaria = {
  id: '1a1a1a1a-1111-4111-8111-111111111111', name: 'Padaria Central', photoUrl: null, instagramHandle: 'padariacentral',
  status: 'active', closingDate: null, threadsAwaitingAgency: 0
};

export const idOf = (prefix: string, index: number): string => `${prefix}0000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

export const folderFixture = (index: number, name: string, overrides: Partial<MediaFolder> = {}): MediaFolder =>
  ({ id: idOf('f', index), parentId: null, name, isDefault: false, createdAt: '2026-10-01T12:00:00.000Z', ...overrides });

export interface AssetRow extends MediaFolderAsset {
  readonly folderId: string;
  /** Used by a content waiting for approval, approved or published: the API refuses to remove it. */
  readonly inUse?: boolean;
  removed?: boolean;
}

/** 01:30Z is the evening of the day before in São Paulo: a date computed in UTC is the wrong one. */
export const assetFixture = (index: number, folderId: string, overrides: Partial<AssetRow> = {}): AssetRow => ({
  id: idOf('a', index), folderId, category: 'image', contentType: 'image/jpeg', sizeBytes: 2_411_724, videoProcessingStatus: 'not_applicable',
  createdAt: '2026-10-12T01:30:00.000Z', ...overrides
});

export const DEFAULT_FOLDERS: readonly MediaFolder[] = [
  folderFixture(1, 'Vídeos', { isDefault: true }),
  folderFixture(2, 'Imagens', { isDefault: true }),
  folderFixture(3, 'Carrosséis', { isDefault: true }),
  folderFixture(4, 'Ensaio fotográfico', { isDefault: true }),
  folderFixture(5, 'Campanha de Natal'),
  folderFixture(6, 'Gravação de outubro', { parentId: idOf('f', 1) })
];

export interface World {
  folders: MediaFolder[];
  assets: AssetRow[];
  permissions: string[];
  clientStatus: 'active' | 'archived';
  /** Every request the screen made, as "METHOD path?query". */
  calls: string[];
  /** What the screen sent in the body of each write. */
  bodies: Array<{ method: string; path: string; body: unknown }>;
  /** Holds the answer of the folder list. */
  foldersGate?: Promise<void>;
  /** Holds the answer of the client's own record. */
  clientGate?: Promise<void>;
  /** Asked before each answer of an asset list: a promise holds that answer. */
  assetsGate?: () => Promise<void> | undefined;
  /** Called for each answer of the folder or asset list; a Response replaces the real one. */
  override?: (method: string, path: string, search: string) => Response | Promise<Response> | undefined;
}

export const makeWorld = (overrides: Partial<World> = {}): World => ({
  folders: [...DEFAULT_FOLDERS],
  assets: [],
  permissions: ['conteudo.visualizar', 'conteudo.operar', 'cliente.visualizar'],
  clientStatus: 'active',
  calls: [],
  bodies: [],
  ...overrides
});

const pageOf = <T,>(rows: readonly T[], query: { page?: number | undefined; pageSize?: number | undefined }, defaultSize: number) => {
  const page = query.page ?? 1;
  const pageSize = Math.min(query.pageSize ?? defaultSize, 100);
  const slice = rows.slice((page - 1) * pageSize, page * pageSize);
  return json({ data: slice, meta: { page, pageSize, totalItems: rows.length, totalPages: Math.ceil(rows.length / pageSize) } });
};

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The agency API as the screen sees it: validates what it receives with the same schemas as the real one, and 404s what is not the client's. */
export const makeFetch = (world: World, extra?: (method: string, url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined): typeof fetch => async (input, init) => {
  const url = new URL(String(input));
  const path = url.pathname;
  const method = init?.method ?? 'GET';
  world.calls.push(`${method} ${path}${url.search}`);
  if (typeof init?.body === 'string') world.bodies.push({ method, path, body: JSON.parse(init.body) as unknown });
  if (path.endsWith('/auth/session')) return json(sessionBody);
  if (/\/agencies\/[^/]+\/me$/.test(path)) {
    return json({ agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: false, role: { key: 'custom', name: 'Papel' }, permissions: world.permissions });
  }
  if (/\/agencies\/[^/]+\/clients$/.test(path)) return json({ data: [padaria], meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } });
  const detail = /\/agencies\/[^/]+\/clients\/([^/]+)$/.exec(path);
  if (detail !== null) {
    await world.clientGate;
    if (detail[1] !== padaria.id) return apiError(404, 'NOT_FOUND', 'Not found');
    return json({
      id: padaria.id, name: padaria.name, status: world.clientStatus, photoUrl: null, instagramHandle: padaria.instagramHandle,
      legalName: null, taxId: null, segment: null, website: null, contactName: null, contactPhone: null, contactEmail: null,
      closingDate: null, archivedAt: null,
      summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 0 }
    });
  }

  const custom = world.override?.(method, path, url.search);
  if (custom !== undefined) return custom;

  const holds = (permission: string): boolean => world.permissions.includes(permission);
  const forbidden = (): Response => apiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');

  const folderList = /\/agencies\/[^/]+\/clients\/([^/]+)\/media-folders$/.exec(path);
  if (folderList !== null) {
    if (folderList[1] !== padaria.id) return apiError(404, 'NOT_FOUND', 'Client not found.');
    if (method === 'POST') {
      if (!holds('conteudo.operar') || !holds('conteudo.visualizar')) return forbidden();
      if (world.clientStatus === 'archived') return apiError(409, 'CLIENT_ARCHIVED', 'Cliente arquivado não pode ser editado.');
      const parsed = CreateMediaFolderRequestSchema.safeParse(JSON.parse(String(init?.body)) as unknown);
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
      const parent = parsed.data.parentId === undefined ? undefined : world.folders.find((folder) => folder.id === parsed.data.parentId);
      if (parsed.data.parentId !== undefined && (parent === undefined || parent.parentId !== null)) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
      const created = folderFixture(world.folders.length + 100, parsed.data.name, { parentId: parent?.id ?? null });
      world.folders.push(created);
      return json(created, 201);
    }
    if (!holds('conteudo.visualizar')) return forbidden();
    const query = MediaFolderListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    await world.foldersGate;
    const sorted = [...world.folders].sort((a, b) =>
      Number(a.parentId !== null) - Number(b.parentId !== null) || Number(b.isDefault) - Number(a.isDefault) || byCodePoint(a.name, b.name) || byCodePoint(a.id, b.id));
    return pageOf(sorted, query.data, 100);
  }

  const assetList = /\/agencies\/[^/]+\/clients\/([^/]+)\/media-folders\/([^/]+)\/assets$/.exec(path);
  if (assetList !== null) {
    if (assetList[1] !== padaria.id || !world.folders.some((folder) => folder.id === assetList[2])) return apiError(404, 'NOT_FOUND', 'Folder not found.');
    if (!holds('conteudo.visualizar')) return forbidden();
    const query = MediaFolderAssetListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    await world.assetsGate?.();
    const rows = world.assets
      .filter((asset) => asset.folderId === assetList[2] && asset.removed !== true)
      .sort((a, b) => byCodePoint(b.createdAt, a.createdAt) || byCodePoint(b.id, a.id))
      .map((asset): MediaFolderAsset => ({
        id: asset.id, category: asset.category, contentType: asset.contentType, sizeBytes: asset.sizeBytes,
        videoProcessingStatus: asset.videoProcessingStatus, createdAt: asset.createdAt
      }));
    return pageOf(rows, query.data, 48);
  }

  const remove = /\/agencies\/[^/]+\/clients\/([^/]+)\/media-folders\/([^/]+)\/assets\/([^/]+)\/remove$/.exec(path);
  if (remove !== null && method === 'POST') {
    if (!holds('conteudo.operar') || !holds('conteudo.visualizar')) return forbidden();
    const asset = world.assets.find((candidate) => candidate.id === remove[3] && candidate.folderId === remove[2] && candidate.removed !== true);
    if (remove[1] !== padaria.id || asset === undefined) return apiError(404, 'NOT_FOUND', 'Media asset not found.');
    if (asset.inUse === true) {
      return apiError(409, 'MEDIA_IN_USE', 'Esta mídia está em um conteúdo enviado para aprovação, aprovado ou publicado e não pode ser removida.');
    }
    asset.removed = true;
    return json({ assetId: asset.id, removed: true });
  }

  const download = /\/agencies\/[^/]+\/media\/([^/]+)\/download-url$/.exec(path);
  if (download !== null) {
    const query = MediaDownloadUrlQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    const asset = world.assets.find((candidate) => candidate.id === download[1] && candidate.removed !== true);
    if (asset === undefined) return apiError(404, 'NOT_FOUND', 'Media asset not found.');
    if (query.data.variant === 'thumbnail' && asset.category === 'video' && asset.videoProcessingStatus !== 'ready') {
      return apiError(409, 'VARIANT_NOT_READY', 'This variant has not been generated yet.');
    }
    return json({ url: `https://storage.test/${asset.id}/${query.data.variant}`, expiresAt: '2026-10-12T01:45:00.000Z' });
  }

  const fromExtra = extra?.(method, url, init);
  if (fromExtra !== undefined) return fromExtra;
  throw new Error(`unexpected ${method} ${url}`);
};

interface Probe {
  pathname: string;
  search: string;
  state: unknown;
  navigate: NavigateFunction;
}

function Harness({ store }: { store: AuthSessionStore }) {
  const session = useAuthSession(store);
  return <ApplicationRoutes session={session} />;
}

function LocationProbe({ probe }: { probe: Probe }) {
  useCommittedLocation((location, navigate) => {
    probe.pathname = location.pathname;
    probe.search = location.search;
    probe.state = location.state;
    probe.navigate = navigate;
  });
  return null;
}

export const foldersUrl = (search = ''): string => `/agencia/${AGENCY_A}/conteudos/${padaria.id}?vista=pastas${search}`;

export const renderFolders = (impl: typeof fetch, entry: string | { pathname: string; search: string; state: unknown } = foldersUrl()): RenderResult & { probe: Probe } => {
  const sessionEnd = createSessionEndSignal();
  const client = new HttpClient('http://127.0.0.1:3001', impl, { onSessionEnded: sessionEnd.notify });
  const store = createAuthSessionStore(client);
  const probe: Probe = { pathname: '', search: '', state: undefined, navigate: () => undefined };
  const rendered = render(
    <AuthSessionProvider store={store}>
      <QueryClientProvider client={createQueryClient()}>
        <ApiClientProvider client={client}>
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

export const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
