import {
  AgencyClientMediaAssetPathParamsSchema,
  AgencyClientMediaFolderPathParamsSchema,
  AgencyClientPathParamsSchema,
  MediaFolderSchema,
  MediaFolderSummaryListQuerySchema,
  MediaFolderSummaryListResponseSchema,
  MediaLibraryAssetSchema,
  MediaLibraryListQuerySchema,
  MediaLibraryListResponseSchema,
  MediaUsageListQuerySchema,
  MediaUsageListResponseSchema,
  MoveMediaAssetRequestSchema,
  RenameMediaFolderRequestSchema,
  UpdateMediaAssetRequestSchema,
  buildPaginationMetadata,
  resolvePagination
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import type { FastifyInstance } from 'fastify';

import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeParams, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import { notFound } from './client-media-errors.js';
import {
  createClientMediaRouteKit,
  idFromRoute,
  requireAuth,
  requireReadableClient,
  requireTenant,
  requireWritableClient,
  type ClientMediaRouteDependencies
} from './client-route-support.js';
import { clientScopeOf, folderFunctionRefusal, loadFolder } from './folder-service.js';
import { folderFrom } from './folder-routes.js';
import {
  editAsset,
  folderSummaryFrom,
  libraryAssetFrom,
  listAssetUsage,
  listFolderSummaries,
  listLibraryAssets,
  loadLibraryAsset,
  moveAsset,
  renameFolder,
  usageFrom
} from './library-service.js';
import { MEDIA_FOLDER_DEFAULT_PAGE_SIZE, MEDIA_LIBRARY_DEFAULT_PAGE_SIZE, MEDIA_USAGE_DEFAULT_PAGE_SIZE } from './policy.js';
import { auditMediaEvent } from './service.js';

const assetNotFound = (): HttpError => notFound('Media asset not found.');

const defaultFolderImmutable = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'DEFAULT_FOLDER_IMMUTABLE',
  message: 'As pastas padrão não podem ser renomeadas.'
});

const mediaInUseForMove = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'MEDIA_IN_USE',
  message: 'Esta mídia está em um conteúdo e não pode ser movida para outra pasta.'
});

/**
 * The client's media library, read and edited as a whole (decisions 2026-11-11 "a mídia ganha nome, dimensões, texto alternativo,
 * renomear e mover" and "a mídia mostra onde é usada"): the files of the client across folders, one file with where it is used, the
 * edit of its name and alternative text, its move to another folder of the same client, the folders with what they hold, and the
 * rename of a folder. The routes name the agency and the client like those of the folders; a client of another agency, a file or a
 * folder of another client and a malformed id are the same 404, and a role without the permission never reaches the handler.
 */
export const registerMediaLibraryRoutes = (app: FastifyInstance, dependencies: ClientMediaRouteDependencies): void => {
  const { guarded, inTransaction } = createClientMediaRouteKit(dependencies);

  const listDocs = {
    permission: 'conteudo.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, query: MediaLibraryListQuerySchema, response: MediaLibraryListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const detailDocs = {
    permission: 'conteudo.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyClientMediaAssetPathParamsSchema, response: MediaLibraryAssetSchema }
  } satisfies DocumentedRouteConfig;
  const editDocs = {
    permission: 'conteudo.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientMediaAssetPathParamsSchema, body: UpdateMediaAssetRequestSchema, response: MediaLibraryAssetSchema }
  } satisfies DocumentedRouteConfig;
  const moveDocs = {
    permission: 'conteudo.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientMediaAssetPathParamsSchema, body: MoveMediaAssetRequestSchema, response: MediaLibraryAssetSchema }
  } satisfies DocumentedRouteConfig;
  const usageDocs = {
    permission: 'conteudo.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyClientMediaAssetPathParamsSchema, query: MediaUsageListQuerySchema, response: MediaUsageListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const summaryDocs = {
    permission: 'conteudo.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, query: MediaFolderSummaryListQuerySchema, response: MediaFolderSummaryListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const renameFolderDocs = {
    permission: 'conteudo.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientMediaFolderPathParamsSchema, body: RenameMediaFolderRequestSchema, response: MediaFolderSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/agencies/:agencyId/clients/:clientId/media', guarded(listDocs), async (request, reply) => {
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    routeParams(listDocs, request);
    const query = routeQuery(listDocs, request);
    const page = resolvePagination(query, MEDIA_LIBRARY_DEFAULT_PAGE_SIZE);

    const result = await inTransaction(request, async (transaction) => {
      requireReadableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      // A folder of another client is the same 404 as an absent one, never an empty list that says it exists.
      if (query.folderId !== undefined && await loadFolder(transaction, clientId, query.folderId) === undefined) throw notFound('Folder not found.');
      return listLibraryAssets(transaction, clientId, {
        ...(query.q === undefined ? {} : { search: query.q }),
        ...(query.category === undefined ? {} : { category: query.category }),
        ...(query.folderId === undefined ? {} : { folderId: query.folderId })
      }, { limit: page.pageSize, offset: page.offset });
    });

    return reply.send(routeResponse(listDocs, request, { data: result.rows.map(libraryAssetFrom), meta: buildPaginationMetadata(page, result.total) }));
  });

  app.get('/agencies/:agencyId/clients/:clientId/media-folders/summary', guarded(summaryDocs), async (request, reply) => {
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    routeParams(summaryDocs, request);
    const page = resolvePagination(routeQuery(summaryDocs, request), MEDIA_FOLDER_DEFAULT_PAGE_SIZE);

    const result = await inTransaction(request, async (transaction) => {
      requireReadableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      return listFolderSummaries(transaction, clientId, { limit: page.pageSize, offset: page.offset });
    });

    return reply.send(routeResponse(summaryDocs, request, { data: result.rows.map(folderSummaryFrom), meta: buildPaginationMetadata(page, result.total) }));
  });

  app.patch('/agencies/:agencyId/clients/:clientId/media-folders/:folderId', guarded(renameFolderDocs, true), async (request, reply) => {
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    const folderId = idFromRoute(request, 'folderId', 'Folder not found.');
    routeParams(renameFolderDocs, request);
    const body = routeBody(renameFolderDocs, request);

    const folder = await inTransaction(request, async (transaction) => {
      requireWritableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      const current = await loadFolder(transaction, clientId, folderId);
      if (current === undefined) throw notFound('Folder not found.');
      if (current.is_default) throw defaultFolderImmutable();
      if (!await renameFolder(transaction, clientId, folderId, body.name)) {
        requireWritableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
        throw notFound('Folder not found.');
      }
      const renamed = await loadFolder(transaction, clientId, folderId);
      if (renamed === undefined) throw notFound('Folder not found.');
      return renamed;
    });

    return reply.send(routeResponse(renameFolderDocs, request, folderFrom(folder)));
  });

  app.get('/agencies/:agencyId/clients/:clientId/media/:assetId', guarded(detailDocs), async (request, reply) => {
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    const assetId = idFromRoute(request, 'assetId', 'Media asset not found.');
    routeParams(detailDocs, request);

    const asset = await inTransaction(request, async (transaction) => {
      requireReadableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      const found = await loadLibraryAsset(transaction, clientId, assetId);
      if (found === undefined) throw assetNotFound();
      return found;
    });

    return reply.send(routeResponse(detailDocs, request, libraryAssetFrom(asset)));
  });

  app.patch('/agencies/:agencyId/clients/:clientId/media/:assetId', guarded(editDocs, true), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    const assetId = idFromRoute(request, 'assetId', 'Media asset not found.');
    routeParams(editDocs, request);
    const body = routeBody(editDocs, request);

    const asset = await inTransaction(request, async (transaction) => {
      requireWritableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      const current = await loadLibraryAsset(transaction, clientId, assetId);
      if (current === undefined) throw assetNotFound();
      if (!await editAsset(transaction, clientId, assetId, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.altText === undefined ? {} : { altText: body.altText })
      })) {
        // An archive that committed after the first read makes the policy hide the row: say which it was.
        requireWritableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
        throw assetNotFound();
      }

      if (body.name !== undefined && body.name !== current.file_name) {
        await auditMediaEvent(transaction, { action: 'media.renamed', actorUserId: auth.userId, agencyId: tenant.agencyId, targetId: assetId });
      }
      if (body.altText !== undefined && body.altText !== current.alt_text) {
        await auditMediaEvent(transaction, { action: 'media.alt_text_changed', actorUserId: auth.userId, agencyId: tenant.agencyId, targetId: assetId });
      }
      const edited = await loadLibraryAsset(transaction, clientId, assetId);
      if (edited === undefined) throw assetNotFound();
      return edited;
    });

    return reply.send(routeResponse(editDocs, request, libraryAssetFrom(asset)));
  });

  app.post('/agencies/:agencyId/clients/:clientId/media/:assetId/move', guarded(moveDocs, true), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    const assetId = idFromRoute(request, 'assetId', 'Media asset not found.');
    routeParams(moveDocs, request);
    const body = routeBody(moveDocs, request);

    const asset = await inTransaction(request, async (transaction) => {
      requireWritableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      if (await loadLibraryAsset(transaction, clientId, assetId) === undefined) throw assetNotFound();
      // The folder is read through the client of the route: a folder of another client reads as absent, as the same answer.
      if (await loadFolder(transaction, clientId, body.folderId) === undefined) throw notFound('Folder not found.');
      let moved: boolean;
      try {
        moved = await moveAsset(transaction, assetId, body.folderId);
      } catch (error) {
        const refusal = folderFunctionRefusal(error);
        if (refusal === 'not-found') throw assetNotFound();
        if (refusal === 'in-use') throw mediaInUseForMove();
        throw error;
      }
      // Whether THIS call moved it is the function's answer, given after the lock of the media.
      if (moved) await auditMediaEvent(transaction, { action: 'media.moved', actorUserId: auth.userId, agencyId: tenant.agencyId, targetId: assetId });
      const current = await loadLibraryAsset(transaction, clientId, assetId);
      if (current === undefined) throw assetNotFound();
      return current;
    });

    return reply.send(routeResponse(moveDocs, request, libraryAssetFrom(asset)));
  });

  app.get('/agencies/:agencyId/clients/:clientId/media/:assetId/usage', guarded(usageDocs), async (request, reply) => {
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', 'Client not found.');
    const assetId = idFromRoute(request, 'assetId', 'Media asset not found.');
    routeParams(usageDocs, request);
    const page = resolvePagination(routeQuery(usageDocs, request), MEDIA_USAGE_DEFAULT_PAGE_SIZE);

    const result = await inTransaction(request, async (transaction) => {
      requireReadableClient(await clientScopeOf(transaction, tenant.agencyId, clientId));
      if (await loadLibraryAsset(transaction, clientId, assetId) === undefined) throw assetNotFound();
      return listAssetUsage(transaction, clientId, assetId, { limit: page.pageSize, offset: page.offset });
    });

    return reply.send(routeResponse(usageDocs, request, { data: result.rows.map(usageFrom), meta: buildPaginationMetadata(page, result.total) }));
  });
};
