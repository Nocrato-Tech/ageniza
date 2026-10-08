import {
  AgencyClientMediaFolderAssetPathParamsSchema,
  AgencyClientMediaFolderPathParamsSchema,
  AgencyClientPathParamsSchema,
  CreateMediaFolderRequestSchema,
  MediaFolderAssetListQuerySchema,
  MediaFolderAssetListResponseSchema,
  MediaFolderListQuerySchema,
  MediaFolderListResponseSchema,
  MediaFolderSchema,
  RemoveMediaAssetResponseSchema,
  buildPaginationMetadata,
  resolvePagination,
  type MediaFolder
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { isRetryableConflict, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import { tryAgain } from '../../plugins/infra/conflict.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeParams, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import { isInsufficientPrivilegeError } from '../tenancy/guards.js';
import {
  clientScopeOf,
  folderFunctionRefusal,
  insertFolder,
  isAssetRemoved,
  isFolderParentViolation,
  listFolderAssets,
  listFolders,
  loadFolder,
  lockFolder,
  removeAsset,
  type ClientScope,
  type FolderRow
} from './folder-service.js';
import { MEDIA_FOLDER_ASSET_DEFAULT_PAGE_SIZE, MEDIA_FOLDER_DEFAULT_PAGE_SIZE } from './policy.js';
import { auditMediaEvent } from './service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface MediaFolderRouteDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly requireAgencyAccess: PreHandler;
  readonly requirePermission: (key: string) => PreHandler;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const notFound = (message: string): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message });
const forbidden = (): HttpError => new HttpError({ statusCode: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
const clientArchived = (): HttpError => new HttpError({ statusCode: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
const mediaInUse = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'MEDIA_IN_USE',
  message: 'Esta mídia está em um conteúdo enviado para aprovação, aprovado ou publicado e não pode ser removida.'
});
const parentNotFirstLevel = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path: 'parentId', code: 'custom', message: 'parentId must be a first-level folder of this client.' }] }
});

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  return auth;
};

const requireTenant = (request: FastifyRequest): NonNullable<FastifyRequest['tenant']> => {
  const tenant = request.tenant;
  if (tenant === undefined) throw notFound('Agency not found.');
  return tenant;
};

/** A malformed id is the same 404 as an absent one, never a 400 that confirms the route exists. */
const idFromRoute = (request: FastifyRequest, name: string, message: string): string => {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw notFound(message);
  return value;
};

const folderFrom = (row: FolderRow): MediaFolder => ({
  id: row.id,
  parentId: row.parent_id,
  name: row.name,
  isDefault: row.is_default,
  createdAt: new Date(row.created_at).toISOString()
});

/** What the functions and the foreign key raise, as the public answer; anything else is not ours to translate. */
const translate = (error: unknown): HttpError | undefined => {
  if (isRetryableConflict(error)) return tryAgain();
  if (isFolderParentViolation(error)) return parentNotFirstLevel();
  if (isInsufficientPrivilegeError(error)) return forbidden();
  switch (folderFunctionRefusal(error)) {
    case 'not-found': return notFound('Not found.');
    case 'client-archived': return clientArchived();
    case 'in-use': return mediaInUse();
    default: return undefined;
  }
};

/**
 * The client's media library (#253, specs/conteudo.md §6): folders and the media in them. Every route
 * names the agency, the client and, below that, the folder; a client of another agency, a folder of
 * another client and a malformed id are the same 404. The writes need `conteudo.operar` **and**
 * `conteudo.visualizar`: with the first alone the role would write what it cannot read back.
 */
export const registerMediaFolderRoutes = (app: FastifyInstance, dependencies: MediaFolderRouteDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const guarded = (docs: DocumentedRouteConfig & { permission: string }, alsoReads = false) => ({
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requirePermission(docs.permission),
      ...(alsoReads ? [dependencies.requirePermission('conteudo.visualizar')] : [])
    ],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  const listDocs = {
    permission: 'conteudo.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, query: MediaFolderListQuerySchema, response: MediaFolderListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const createDocs = {
    permission: 'conteudo.operar',
    responseStatus: 201,
    schemas: { params: AgencyClientPathParamsSchema, body: CreateMediaFolderRequestSchema, response: MediaFolderSchema }
  } satisfies DocumentedRouteConfig;
  const assetsDocs = {
    permission: 'conteudo.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyClientMediaFolderPathParamsSchema, query: MediaFolderAssetListQuerySchema, response: MediaFolderAssetListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const removeDocs = {
    permission: 'conteudo.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientMediaFolderAssetPathParamsSchema, response: RemoveMediaAssetResponseSchema }
  } satisfies DocumentedRouteConfig;

  const requireReadableClient = (scope: ClientScope): void => {
    if (scope === 'not-found') throw notFound('Client not found.');
  };
  const requireWritableClient = (scope: ClientScope): void => {
    requireReadableClient(scope);
    if (scope === 'archived') throw clientArchived();
  };

  const inTransaction = async <T>(request: FastifyRequest, work: Parameters<typeof withAuthenticatedUserTransaction<T>>[2]): Promise<T> => {
    try {
      return await withAuthenticatedUserTransaction(dependencies.database, requireAuth(request).claims, work);
    } catch (error) {
      throw translate(error) ?? error;
    }
  };

  app.get('/agencies/:agencyId/clients/:clientId/media-folders', guarded(listDocs), async (request, reply) => {
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    routeParams(listDocs, request);
    const page = resolvePagination(routeQuery(listDocs, request), MEDIA_FOLDER_DEFAULT_PAGE_SIZE);

    const result = await inTransaction(request, async (transaction) => {
      requireReadableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      return listFolders(transaction, clientId, { limit: page.pageSize, offset: page.offset });
    });

    return reply.send(routeResponse(listDocs, request, { data: result.rows.map(folderFrom), meta: buildPaginationMetadata(page, result.total) }));
  });

  app.post('/agencies/:agencyId/clients/:clientId/media-folders', guarded(createDocs, true), async (request, reply) => {
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    routeParams(createDocs, request);
    const body = routeBody(createDocs, request);

    const folder = await inTransaction(request, async (transaction) => {
      requireWritableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      let parentId: string | null = null;
      if (body.parentId !== undefined) {
        const parent = await lockFolder(transaction, body.parentId);
        if (parent.client_id !== clientId) throw notFound('Folder not found.');
        if (parent.parent_id !== null) throw parentNotFirstLevel();
        parentId = parent.id;
      }
      return insertFolder(transaction, { clientId, parentId, name: body.name });
    });

    return reply.status(201).send(routeResponse(createDocs, request, folderFrom(folder)));
  });

  app.get('/agencies/:agencyId/clients/:clientId/media-folders/:folderId/assets', guarded(assetsDocs), async (request, reply) => {
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    const folderId = idFromRoute(request, 'folderId', 'Folder not found.');
    routeParams(assetsDocs, request);
    const page = resolvePagination(routeQuery(assetsDocs, request), MEDIA_FOLDER_ASSET_DEFAULT_PAGE_SIZE);

    const result = await inTransaction(request, async (transaction) => {
      requireReadableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      if (await loadFolder(transaction, clientId, folderId) === undefined) throw notFound('Folder not found.');
      return listFolderAssets(transaction, folderId, { limit: page.pageSize, offset: page.offset });
    });

    return reply.send(routeResponse(assetsDocs, request, {
      data: result.rows.map((row) => ({
        id: row.id,
        category: row.category,
        contentType: row.confirmed_content_type,
        sizeBytes: Number(row.confirmed_size_bytes),
        videoProcessingStatus: row.video_processing_status,
        createdAt: new Date(row.created_at).toISOString()
      })),
      meta: buildPaginationMetadata(page, result.total)
    }));
  });

  app.post('/agencies/:agencyId/clients/:clientId/media-folders/:folderId/assets/:assetId/remove', guarded(removeDocs, true), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    const folderId = idFromRoute(request, 'folderId', 'Folder not found.');
    const assetId = idFromRoute(request, 'assetId', 'Media asset not found.');
    routeParams(removeDocs, request);

    await inTransaction(request, async (transaction) => {
      requireWritableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      if (await loadFolder(transaction, clientId, folderId) === undefined) throw notFound('Folder not found.');
      const alreadyRemoved = await isAssetRemoved(transaction, assetId);
      try {
        await removeAsset(transaction, assetId, folderId);
      } catch (error) {
        if (folderFunctionRefusal(error) === 'not-found') throw notFound('Media asset not found.');
        throw error;
      }
      if (!alreadyRemoved) {
        await auditMediaEvent(transaction, { action: 'media.removed', actorUserId: auth.userId, agencyId: tenant.agencyId, targetId: assetId });
      }
    });

    return reply.send(routeResponse(removeDocs, request, { assetId, removed: true }));
  });
};
