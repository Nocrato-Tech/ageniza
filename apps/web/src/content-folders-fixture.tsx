import { QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter, type NavigateFunction } from 'react-router-dom';

import {
  CompleteMediaUploadRequestSchema,
  CreateMediaFolderRequestSchema,
  CreateMediaUploadRequestSchema,
  MediaDownloadUrlQuerySchema,
  MediaFolderListQuerySchema,
  MediaLibraryListQuerySchema,
  MoveMediaAssetRequestSchema,
  RenameMediaFolderRequestSchema,
  RequestMediaUploadPartsRequestSchema,
  UpdateMediaAssetRequestSchema,
  type MediaFolder,
  type MediaFolderSummary,
  type MediaLibraryAsset,
  type MediaLibraryCategory,
  type MediaUsage
} from '@ageniza/contracts';

import { AuthSessionProvider, createAuthSessionStore, useAuthSession, type AuthSessionStore } from './auth.js';
import { clientRegistrationExtras } from './client-registration-fixture.js';
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

export const MARINA = { membershipId: idOf('c', 1), name: 'Marina Bastos' };

export interface AssetRow extends Omit<MediaLibraryAsset, 'folderName' | 'usageCount'> {
  /** The contents that hold the file; the count of the list and the rows of the panel come from here. */
  usage: MediaUsage[];
  /** Used by a content waiting for approval, approved or published: the API refuses to remove or move it. */
  readonly inUse?: boolean;
  removed?: boolean;
}

/** 01:30Z is the evening of the day before in São Paulo: a date computed in UTC is the wrong one. */
export const assetFixture = (index: number, folderId: string, overrides: Partial<AssetRow> = {}): AssetRow => ({
  id: idOf('a', index), folderId, category: 'image', contentType: 'image/jpeg', sizeBytes: 2_411_724, name: `arquivo-${index}.jpg`,
  width: 3024, height: 4032, altText: null, videoProcessingStatus: 'not_applicable', uploadedBy: MARINA,
  createdAt: '2026-10-12T01:30:00.000Z', usage: [], ...overrides
});

export const usageFixture = (index: number, overrides: Partial<MediaUsage> = {}): MediaUsage =>
  ({ contentId: idOf('d', index), title: `Conteúdo ${index}`, status: 'awaiting_approval', asMedia: true, asCover: false, ...overrides });

export const DEFAULT_FOLDERS: readonly MediaFolder[] = [
  folderFixture(1, 'Vídeos', { isDefault: true }),
  folderFixture(2, 'Imagens', { isDefault: true }),
  folderFixture(3, 'Carrosséis', { isDefault: true }),
  folderFixture(4, 'Ensaio fotográfico', { isDefault: true }),
  folderFixture(5, 'Campanha de Natal'),
  folderFixture(6, 'Gravação de outubro', { parentId: idOf('f', 1) })
];

export const UPLOAD_PART_BYTES = 5 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export interface PendingUpload {
  readonly assetId: string;
  readonly folderId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly multipart: boolean;
  readonly asLogo: boolean;
  confirmed?: boolean;
}

export interface World {
  folders: MediaFolder[];
  assets: AssetRow[];
  permissions: string[];
  clientStatus: 'active' | 'archived';
  /** The folder the API names "in use now"; none by default. */
  inUseFolderId?: string;
  /** Every request the screen made, as "METHOD path?query". */
  calls: string[];
  /** The uploads the API reserved, confirmed or not. */
  pending: PendingUpload[];
  quotaFull?: boolean;
  /** The part size the API plans with; small, it makes a file of a few KiB a multipart upload of many parts. */
  partBytes?: number;
  /** The API refuses the object at confirmation, as it does when the bytes are not what was declared. */
  rejectUpload?: boolean;
  /** What the screen sent in the body of each write. */
  bodies: Array<{ method: string; path: string; body: unknown }>;
  /** Holds the answer of the folder list. */
  foldersGate?: Promise<void>;
  /** Holds the answer of the client's own record. */
  clientGate?: Promise<void>;
  /** Asked before each answer of a file list: a promise holds that answer. */
  assetsGate?: () => Promise<void> | undefined;
  /** Called for each request of the library; a Response replaces the real one. */
  override?: (method: string, path: string, search: string) => Response | Promise<Response> | undefined;
}

export const makeWorld = (overrides: Partial<World> = {}): World => ({
  folders: DEFAULT_FOLDERS.map((folder) => ({ ...folder })),
  assets: [],
  permissions: ['conteudo.visualizar', 'conteudo.operar', 'cliente.visualizar'],
  clientStatus: 'active',
  calls: [],
  pending: [],
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
const plain = (value: string): string => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

const live = (world: World): AssetRow[] => world.assets.filter((asset) => asset.removed !== true);

const libraryRow = (world: World, asset: AssetRow): MediaLibraryAsset => {
  const { usage, ...row } = asset;
  delete row.inUse;
  delete row.removed;
  return { ...row, folderName: world.folders.find((folder) => folder.id === asset.folderId)?.name ?? 'Pasta', usageCount: usage.length };
};

const summaryRow = (world: World, folder: MediaFolder): MediaFolderSummary => {
  const files = live(world).filter((asset) => asset.folderId === folder.id).sort((a, b) => byCodePoint(b.createdAt, a.createdAt));
  const counts = { image: 0, video: 0, pdf: 0, audio: 0, logo: 0 };
  for (const asset of files) counts[asset.category] += 1;
  return {
    ...folder, counts, assetCount: files.length, totalSizeBytes: files.reduce((sum, asset) => sum + asset.sizeBytes, 0),
    lastChangedAt: files[0]?.createdAt ?? folder.createdAt, lastUploadedBy: files[0]?.uploadedBy ?? null, inUseNow: world.inUseFolderId === folder.id
  };
};

const categoryOf = (contentType: string, asLogo: boolean): MediaLibraryCategory | undefined => {
  if (contentType === 'image/svg+xml') return asLogo ? 'logo' : undefined;
  if (/^image\//.test(contentType)) return asLogo ? 'logo' : 'image';
  if (/^video\//.test(contentType)) return 'video';
  if (contentType === 'application/pdf') return 'pdf';
  if (/^audio\//.test(contentType)) return 'audio';
  return undefined;
};

/** The agency API as the screen sees it: validates what it receives with the same schemas as the real one, and 404s what is not the client's. */
export const makeFetch = (world: World, extra?: (method: string, url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined): typeof fetch => async (input, init) => {
  const url = new URL(String(input));
  const path = url.pathname;
  const method = init?.method ?? 'GET';
  world.calls.push(`${method} ${path}${url.search}`);
  if (typeof init?.body === 'string') world.bodies.push({ method, path, body: JSON.parse(init.body) as unknown });
  if (path.endsWith('/auth/session')) return json(sessionBody);
  if (/\/agencies\/[^/]+\/me$/.test(path)) {
    return json({ agencyId: AGENCY_A, agencyName: 'Agência Um', isOwner: false, membershipId: null, role: { key: 'custom', name: 'Papel' }, plan: { kind: 'isenta', trialEndsAt: null, readOnly: false }, permissions: world.permissions });
  }
  if (/\/agencies\/[^/]+\/clients$/.test(path)) return json({ data: [padaria], meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } });
  const detail = /\/agencies\/[^/]+\/clients\/([^/]+)$/.exec(path);
  if (detail !== null) {
    await world.clientGate;
    if (detail[1] !== padaria.id) return apiError(404, 'NOT_FOUND', 'Not found');
    return json({
      id: padaria.id, name: padaria.name, status: world.clientStatus, photoUrl: null, instagramHandle: padaria.instagramHandle,
      legalName: null, taxId: null, segment: null, website: null, contactName: null, contactPhone: null, contactEmail: null,
      closingDate: null, archivedAt: null, ...clientRegistrationExtras,
      summary: { brandStudyFilled: 0, threadsAwaitingAgency: 0, threadsAnsweredByAgency: 0, activePortalMembers: 0 }
    });
  }

  const custom = world.override?.(method, path, url.search);
  if (custom !== undefined) return custom;

  const holds = (permission: string): boolean => world.permissions.includes(permission);
  const forbidden = (): Response => apiError(403, 'FORBIDDEN', 'You do not have permission to perform this action.');
  const archived = (): Response => apiError(409, 'CLIENT_ARCHIVED', 'Cliente arquivado não pode ser editado.');
  const body = (): unknown => JSON.parse(String(init?.body)) as unknown;

  const folderList = /\/agencies\/[^/]+\/clients\/([^/]+)\/media-folders$/.exec(path);
  if (folderList !== null) {
    if (folderList[1] !== padaria.id) return apiError(404, 'NOT_FOUND', 'Client not found.');
    if (method === 'POST') {
      if (!holds('conteudo.operar') || !holds('conteudo.visualizar')) return forbidden();
      if (world.clientStatus === 'archived') return archived();
      const parsed = CreateMediaFolderRequestSchema.safeParse(body());
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
      const parent = parsed.data.parentId === undefined ? undefined : world.folders.find((folder) => folder.id === parsed.data.parentId);
      if (parsed.data.parentId !== undefined && (parent === undefined || parent.parentId !== null)) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
      const created = folderFixture(world.folders.length + 100, parsed.data.name, { parentId: parent?.id ?? null });
      world.folders.push(created);
      return json(created, 201);
    }
  }

  const sorted = (): MediaFolder[] => [...world.folders].sort((a, b) =>
    Number(a.parentId !== null) - Number(b.parentId !== null) || Number(b.isDefault) - Number(a.isDefault) || byCodePoint(a.name, b.name) || byCodePoint(a.id, b.id));

  const summary = /\/agencies\/[^/]+\/clients\/([^/]+)\/media-folders\/summary$/.exec(path);
  if (summary !== null) {
    if (summary[1] !== padaria.id) return apiError(404, 'NOT_FOUND', 'Client not found.');
    if (!holds('conteudo.visualizar')) return forbidden();
    const query = MediaFolderListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    await world.foldersGate;
    return pageOf(sorted().map((folder) => summaryRow(world, folder)), query.data, 100);
  }

  const oneFolder = /\/agencies\/[^/]+\/clients\/([^/]+)\/media-folders\/([^/]+)$/.exec(path);
  if (oneFolder !== null && (method === 'PATCH' || method === 'DELETE')) {
    const folder = world.folders.find((candidate) => candidate.id === oneFolder[2]);
    if (oneFolder[1] !== padaria.id || folder === undefined) return apiError(404, 'NOT_FOUND', 'Folder not found.');
    if (!holds('conteudo.operar') || !holds('conteudo.visualizar')) return forbidden();
    if (world.clientStatus === 'archived') return archived();
    if (folder.isDefault) return apiError(409, 'DEFAULT_FOLDER_IMMUTABLE', method === 'PATCH' ? 'As pastas padrão não podem ser renomeadas.' : 'As pastas padrão não podem ser excluídas.');
    if (method === 'PATCH') {
      const parsed = RenameMediaFolderRequestSchema.safeParse(body());
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
      folder.name = parsed.data.name;
      return json(folder);
    }
    if (live(world).some((asset) => asset.folderId === folder.id)) return apiError(409, 'FOLDER_NOT_EMPTY', 'Esta pasta tem arquivos. Mova ou exclua os arquivos antes.');
    if (world.folders.some((candidate) => candidate.parentId === folder.id)) return apiError(409, 'FOLDER_NOT_EMPTY', 'Esta pasta tem subpastas. Mova ou exclua as subpastas antes.');
    world.folders = world.folders.filter((candidate) => candidate.id !== folder.id);
    return new Response(null, { status: 204 });
  }

  const library = /\/agencies\/[^/]+\/clients\/([^/]+)\/media$/.exec(path);
  if (library !== null) {
    if (library[1] !== padaria.id) return apiError(404, 'NOT_FOUND', 'Client not found.');
    if (!holds('conteudo.visualizar')) return forbidden();
    const query = MediaLibraryListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    if (query.data.folderId !== undefined && !world.folders.some((folder) => folder.id === query.data.folderId)) return apiError(404, 'NOT_FOUND', 'Folder not found.');
    await world.assetsGate?.();
    const term = plain(query.data.q ?? '');
    const rows = live(world)
      .filter((asset) => (query.data.folderId === undefined || asset.folderId === query.data.folderId)
        && (query.data.category === undefined || asset.category === query.data.category)
        && (term === '' || plain(asset.name ?? '').includes(term)))
      .sort((a, b) => byCodePoint(b.createdAt, a.createdAt) || byCodePoint(b.id, a.id))
      .map((asset) => libraryRow(world, asset));
    return pageOf(rows, query.data, 20);
  }

  const one = /\/agencies\/[^/]+\/clients\/([^/]+)\/media\/([^/]+)(\/move|\/usage)?$/.exec(path);
  if (one !== null) {
    const asset = live(world).find((candidate) => candidate.id === one[2]);
    if (one[1] !== padaria.id || asset === undefined) return apiError(404, 'NOT_FOUND', 'Media asset not found.');
    if (one[3] === '/usage') {
      if (!holds('conteudo.visualizar')) return forbidden();
      return pageOf(asset.usage, { page: 1, pageSize: 20 }, 20);
    }
    if (method === 'GET') return json(libraryRow(world, asset));
    if (!holds('conteudo.operar') || !holds('conteudo.visualizar')) return forbidden();
    if (world.clientStatus === 'archived') return archived();
    if (one[3] === '/move') {
      const parsed = MoveMediaAssetRequestSchema.safeParse(body());
      if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
      if (!world.folders.some((folder) => folder.id === parsed.data.folderId)) return apiError(404, 'NOT_FOUND', 'Folder not found.');
      if (asset.inUse === true) return apiError(409, 'MEDIA_IN_USE', 'Esta mídia está em um conteúdo e não pode ser movida para outra pasta.');
      asset.folderId = parsed.data.folderId;
      return json(libraryRow(world, asset));
    }
    const parsed = UpdateMediaAssetRequestSchema.safeParse(body());
    if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    if (parsed.data.name !== undefined) asset.name = parsed.data.name;
    if (parsed.data.altText !== undefined) asset.altText = parsed.data.altText;
    return json(libraryRow(world, asset));
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

  const partBytes = world.partBytes ?? UPLOAD_PART_BYTES;
  const uploads = /\/agencies\/[^/]+\/media\/uploads$/.exec(path);
  if (uploads !== null && method === 'POST') {
    if (!holds('conteudo.operar') || !holds('conteudo.visualizar')) return forbidden();
    const parsed = CreateMediaUploadRequestSchema.safeParse(body());
    if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    const request = parsed.data;
    if (request.clientId !== padaria.id || !world.folders.some((folder) => folder.id === request.folderId)) return apiError(404, 'NOT_FOUND', 'Folder not found.');
    if (world.clientStatus === 'archived') return archived();
    const category = categoryOf(request.contentType, request.asLogo === true);
    if (category === undefined) return apiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'This content type is not accepted.');
    if (request.declaredSizeBytes > UPLOAD_MAX_BYTES) return apiError(413, 'PAYLOAD_TOO_LARGE', 'The declared file size exceeds the limit for its category.');
    if (world.quotaFull === true) return apiError(409, 'QUOTA_EXCEEDED', 'This agency has reached its storage quota.');
    const assetId = idOf('b', world.pending.length + 1);
    const multipart = request.declaredSizeBytes >= partBytes;
    world.pending.push({ assetId, folderId: request.folderId!, fileName: request.fileName, contentType: request.contentType, sizeBytes: request.declaredSizeBytes, multipart, asLogo: request.asLogo === true });
    return json({
      assetId, objectKey: `${AGENCY_A}/${assetId}/original`, category,
      upload: multipart
        ? { type: 'multipart', uploadId: `upload-${assetId}`, partSizeBytes: partBytes, partCount: Math.ceil(request.declaredSizeBytes / partBytes) }
        : { type: 'single', url: `https://storage.test/put/${assetId}`, expiresAt: '2026-10-12T01:45:00.000Z' }
    }, 201);
  }
  const uploadParts = /\/agencies\/[^/]+\/media\/uploads\/([^/]+)\/parts$/.exec(path);
  if (uploadParts !== null && method === 'POST') {
    const pending = world.pending.find((candidate) => candidate.assetId === uploadParts[1] && candidate.confirmed !== true);
    if (pending === undefined) return apiError(404, 'NOT_FOUND', 'Media asset not found.');
    const parsed = RequestMediaUploadPartsRequestSchema.safeParse(body());
    const count = Math.ceil(pending.sizeBytes / partBytes);
    if (!parsed.success || !pending.multipart || parsed.data.partNumbers.some((number) => number > count)) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    return json({
      parts: parsed.data.partNumbers.map((partNumber) => ({ partNumber, url: `https://storage.test/put/${pending.assetId}/part/${partNumber}` })),
      expiresAt: '2026-10-12T01:45:00.000Z'
    });
  }
  const uploadComplete = /\/agencies\/[^/]+\/media\/uploads\/([^/]+)\/complete$/.exec(path);
  if (uploadComplete !== null && method === 'POST') {
    const pending = world.pending.find((candidate) => candidate.assetId === uploadComplete[1] && candidate.confirmed !== true);
    if (pending === undefined) return apiError(404, 'NOT_FOUND', 'Media asset not found.');
    const parsed = CompleteMediaUploadRequestSchema.safeParse(body());
    if (!parsed.success) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    const count = Math.ceil(pending.sizeBytes / partBytes);
    if (pending.multipart !== (parsed.data.parts !== undefined)) return apiError(400, 'VALIDATION_ERROR', 'Request validation failed');
    if (parsed.data.parts !== undefined && (parsed.data.parts.length !== count || parsed.data.parts.some((part) => part.partNumber > count))) {
      return apiError(400, 'VALIDATION_ERROR', 'A multipart part number is outside this upload plan.');
    }
    if (world.rejectUpload === true) return apiError(422, 'UPLOAD_REJECTED', 'The uploaded object was rejected: content_type_mismatch.', { reason: 'content_type_mismatch' });
    pending.confirmed = true;
    world.assets.push(assetFixture(900 + world.assets.length, pending.folderId, {
      id: pending.assetId, category: categoryOf(pending.contentType, pending.asLogo)!, contentType: pending.contentType, name: pending.fileName,
      sizeBytes: pending.sizeBytes, createdAt: '2026-10-12T01:30:00.000Z'
    }));
    return json({ assetId: pending.assetId, status: 'confirmed', sizeBytes: pending.sizeBytes, contentType: pending.contentType });
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

export const foldersUrl = (search = ''): string => `/agencia/${AGENCY_A}/clientes/${padaria.id}/midias${search === '' ? '' : `?${search.replace(/^[?&]/, '')}`}`;

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
