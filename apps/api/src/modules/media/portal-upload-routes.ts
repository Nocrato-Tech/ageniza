import {
  ClientMaterialRequestUploadAssetPathParamsSchema,
  ClientThreadPathParamsSchema,
  CompletePortalMaterialUploadRequestSchema,
  CompletePortalMaterialUploadResponseSchema,
  CreatePortalMaterialUploadRequestSchema,
  CreatePortalMaterialUploadResponseSchema,
  PORTAL_MATERIAL_UPLOAD_MAX_BYTES,
  PortalMaterialUploadListQuerySchema,
  PortalMaterialUploadListResponseSchema,
  PortalMaterialUploadRejectionReasonSchema,
  buildPaginationMetadata,
  resolvePagination
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { sharedUserRateLimit } from '../../plugins/infra/rate-limit.js';
import { routeBody, routeParams, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import { downloadResponseHeaders, MEDIA_RATE_LIMITS, MEDIA_READ_URL_BUCKET, type MediaLimits } from './policy.js';
import { portalRequestNotFound, portalUploadNotPending, portalUploadRejected, translatePortalUploadError } from './portal-upload-errors.js';
import {
  confirmPortalUpload,
  listAllOwnPortalUploads,
  listPortalUploadsPage,
  lockPortalUploadCompletion,
  portalUploadExtension,
  portalUploadKeys,
  rejectPortalUpload,
  startPortalUpload,
  type PortalUploadSettings
} from './portal-upload-service.js';
import type { MediaModuleConfig } from './routes.js';
import { auditMediaEvent } from './service.js';
import type { MediaStorageClient } from './storage-client.js';
import { copyAndInspectStagedObject } from './upload-inspection.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface PortalUploadRouteDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly storage: MediaStorageClient;
  readonly config: MediaModuleConfig;
  /** Injected by the tenancy module: the active client link is the only authorization of the portal. */
  readonly requireClientAccess: PreHandler;
}

/** The ceiling of the portal is the one of every category it takes: the shared judge reads it as the limits of the library. */
const PORTAL_LIMITS = (config: MediaModuleConfig): MediaLimits => ({
  maxImageBytes: PORTAL_MATERIAL_UPLOAD_MAX_BYTES,
  maxVideoBytes: PORTAL_MATERIAL_UPLOAD_MAX_BYTES,
  multipartThresholdBytes: config.multipartThresholdBytes
});

const REJECTION_REASONS: ReadonlySet<string> = new Set(PortalMaterialUploadRejectionReasonSchema.options);

/**
 * The reason the portal answers for a refusal of the shared judge. The judge says more than the portal may (an object that never came, an
 * SVG), and the database only records the six reasons of the contract: a missing object is an empty one, and anything the judge says that
 * the portal has no word for is a type that is not what it declared.
 */
export const portalRejectionReason = (judgeReason: string): string => {
  if (REJECTION_REASONS.has(judgeReason)) return judgeReason;
  return judgeReason === 'object_not_found' ? 'empty_object' : 'content_type_mismatch';
};

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });

/**
 * The upload of material by the person of the portal (decision 2026-11-11 "o cliente envia material pelo portal"): three routes under the
 * active client link alone, the cycle of the agency's upload in one part (start, a direct PUT, complete), and the list of what the person
 * sent. The client is always the one the guard proved, never a request value, and the keys of the storage never leave the server.
 */
export const registerPortalUploadRoutes = (app: FastifyInstance, dependencies: PortalUploadRouteDependencies): void => {
  const { database, storage, config } = dependencies;
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const settings: PortalUploadSettings = {
    quotaDefaultBytes: config.quotaDefaultBytes,
    quotaDefaultObjectCount: config.quotaDefaultObjectCount,
    reservationSeconds: config.uploadUrlExpirySeconds
  };
  const limits = PORTAL_LIMITS(config);
  const downloadUrlLimiter = sharedUserRateLimit(app, MEDIA_READ_URL_BUCKET, MEDIA_RATE_LIMITS.downloadUrlPerUser);
  const issuanceRateLimit = {
    rateLimit: { max: MEDIA_RATE_LIMITS.signedUrlIssuance.max, timeWindow: MEDIA_RATE_LIMITS.signedUrlIssuance.windowMs, addHeaders: false }
  };

  const startDocs = {
    permission: null,
    responseStatus: 201,
    schemas: { params: ClientThreadPathParamsSchema, body: CreatePortalMaterialUploadRequestSchema, response: CreatePortalMaterialUploadResponseSchema }
  } satisfies DocumentedRouteConfig;
  const completeDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: ClientMaterialRequestUploadAssetPathParamsSchema, body: CompletePortalMaterialUploadRequestSchema, response: CompletePortalMaterialUploadResponseSchema }
  } satisfies DocumentedRouteConfig;
  const listDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: ClientThreadPathParamsSchema, query: PortalMaterialUploadListQuerySchema, response: PortalMaterialUploadListResponseSchema }
  } satisfies DocumentedRouteConfig;

  const guards = (docs: DocumentedRouteConfig, extraConfig: Record<string, unknown> = {}, afterGuards: readonly preHandlerAsyncHookHandler[] = []) => ({
    preHandler: [requireSession, dependencies.requireClientAccess, ...afterGuards],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas, ...extraConfig }
  });

  const caller = (request: FastifyRequest) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const clientContext = request.clientContext;
    if (clientContext === undefined) throw portalRequestNotFound();
    return { auth, clientId: clientContext.clientId, agencyId: clientContext.agencyId };
  };

  // A refusal of the database is the neutral answer of the portal; whatever is not one is the caller's unexpected error, never forwarded.
  const answering = async <TResult>(work: Promise<TResult>): Promise<TResult> => {
    try {
      return await work;
    } catch (error) {
      throw translatePortalUploadError(error) ?? error;
    }
  };

  const base = '/clients/:clientId/material-requests/:threadId/uploads';

  app.post(base, guards(startDocs, issuanceRateLimit), async (request, reply) => {
    const { auth, clientId } = caller(request);
    const params = routeParams(startDocs, request);
    const body = routeBody(startDocs, request);
    const expiresAt = new Date(Date.now() + config.uploadUrlExpirySeconds * 1_000).toISOString();

    const started = await answering(withAuthenticatedUserTransaction(database, auth.claims, async (transaction) => {
      const reserved = await startPortalUpload(transaction, {
        clientId,
        threadId: params.threadId,
        contentType: body.contentType,
        declaredSizeBytes: body.declaredSizeBytes,
        fileName: body.fileName,
        settings
      });
      const url = await storage.presignPutObject({ key: reserved.uploadObjectKey, contentType: reserved.contentType, expiresInSeconds: config.uploadUrlExpirySeconds });
      await auditMediaEvent(transaction, { action: 'media.upload_initiated', actorUserId: auth.userId, agencyId: reserved.agencyId, targetId: reserved.assetId });
      return { ...reserved, url };
    }));

    return reply.status(201).send(routeResponse(startDocs, request, {
      assetId: started.assetId,
      category: started.category,
      contentType: started.contentType,
      upload: { type: 'single', url: started.url, expiresAt }
    }));
  });

  app.post(`${base}/:assetId/complete`, guards(completeDocs, issuanceRateLimit), async (request, reply) => {
    const { auth, clientId, agencyId } = caller(request);
    const params = routeParams(completeDocs, request);
    routeBody(completeDocs, request);

    // One transaction, as the agency's completion is: the lock of the file is held while the bytes are read and until the verdict is
    // written, so the object that is judged is the object that is kept.
    const result = await answering(withAuthenticatedUserTransaction(database, auth.claims, async (transaction) => {
      const own = (await listAllOwnPortalUploads(transaction, { clientId, threadId: params.threadId })).find((file) => file.asset_id === params.assetId);
      if (own === undefined) throw portalRequestNotFound();
      await lockPortalUploadCompletion(transaction, params.assetId);
      // After the lock: a completion that held it before has already finished the file.
      const file = (await listAllOwnPortalUploads(transaction, { clientId, threadId: params.threadId })).find((candidate) => candidate.asset_id === params.assetId);
      if (file === undefined) throw portalRequestNotFound();
      if (file.status !== 'pending') throw portalUploadNotPending();

      const { canonicalKey, stagingKey } = portalUploadKeys(agencyId, params.assetId, file.content_type);
      const copy = { made: false };
      try {
        const inspection = await copyAndInspectStagedObject(storage, limits, {
          stagingKey,
          canonicalKey,
          declaredContentType: file.content_type,
          category: file.category,
          maxCopyBytes: PORTAL_MATERIAL_UPLOAD_MAX_BYTES,
          onCopied: () => { copy.made = true; }
        });

        let rejection: { readonly reason: string; readonly recorded: boolean } | undefined;
        if (!inspection.stagingFound) {
          rejection = { reason: portalRejectionReason('object_not_found'), recorded: false };
        } else if (inspection.verdict.ok && inspection.copied && inspection.head !== undefined) {
          const verdict = await confirmPortalUpload(transaction, {
            assetId: params.assetId,
            sizeBytes: inspection.head.sizeBytes,
            contentType: inspection.verdict.contentType,
            dimensions: inspection.verdict.dimensions,
            settings
          });
          if (verdict.outcome === 'confirmed') {
            await auditMediaEvent(transaction, { action: 'media.upload_confirmed', actorUserId: auth.userId, agencyId, targetId: params.assetId });
            return { confirmed: true as const, sizeBytes: inspection.head.sizeBytes, contentType: inspection.verdict.contentType, stagingKey };
          }
          rejection = { reason: verdict.reason, recorded: true };
        } else if (!inspection.verdict.ok) {
          rejection = { reason: portalRejectionReason(inspection.verdict.reason), recorded: false };
        } else {
          rejection = { reason: portalRejectionReason('object_not_found'), recorded: false };
        }

        // The object that was copied is not kept, and it is removed before the refusal is written: a failure to remove it rolls the refusal back.
        if (copy.made) await storage.deleteObject({ key: canonicalKey });
        copy.made = false;
        if (!rejection.recorded) await rejectPortalUpload(transaction, params.assetId, rejection.reason);
        await auditMediaEvent(transaction, { action: 'media.upload_rejected', actorUserId: auth.userId, agencyId, targetId: params.assetId });
        return { confirmed: false as const, reason: rejection.reason, stagingKey };
      } catch (error) {
        // Still under the lock: nothing else is copying to this key, so what was copied here is only this attempt's.
        if (copy.made) {
          try {
            await storage.deleteObject({ key: canonicalKey });
          } catch (cleanupError) {
            request.log.error({ error: { name: cleanupError instanceof Error ? cleanupError.name : 'UnknownError', code: 'PORTAL_UPLOAD_CANONICAL_CLEANUP_FAILED' } }, 'Failed to remove canonical object after a portal upload failed');
          }
        }
        throw error;
      }
    }));

    // Best effort, after the commit: the browser can mutate only the staging key, and the bucket lifecycle removes it anyway.
    try {
      await storage.deleteObject({ key: result.stagingKey });
    } catch (error) {
      request.log.warn({ error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'PORTAL_UPLOAD_STAGING_CLEANUP_FAILED' } }, 'Failed to remove portal upload staging object');
    }

    if (!result.confirmed) throw portalUploadRejected(result.reason);
    return reply.send(routeResponse(completeDocs, request, {
      assetId: params.assetId,
      status: 'confirmed',
      sizeBytes: result.sizeBytes,
      contentType: result.contentType
    }));
  });

  // `exposeHeadRoute: false`: Fastify would answer HEAD with this handler, which signs URLs without handing them over (#593).
  app.get(base, { ...guards(listDocs, {}, [downloadUrlLimiter]), exposeHeadRoute: false }, async (request, reply) => {
    const { auth, clientId } = caller(request);
    const params = routeParams(listDocs, request);
    const query = routeQuery(listDocs, request);
    const pagination = resolvePagination(query, 48);

    const page = await answering(withAuthenticatedUserTransaction(database, auth.claims, (transaction) =>
      listPortalUploadsPage(transaction, { clientId, threadId: params.threadId, limit: pagination.pageSize, offset: pagination.offset })));

    const data = await Promise.all(page.rows.map(async (row) => ({
      id: row.asset_id,
      status: row.status,
      category: row.category,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      name: row.file_name,
      width: row.width,
      height: row.height,
      // Only the key of a confirmed file reaches here, from the database; it is signed and dropped, never part of the answer.
      url: row.object_key === null
        ? null
        : await storage.presignGetObject({
          key: row.object_key,
          expiresInSeconds: config.downloadUrlExpirySeconds,
          ...downloadResponseHeaders({
            category: row.category,
            confirmedContentType: row.content_type,
            fileName: row.file_name,
            extension: portalUploadExtension(row.content_type)
          })
        }),
      createdAt: new Date(row.created_at).toISOString()
    })));

    return reply.send(routeResponse(listDocs, request, { data, meta: buildPaginationMetadata(pagination, page.total) }));
  });
};
