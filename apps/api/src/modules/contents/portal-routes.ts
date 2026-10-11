import {
  buildPaginationMetadata,
  CONTENT_PERIOD_MAX_ITEMS,
  contentPeriodIssue,
  PortalApproveContentRequestSchema,
  PortalContentAwaitingQuerySchema,
  PortalContentAwaitingResponseSchema,
  PortalContentDetailSchema,
  PortalContentMediaPathParamsSchema,
  PortalContentMediaUrlQuerySchema,
  PortalContentMediaUrlResponseSchema,
  PortalContentPathParamsSchema,
  PortalContentPeriodQuerySchema,
  PortalContentPeriodResponseSchema,
  PortalRequestContentChangesRequestSchema,
  resolvePagination,
  ClientPathParamsSchema,
  type PortalContentDetail
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, databaseErrorCode, type DatabaseClient, type VerifiedUserClaims } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { sharedUserRateLimit } from '../../plugins/infra/rate-limit.js';
import { routeBody, routeParams, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import { MEDIA_RATE_LIMITS, MEDIA_READ_URL_BUCKET } from '../media/policy.js';
import { auditMediaEvent } from '../media/service.js';
import type { MediaStorageClient } from '../media/storage-client.js';
import { isInsufficientPrivilegeError } from '../tenancy/guards.js';
import { clientNotFound, contentNotFound, forbidden, periodTooLarge, unauthenticated } from './errors.js';
import { mediaNotFound, notAwaitingApproval, translatePortalError, variantNotReady, variantProcessingFailed, type PortalContentAction } from './portal-errors.js';
import {
  approveContent,
  detailFrom,
  listAwaitingContents,
  listItemFrom,
  listPortalContents,
  loadPortalContent,
  loadPortalMediaAsset,
  openListItemFrom,
  portalAccessHolds,
  requestContentChanges
} from './portal-service.js';
import type { ContentTransaction } from './service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface ContentPortalModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Injected by the tenancy module: the active client link is the only authorization of the portal. */
  readonly requireClientAccess: PreHandler;
  /** Undefined only where object storage is not configured: the route that signs a media is then not registered. */
  readonly media?: {
    readonly storage: Pick<MediaStorageClient, 'presignGetObject'>;
    readonly downloadUrlExpirySeconds: number;
  };
}

const AWAITING_DEFAULT_PAGE_SIZE = 20;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

/** A malformed id is the same 404 as an absent one, never a 400 that confirms the route exists. */
const contentIdFromRoute = (request: FastifyRequest): string => {
  const value = (request.params as Record<string, unknown>).contentId;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw contentNotFound();
  return value;
};

const assetIdFromRoute = (request: FastifyRequest): string => {
  const value = (request.params as Record<string, unknown>).assetId;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw mediaNotFound();
  return value;
};

/**
 * The contents of a client for its portal (#257, specs/conteudo.md sections 2, 4 and 6). Every route is guarded by the active client
 * link alone (`requireClientAccess`), and the client is always the one the guard proved. What the person reads is what
 * `app_private.portal_contents` gives, whoever the person also is: a collaborator of the agency who has a link with the client
 * gets the same cut as anyone else, because the route never selects from the table the agency's policy opens to them. The moves
 * are the database's (`approve_content`, `request_content_changes`); the route decides what the portal is told.
 */
export const registerContentPortalModule = (app: FastifyInstance, dependencies: ContentPortalModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  // Declared once per route: the same object is the documentation metadata and the source of the schemas the handler validates with.
  const periodDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: ClientPathParamsSchema, query: PortalContentPeriodQuerySchema, response: PortalContentPeriodResponseSchema }
  } satisfies DocumentedRouteConfig;
  const awaitingDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: ClientPathParamsSchema, query: PortalContentAwaitingQuerySchema, response: PortalContentAwaitingResponseSchema }
  } satisfies DocumentedRouteConfig;
  const readDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: PortalContentPathParamsSchema, response: PortalContentDetailSchema }
  } satisfies DocumentedRouteConfig;
  const approveDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: PortalContentPathParamsSchema, body: PortalApproveContentRequestSchema, response: PortalContentDetailSchema }
  } satisfies DocumentedRouteConfig;
  const requestChangesDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: PortalContentPathParamsSchema, body: PortalRequestContentChangesRequestSchema, response: PortalContentDetailSchema }
  } satisfies DocumentedRouteConfig;

  const portalGuards = (docs: DocumentedRouteConfig) => ({
    preHandler: [requireSession, dependencies.requireClientAccess],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  const portalClientIdOf = (request: FastifyRequest): string => {
    const clientContext = request.clientContext;
    if (clientContext === undefined) throw clientNotFound();
    return clientContext.clientId;
  };

  const inTransaction = <TResult>(claims: VerifiedUserClaims, work: (transaction: ContentTransaction) => Promise<TResult>): Promise<TResult> =>
    withAuthenticatedUserTransaction(dependencies.database, claims, work);

  /**
   * A refusal by the row-level security means the link or the client changed between the guard and the statement. The failed
   * transaction is aborted, so the link is read again in a new one: a person who lost it, or whose client was archived, is "not
   * found"; anyone else is refused. The portal never learns that a client is archived.
   */
  const explainRefusal = async (claims: VerifiedUserClaims, clientId: string): Promise<HttpError> =>
    (await inTransaction(claims, (transaction) => portalAccessHolds(transaction, clientId))) ? forbidden() : clientNotFound();

  /**
   * `A0062` is "not awaiting approval" for a content the person can still read, and "not found" for one that stopped being
   * readable while the request waited for the lock (cancelled by the agency): the portal reads it again in a new transaction.
   * The function answers `A0062` for a person who is also a collaborator and `A0060` for one who is not, so the answer is
   * decided here, by what the portal reads, and never by who the person is.
   */
  const explainState = async (claims: VerifiedUserClaims, clientId: string, contentId: string, action: PortalContentAction): Promise<HttpError> =>
    (await inTransaction(claims, (transaction) => loadPortalContent(transaction, clientId, contentId))) === undefined
      ? contentNotFound()
      : notAwaitingApproval(action);

  const portalMove = async <TResult>(
    request: FastifyRequest,
    scope: { readonly clientId: string; readonly contentId: string },
    action: PortalContentAction,
    work: (transaction: ContentTransaction) => Promise<TResult>
  ): Promise<TResult> => {
    const { claims } = requireAuth(request);
    try {
      return await inTransaction(claims, work);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (databaseErrorCode(error) === 'A0062') throw await explainState(claims, scope.clientId, scope.contentId, action);
      const translated = translatePortalError(error, action);
      if (translated !== undefined) throw translated;
      if (isInsufficientPrivilegeError(error)) throw await explainRefusal(claims, scope.clientId);
      throw error;
    }
  };

  /**
   * What the portal may move is what it may read: a content of THIS client that is not cancelled. Another client's content (even
   * of a client the person also has a link with), a cancelled one and an absent one are the same 404, and the function never
   * sees an id the portal could not read. A content in production is readable, but nothing is moved there: it is not awaiting.
   */
  const readForMove = async (
    transaction: ContentTransaction,
    scope: { readonly clientId: string; readonly contentId: string },
    action: PortalContentAction
  ): Promise<void> => {
    const row = await loadPortalContent(transaction, scope.clientId, scope.contentId);
    if (row === undefined) throw contentNotFound();
    if (row.status === 'in_production') throw notAwaitingApproval(action);
  };

  const readBack = async (transaction: ContentTransaction, scope: { readonly clientId: string; readonly contentId: string }): Promise<PortalContentDetail> => {
    const row = await loadPortalContent(transaction, scope.clientId, scope.contentId);
    if (row === undefined) throw contentNotFound();
    return detailFrom(transaction, row);
  };

  app.get('/clients/:clientId/contents', portalGuards(periodDocs), async (request, reply) => {
    const { claims } = requireAuth(request);
    const clientId = portalClientIdOf(request);
    routeParams(periodDocs, request);
    const query = routeQuery(periodDocs, request);
    const issue = contentPeriodIssue(query);
    if (issue !== undefined) {
      throw new HttpError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { issues: [{ path: issue.path, code: 'custom', message: issue.message }] }
      });
    }

    const rows = await inTransaction(claims, (transaction) => listPortalContents(transaction, clientId, query, CONTENT_PERIOD_MAX_ITEMS + 1));
    if (rows.length > CONTENT_PERIOD_MAX_ITEMS) throw periodTooLarge();

    return reply.send(routeResponse(periodDocs, request, {
      data: rows.map(listItemFrom),
      meta: { from: query.from, to: query.to, count: rows.length }
    }));
  });

  // Declared before the route of one content: the static segment is what `/awaiting-approval` is, never a content id.
  app.get('/clients/:clientId/contents/awaiting-approval', portalGuards(awaitingDocs), async (request, reply) => {
    const { claims } = requireAuth(request);
    const clientId = portalClientIdOf(request);
    routeParams(awaitingDocs, request);
    const resolved = resolvePagination(routeQuery(awaitingDocs, request), AWAITING_DEFAULT_PAGE_SIZE);

    const page = await inTransaction(claims, (transaction) => listAwaitingContents(transaction, clientId, resolved));

    return reply.send(routeResponse(awaitingDocs, request, {
      data: page.items.map((row) => openListItemFrom({ ...row, status: 'awaiting_approval' })),
      meta: buildPaginationMetadata(resolved, page.totalItems)
    }));
  });

  app.get('/clients/:clientId/contents/:contentId', portalGuards(readDocs), async (request, reply) => {
    const { claims } = requireAuth(request);
    const clientId = portalClientIdOf(request);
    const contentId = contentIdFromRoute(request);
    routeParams(readDocs, request);

    const detail = await inTransaction(claims, (transaction) => readBack(transaction, { clientId, contentId }));

    return reply.send(routeResponse(readDocs, request, detail));
  });

  const media = dependencies.media;
  if (media !== undefined) {
    const mediaUrlDocs = {
      permission: null,
      responseStatus: 200,
      schemas: { params: PortalContentMediaPathParamsSchema, query: PortalContentMediaUrlQuerySchema, response: PortalContentMediaUrlResponseSchema }
    } satisfies DocumentedRouteConfig;

    // Signs only a file of a content the portal reads (#584). The original's key is built from the agency the guard proved, because
    // `portal_content_media` does not return it. Only the original is audited, as in the agency's route (#550).
    // The same bucket as the agency's read URL (per user, one store): a person of both sides does not get 600 on each.
    const guards = portalGuards(mediaUrlDocs);
    const limiter = sharedUserRateLimit(app, MEDIA_READ_URL_BUCKET, MEDIA_RATE_LIMITS.downloadUrlPerUser);
    // `exposeHeadRoute: false`: a HEAD would sign and audit without handing the URL over (#593).
    app.get('/clients/:clientId/contents/:contentId/media/:assetId/url', { ...guards, preHandler: [...guards.preHandler, limiter], exposeHeadRoute: false }, async (request, reply) => {
      const { claims, userId } = requireAuth(request);
      const clientContext = request.clientContext;
      if (clientContext === undefined) throw clientNotFound();
      const contentId = contentIdFromRoute(request);
      const assetId = assetIdFromRoute(request);
      routeParams(mediaUrlDocs, request);
      const query = routeQuery(mediaUrlDocs, request);

      const objectKey = await inTransaction(claims, async (transaction) => {
        const content = await loadPortalContent(transaction, clientContext.clientId, contentId);
        if (content === undefined || content.status === 'in_production') throw contentNotFound();
        const asset = await loadPortalMediaAsset(transaction, contentId, assetId);
        if (asset === undefined) throw mediaNotFound();

        const originalKey = `${clientContext.agencyId}/${asset.assetId}/original.${asset.extension}`;
        if (query.variant === 'original') return originalKey;
        // An image has no generated thumbnail: its original is the thumbnail, as in the agency's route.
        if (asset.category === 'image') return originalKey;
        if (asset.thumbnailObjectKey !== null) return asset.thumbnailObjectKey;
        throw asset.videoProcessingStatus === 'failed' ? variantProcessingFailed() : variantNotReady();
      });

      const url = await media.storage.presignGetObject({ key: objectKey, expiresInSeconds: media.downloadUrlExpirySeconds });
      // Only the original is audited, and only once its URL is signed (#593): a refused signature leaves no event behind.
      if (query.variant === 'original') {
        await inTransaction(claims, (transaction) => auditMediaEvent(transaction, { action: 'media.download_url_issued', actorUserId: userId, agencyId: clientContext.agencyId, targetId: assetId }));
      }
      const expiresAt = new Date(Date.now() + media.downloadUrlExpirySeconds * 1_000).toISOString();
      return reply.send(routeResponse(mediaUrlDocs, request, { url, expiresAt }));
    });
  }

  app.post('/clients/:clientId/contents/:contentId/approve', portalGuards(approveDocs), async (request, reply) => {
    const clientId = portalClientIdOf(request);
    const contentId = contentIdFromRoute(request);
    routeParams(approveDocs, request);
    const body = routeBody(approveDocs, request);
    const scope = { clientId, contentId };

    const detail = await portalMove(request, scope, 'approve', async (transaction) => {
      await readForMove(transaction, scope, 'approve');
      await approveContent(transaction, { contentId, revision: body.revision });
      return readBack(transaction, scope);
    });

    return reply.send(routeResponse(approveDocs, request, detail));
  });

  app.post('/clients/:clientId/contents/:contentId/request-changes', portalGuards(requestChangesDocs), async (request, reply) => {
    const clientId = portalClientIdOf(request);
    const contentId = contentIdFromRoute(request);
    routeParams(requestChangesDocs, request);
    const body = routeBody(requestChangesDocs, request);
    const scope = { clientId, contentId };

    const detail = await portalMove(request, scope, 'request-changes', async (transaction) => {
      await readForMove(transaction, scope, 'request-changes');
      await requestContentChanges(transaction, { contentId, revision: body.revision, comment: body.comment });
      return readBack(transaction, scope);
    });

    return reply.send(routeResponse(requestChangesDocs, request, detail));
  });
};
