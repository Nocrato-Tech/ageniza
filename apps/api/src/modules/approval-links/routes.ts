import {
  PORTAL_APPROVAL_TOKEN_PATTERN,
  PortalApprovalApproveRequestSchema,
  PortalApprovalBatchSchema,
  PortalApprovalContentPathParamsSchema,
  PortalApprovalContentSchema,
  PortalApprovalExchangeRequestSchema,
  PortalApprovalExchangeResponseSchema,
  PortalApprovalMediaPathParamsSchema,
  PortalApprovalMediaUrlQuerySchema,
  PortalApprovalMediaUrlResponseSchema,
  PortalApprovalNoQuerySchema,
  PortalApprovalRequestChangesRequestSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { isRetryableConflict, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import { tryAgain } from '../../plugins/infra/conflict.js';
import { noStore } from '../../plugins/infra/no-store.js';
import { normalizeRateLimitIp } from '../../plugins/infra/rate-limit-ip.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeParams, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import { contentNotFound } from '../contents/errors.js';
import { mediaNotFound, variantNotReady, variantProcessingFailed, type PortalContentAction } from '../contents/portal-errors.js';
import type { ContentTransaction } from '../contents/service.js';
import type { MediaStorageClient } from '../media/storage-client.js';
import { approvalLinkInvalid, translateApprovalError } from './errors.js';
import { APPROVAL_MEDIA_URL_MAX_SECONDS, APPROVAL_RATE_LIMITS, APPROVAL_ROUTE_PREFIX } from './policy.js';
import { createWindowCounter, limitBy, type LimitRule, type WindowCounter } from './rate-limit.js';
import {
  approveByLink,
  exchangeApprovalToken,
  findBatchMediaAsset,
  loadBatch,
  loadBatchContent,
  loadBatchMedia,
  requestChangesByLink
} from './service.js';
import { approvalSessionTokenOf, generateApprovalSessionToken, hashApprovalToken, serializeApprovalCookie, type ApprovalCookieOptions } from './tokens.js';

export interface ApprovalLinkModuleDependencies {
  readonly database: DatabaseClient;
  readonly cookie: ApprovalCookieOptions;
  /** Test seam: the counter of the limits. */
  readonly counter?: WindowCounter;
  /** Undefined only where object storage is not configured: the route that signs a media is then not registered. */
  readonly media?: {
    readonly storage: Pick<MediaStorageClient, 'presignGetObject'>;
    readonly downloadUrlExpirySeconds: number;
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
 * The approval link of the e-mail (issue #712, decision 2026-10-26). No route here has an account: the person has an e-mail and a
 * link, and the only credential is the cookie that the token of the link was exchanged for. Every call goes to the database with no
 * actor bound, and the database judges the revocation at every use (access, generation, client, agency, plan); the routes translate.
 *
 * - The token is in the body of one POST and nowhere else: no route takes a query (a token in a URL is a 400), the paths carry
 *   only ids of the batch, and the cookie holds the session, not the token.
 * - Opening the link decides nothing: the exchange and the reads change no content; Aprovar and Pedir ajuste are POSTs.
 * - Every answer is `no-store`, and the API answers `Referrer-Policy: no-referrer` globally.
 * - Rate limits count by IP and by the digest of the token or of the session, never by the value.
 */
export const registerApprovalLinkModule = (app: FastifyInstance, dependencies: ApprovalLinkModuleDependencies): void => {
  const { database, cookie } = dependencies;

  const exchangeDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { query: PortalApprovalNoQuerySchema, body: PortalApprovalExchangeRequestSchema, response: PortalApprovalExchangeResponseSchema }
  } satisfies DocumentedRouteConfig;
  const batchDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { query: PortalApprovalNoQuerySchema, response: PortalApprovalBatchSchema }
  } satisfies DocumentedRouteConfig;
  const mediaUrlDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: PortalApprovalMediaPathParamsSchema, query: PortalApprovalMediaUrlQuerySchema, response: PortalApprovalMediaUrlResponseSchema }
  } satisfies DocumentedRouteConfig;
  const approveDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: PortalApprovalContentPathParamsSchema, query: PortalApprovalNoQuerySchema, body: PortalApprovalApproveRequestSchema, response: PortalApprovalContentSchema }
  } satisfies DocumentedRouteConfig;
  const requestChangesDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: PortalApprovalContentPathParamsSchema, query: PortalApprovalNoQuerySchema, body: PortalApprovalRequestChangesRequestSchema, response: PortalApprovalContentSchema }
  } satisfies DocumentedRouteConfig;

  const routeOptions = (docs: DocumentedRouteConfig, preHandler: preHandlerAsyncHookHandler[]) => ({
    // Set as the `onRequest` hook so a 400 or a 404 raised later carries it too.
    onRequest: [noStore],
    preHandler,
    // A HEAD would run the same handler without handing the answer over.
    exposeHeadRoute: false,
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  // One counter for the module: a bucket is the scope of the rule plus the address or the digest, so the routes of a scope share it.
  const counter = dependencies.counter ?? createWindowCounter();

  const byIp = (scope: string) => (request: FastifyRequest): string => `${scope}:ip:${normalizeRateLimitIp(request.ip)}`;
  const bySession = (scope: string) => (request: FastifyRequest): string => {
    const session = approvalSessionTokenOf(request.headers.cookie);
    return session === undefined ? byIp(scope)(request) : `${scope}:session:${hashApprovalToken(session)}`;
  };
  const byToken = (scope: string) => (request: FastifyRequest): string => {
    const token = (request.body as { token?: unknown } | null | undefined)?.token;
    return typeof token === 'string' ? `${scope}:token:${hashApprovalToken(token)}` : byIp(scope)(request);
  };

  const rules = (first: LimitRule, second: LimitRule): preHandlerAsyncHookHandler[] => [limitBy(counter, [first, second])];
  const exchangeLimiters = rules(
    { window: APPROVAL_RATE_LIMITS.exchangePerIp, key: byIp('approval-exchange') },
    { window: APPROVAL_RATE_LIMITS.exchangePerToken, key: byToken('approval-exchange') }
  );
  const decideLimiters = rules(
    { window: APPROVAL_RATE_LIMITS.decidePerIp, key: byIp('approval-decide') },
    { window: APPROVAL_RATE_LIMITS.decidePerSession, key: bySession('approval-decide') }
  );
  const readLimiters = rules(
    { window: APPROVAL_RATE_LIMITS.readPerIp, key: byIp('approval-read') },
    { window: APPROVAL_RATE_LIMITS.readPerSession, key: bySession('approval-read') }
  );

  /** The session of the cookie, hashed. A request without a valid-looking cookie is the dead link and never reaches the database. */
  const sessionHashOf = (request: FastifyRequest): string => {
    const token = approvalSessionTokenOf(request.headers.cookie);
    if (token === undefined) throw approvalLinkInvalid();
    return hashApprovalToken(token);
  };

  /** No account is bound to these transactions: the database knows the person by the session alone. */
  const inTransaction = async <TResult>(action: PortalContentAction | 'read', work: (transaction: ContentTransaction) => Promise<TResult>): Promise<TResult> => {
    try {
      return await database.transaction(work);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const translated = translateApprovalError(error, action);
      if (translated !== undefined) throw translated;
      if (isRetryableConflict(error)) throw tryAgain();
      throw error;
    }
  };

  app.post(`${APPROVAL_ROUTE_PREFIX}/session`, routeOptions(exchangeDocs, exchangeLimiters), async (request, reply) => {
    routeQuery(exchangeDocs, request);
    const body = routeBody(exchangeDocs, request);
    // A token of another shape was not issued by us: refused before the database, like any malformed body.
    if (!PORTAL_APPROVAL_TOKEN_PATTERN.test(body.token)) {
      throw new HttpError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { issues: [{ path: 'token', code: 'invalid_string', message: 'The token of the link is malformed.' }] }
      });
    }
    const sessionToken = generateApprovalSessionToken();

    const session = await inTransaction('read', (transaction) => exchangeApprovalToken(transaction, hashApprovalToken(body.token), hashApprovalToken(sessionToken)));

    reply.header('set-cookie', serializeApprovalCookie(sessionToken, (session.sessionExpiresAt.getTime() - Date.now()) / 1_000, cookie));
    return reply.send(routeResponse(exchangeDocs, request, {
      sessionExpiresAt: session.sessionExpiresAt.toISOString(),
      linkExpiresAt: session.linkExpiresAt.toISOString()
    }));
  });

  app.get(`${APPROVAL_ROUTE_PREFIX}/batch`, routeOptions(batchDocs, readLimiters), async (request, reply) => {
    routeQuery(batchDocs, request);
    const sessionHash = sessionHashOf(request);
    const { batch } = await inTransaction('read', (transaction) => loadBatch(transaction, sessionHash));
    return reply.send(routeResponse(batchDocs, request, batch));
  });

  const media = dependencies.media;
  if (media !== undefined) {
    // The original's key is built from the agency of the batch, because the function does not return it. Signed for minutes.
    app.get(`${APPROVAL_ROUTE_PREFIX}/contents/:contentId/media/:assetId/url`, routeOptions(mediaUrlDocs, readLimiters), async (request, reply) => {
      const contentId = contentIdFromRoute(request);
      const assetId = assetIdFromRoute(request);
      routeParams(mediaUrlDocs, request);
      const query = routeQuery(mediaUrlDocs, request);
      const sessionHash = sessionHashOf(request);

      const objectKey = await inTransaction('read', async (transaction) => {
        const { agencyId, batch } = await loadBatch(transaction, sessionHash);
        const content = batch.contents.find((candidate) => candidate.id === contentId);
        if (content === undefined || content.status === 'in_production') throw contentNotFound();
        const asset = findBatchMediaAsset(await loadBatchMedia(transaction, sessionHash), contentId, assetId);
        if (asset === undefined) throw mediaNotFound();

        const originalKey = `${agencyId}/${asset.assetId}/original.${asset.extension}`;
        if (query.variant === 'original') return originalKey;
        // An image has no generated thumbnail: its original is the thumbnail, as in the portal's route.
        if (asset.category === 'image') return originalKey;
        if (asset.thumbnailObjectKey !== null) return asset.thumbnailObjectKey;
        throw asset.videoProcessingStatus === 'failed' ? variantProcessingFailed() : variantNotReady();
      });

      const expiresInSeconds = Math.min(media.downloadUrlExpirySeconds, APPROVAL_MEDIA_URL_MAX_SECONDS);
      const url = await media.storage.presignGetObject({ key: objectKey, expiresInSeconds });
      return reply.send(routeResponse(mediaUrlDocs, request, { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1_000).toISOString() }));
    });
  }

  app.post(`${APPROVAL_ROUTE_PREFIX}/contents/:contentId/approve`, routeOptions(approveDocs, decideLimiters), async (request, reply) => {
    const contentId = contentIdFromRoute(request);
    routeParams(approveDocs, request);
    routeQuery(approveDocs, request);
    const body = routeBody(approveDocs, request);
    const sessionHash = sessionHashOf(request);

    const content = await inTransaction('approve', async (transaction) => {
      await approveByLink(transaction, { sessionHash, contentId, revision: body.revision });
      return loadBatchContent(transaction, sessionHash, contentId);
    });
    if (content === undefined) throw contentNotFound();
    return reply.send(routeResponse(approveDocs, request, content));
  });

  app.post(`${APPROVAL_ROUTE_PREFIX}/contents/:contentId/request-changes`, routeOptions(requestChangesDocs, decideLimiters), async (request, reply) => {
    const contentId = contentIdFromRoute(request);
    routeParams(requestChangesDocs, request);
    routeQuery(requestChangesDocs, request);
    const body = routeBody(requestChangesDocs, request);
    const sessionHash = sessionHashOf(request);

    const content = await inTransaction('request-changes', async (transaction) => {
      await requestChangesByLink(transaction, { sessionHash, contentId, revision: body.revision, comment: body.comment });
      return loadBatchContent(transaction, sessionHash, contentId);
    });
    if (content === undefined) throw contentNotFound();
    return reply.send(routeResponse(requestChangesDocs, request, content));
  });
};
