import { randomUUID } from 'node:crypto';

import {
  AgencyMediaAssetPathParamsSchema,
  AgencyPathParamsSchema,
  CompleteMediaUploadRequestSchema,
  CompleteMediaUploadResponseSchema,
  CreateMediaUploadRequestSchema,
  CreateMediaUploadResponseSchema,
  MediaDownloadUrlQuerySchema,
  MediaDownloadUrlResponseSchema,
  RequestMediaUploadPartsRequestSchema,
  RequestMediaUploadPartsResponseSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';
import type { MediaJobDispatcher } from './job-dispatcher.js';
import {
  describeMediaContentType,
  maxBytesForCategory,
  MEDIA_RATE_LIMITS,
  multipartPlan,
  usesMultipartUpload,
  type MediaLimits
} from './policy.js';
import {
  auditMediaEvent,
  findConfirmedAssetWithVariants,
  insertPendingAsset,
  lockAgencyStorageQuota,
  lockAssetForCompletion,
  markAssetConfirmed,
  markAssetRejected,
  readQuotaSnapshot,
  setMultipartUploadId,
  touchPendingAsset
} from './service.js';
import type { MediaStorageClient } from './storage-client.js';

export type MediaPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface MediaModuleConfig extends MediaLimits {
  readonly multipartPartBytes: number;
  readonly uploadUrlExpirySeconds: number;
  readonly downloadUrlExpirySeconds: number;
  readonly quotaDefaultBytes: number;
  readonly quotaDefaultObjectCount: number;
}

export interface MediaModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly storage: MediaStorageClient;
  readonly config: MediaModuleConfig;
  readonly requireAgencyAccess: MediaPreHandler;
  readonly requirePermission: (key: string) => MediaPreHandler;
  /** Undefined only in tests that never confirm a video upload; queues the worker's thumbnail/
   * preview job (issue #24) right after a video's `HeadObject` confirms it. */
  readonly jobs?: MediaJobDispatcher;
}

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
const assetNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Media asset not found.' });
const unsupportedType = (): HttpError => new HttpError({
  statusCode: 415,
  code: 'UNSUPPORTED_MEDIA_TYPE',
  message: 'This content type is not accepted.'
});
const payloadTooLarge = (): HttpError => new HttpError({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The declared file size exceeds the limit for its category.' });
const quotaExceeded = (): HttpError => new HttpError({ statusCode: 409, code: 'QUOTA_EXCEEDED', message: 'This agency has reached its storage quota.' });
const notPending = (): HttpError => new HttpError({ statusCode: 409, code: 'UPLOAD_NOT_PENDING', message: 'This upload is not pending confirmation.' });
const invalidMultipartPart = (): HttpError => new HttpError({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'A multipart part number is outside this upload plan.' });
const uploadRejected = (reason: string): HttpError => new HttpError({ statusCode: 422, code: 'UPLOAD_REJECTED', message: `The uploaded object was rejected: ${reason}.`, details: { reason } });
const variantNotReady = (): HttpError => new HttpError({ statusCode: 409, code: 'VARIANT_NOT_READY', message: 'This variant has not been generated yet.' });
const variantProcessingFailed = (reason: string | null): HttpError => new HttpError({
  statusCode: 409,
  code: 'VARIANT_PROCESSING_FAILED',
  message: reason === 'duration_exceeds_limit'
    ? 'The video exceeds the supported duration limit.'
    : reason === 'processing_timed_out'
      ? 'Video processing exceeded its time limit.'
      : 'Video processing failed.',
  details: { reason: reason ?? 'processing_failed' }
});

type CompletionResult = {
  readonly ok: true;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly uploadObjectKey: string;
} | {
  readonly ok: false;
  readonly reason: string;
};

const routeParams = <T>(schema: z.ZodType<T>, request: FastifyRequest): T => parseRequest(schema, request.params);

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

const objectKeyFor = (agencyId: string, assetId: string, extension: string): string => `${agencyId}/${assetId}/original.${extension}`;
// All temporary objects share a leading prefix so R2 lifecycle can expire them without matching
// canonical originals or generated variants. R2 lifecycle filters support prefixes, not suffixes.
const uploadObjectKeyFor = (agencyId: string, assetId: string, extension: string): string =>
  `staging/${agencyId}/${assetId}/upload.${extension}`;

/** Registers the direct-to-R2 upload routes (issue #21). Every route requires `requireAgencyAccess`
 * then `requirePermission('midia.enviar')`, so a signed URL is emitted only after tenant and
 * capability are both confirmed -- an agency never obtains a URL for another agency's object,
 * because the object key, the DB row, and RLS are all scoped to `:agencyId` end to end. */
export const registerMediaModule = (app: FastifyInstance, dependencies: MediaModuleDependencies): void => {
  const { database, storage, config } = dependencies;
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const guarded = (
    docs: DocumentedRouteConfig & { permission: string },
    extraConfig: Record<string, unknown> = {}
  ) => ({
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(docs.permission)],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas, ...extraConfig }
  });
  const uploadUrlRateLimit = {
    rateLimit: {
      max: MEDIA_RATE_LIMITS.signedUrlIssuance.max,
      timeWindow: MEDIA_RATE_LIMITS.signedUrlIssuance.windowMs,
      addHeaders: false
    }
  };

  // Declared once per route: the same object is the documentation metadata and the source of the
  // schemas the handler validates with.
  const uploadDocs = {
    permission: 'midia.enviar',
    responseStatus: 201,
    schemas: { params: AgencyPathParamsSchema, body: CreateMediaUploadRequestSchema, response: CreateMediaUploadResponseSchema }
  } satisfies DocumentedRouteConfig;
  const partsDocs = {
    permission: 'midia.enviar',
    responseStatus: 200,
    schemas: { params: AgencyMediaAssetPathParamsSchema, body: RequestMediaUploadPartsRequestSchema, response: RequestMediaUploadPartsResponseSchema }
  } satisfies DocumentedRouteConfig;
  const completeDocs = {
    permission: 'midia.enviar',
    responseStatus: 200,
    schemas: { params: AgencyMediaAssetPathParamsSchema, body: CompleteMediaUploadRequestSchema, response: CompleteMediaUploadResponseSchema }
  } satisfies DocumentedRouteConfig;
  const downloadDocs = {
    permission: 'midia.enviar',
    responseStatus: 200,
    schemas: { params: AgencyMediaAssetPathParamsSchema, query: MediaDownloadUrlQuerySchema, response: MediaDownloadUrlResponseSchema }
  } satisfies DocumentedRouteConfig;

  app.post('/agencies/:agencyId/media/uploads', guarded(uploadDocs, uploadUrlRateLimit), async (request, reply) => {
    const auth = requireAuth(request);
    const params = routeParams(uploadDocs.schemas.params, request);
    const body = parseRequest(uploadDocs.schemas.body, request.body);

    const descriptor = describeMediaContentType(body.contentType);
    if (descriptor === undefined) throw unsupportedType();
    if (body.declaredSizeBytes > maxBytesForCategory(config, descriptor.category)) throw payloadTooLarge();

    const assetId = randomUUID();
    const objectKey = objectKeyFor(params.agencyId, assetId, descriptor.extension);
    const uploadObjectKey = uploadObjectKeyFor(params.agencyId, assetId, descriptor.extension);
    const expiresAt = new Date(Date.now() + config.uploadUrlExpirySeconds * 1_000).toISOString();

    const upload = await withAuthenticatedUserTransaction(database, auth.claims, async (transaction) => {
      await lockAgencyStorageQuota(transaction, params.agencyId);
      const quota = await readQuotaSnapshot(transaction, params.agencyId, {
        quotaBytes: config.quotaDefaultBytes,
        quotaObjectCount: config.quotaDefaultObjectCount
      }, { pendingReservationSeconds: config.uploadUrlExpirySeconds });
      if (quota.usedBytes + body.declaredSizeBytes > quota.quotaBytes) throw quotaExceeded();
      if (quota.usedObjectCount + 1 > quota.quotaObjectCount) throw quotaExceeded();

      await insertPendingAsset(transaction, {
        id: assetId,
        agencyId: params.agencyId,
        category: descriptor.category,
        declaredContentType: body.contentType,
        extension: descriptor.extension,
        objectKey,
        uploadObjectKey,
        declaredSizeBytes: body.declaredSizeBytes,
        createdByUserId: auth.userId
      });

      if (usesMultipartUpload(config, body.declaredSizeBytes)) {
        const { uploadId } = await storage.createMultipartUpload({ key: uploadObjectKey, contentType: body.contentType });
        await setMultipartUploadId(transaction, assetId, uploadId);
        const plan = multipartPlan(body.declaredSizeBytes, config.multipartPartBytes);
        await auditMediaEvent(transaction, { action: 'media.upload_initiated', actorUserId: auth.userId, agencyId: params.agencyId, targetId: assetId });
        return { type: 'multipart' as const, uploadId, partSizeBytes: plan.partSizeBytes, partCount: plan.partCount };
      }

      const url = await storage.presignPutObject({ key: uploadObjectKey, contentType: body.contentType, expiresInSeconds: config.uploadUrlExpirySeconds });
      await auditMediaEvent(transaction, { action: 'media.upload_initiated', actorUserId: auth.userId, agencyId: params.agencyId, targetId: assetId });
      return { type: 'single' as const, url };
    });

    return reply.status(201).send(parseResponse(uploadDocs.schemas.response, {
      assetId,
      objectKey,
      category: descriptor.category,
      upload: upload.type === 'single'
        ? { type: 'single', url: upload.url, expiresAt }
        : { type: 'multipart', uploadId: upload.uploadId, partSizeBytes: upload.partSizeBytes, partCount: upload.partCount }
    }));
  });

  app.post('/agencies/:agencyId/media/uploads/:assetId/parts', guarded(partsDocs, uploadUrlRateLimit), async (request, reply) => {
    const auth = requireAuth(request);
    const params = routeParams(partsDocs.schemas.params, request);
    const body = parseRequest(partsDocs.schemas.body, request.body);
    const expiresAt = new Date(Date.now() + config.uploadUrlExpirySeconds * 1_000).toISOString();

    const parts = await withAuthenticatedUserTransaction(database, auth.claims, async (transaction) => {
      const asset = await lockAssetForCompletion(transaction, params.assetId, params.agencyId);
      if (asset === undefined) throw assetNotFound();
      if (asset.status !== 'pending' || asset.multipart_upload_id === null) throw notPending();
      const plan = multipartPlan(Number(asset.declared_size_bytes), config.multipartPartBytes);
      if (body.partNumbers.some((partNumber) => partNumber > plan.partCount)) throw invalidMultipartPart();

      await touchPendingAsset(transaction, asset.id);

      return Promise.all(body.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await storage.presignUploadPart({
          key: asset.upload_object_key,
          uploadId: asset.multipart_upload_id!,
          partNumber,
          expiresInSeconds: config.uploadUrlExpirySeconds
        })
      })));
    });

    return reply.send(parseResponse(partsDocs.schemas.response, { parts, expiresAt }));
  });

  app.post('/agencies/:agencyId/media/uploads/:assetId/complete', guarded(completeDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const params = routeParams(completeDocs.schemas.params, request);
    const body = parseRequest(completeDocs.schemas.body, request.body);

    let copiedCanonicalKey: string | undefined;
    let result: CompletionResult;
    try {
      result = await withAuthenticatedUserTransaction(database, auth.claims, async (transaction) => {
      const asset = await lockAssetForCompletion(transaction, params.assetId, params.agencyId);
      if (asset === undefined) throw assetNotFound();
      if (asset.status !== 'pending') throw notPending();

      const isMultipart = asset.multipart_upload_id !== null;
      if (isMultipart && body.parts === undefined) {
        throw new HttpError({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'parts is required to complete a multipart upload.' });
      }
      if (!isMultipart && body.parts !== undefined) {
        throw new HttpError({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'parts must be omitted for a single-part upload.' });
      }
      if (isMultipart) {
        const plan = multipartPlan(Number(asset.declared_size_bytes), config.multipartPartBytes);
        if (body.parts!.some((part) => part.partNumber > plan.partCount)) throw invalidMultipartPart();
      }

      if (isMultipart) {
        await storage.completeMultipartUpload({ key: asset.upload_object_key, uploadId: asset.multipart_upload_id!, parts: body.parts! });
      }

      // A still-valid browser URL can mutate only staging. Copy first, then validate the immutable
      // canonical key so an overwrite between HeadObject and CopyObject cannot smuggle different
      // bytes past validation. The preliminary staging HEAD preserves the explicit missing-object
      // rejection instead of surfacing an opaque CopyObject error.
      const stagingHead = await storage.headObject({ key: asset.upload_object_key });
      if (stagingHead !== undefined) {
        await storage.copyObject({ sourceKey: asset.upload_object_key, destinationKey: asset.object_key });
        copiedCanonicalKey = asset.object_key;
      }
      // The R2/S3 protocol offers no upload-time size policy for a presigned PUT. This canonical
      // HeadObject observes exactly the object that will survive confirmation.
      const head = stagingHead === undefined ? undefined : await storage.headObject({ key: asset.object_key });
      const maxBytes = maxBytesForCategory(config, asset.category);

      let rejectionReason: string | undefined;
      if (head === undefined) {
        rejectionReason = 'object_not_found';
      } else if (head.contentType === undefined || describeMediaContentType(head.contentType)?.category !== asset.category) {
        rejectionReason = 'content_type_mismatch';
      } else if (head.sizeBytes > maxBytes) {
        rejectionReason = 'too_large';
      } else {
        await lockAgencyStorageQuota(transaction, params.agencyId);
        const quota = await readQuotaSnapshot(transaction, params.agencyId, {
          quotaBytes: config.quotaDefaultBytes,
          quotaObjectCount: config.quotaDefaultObjectCount
        }, { excludeAssetId: asset.id, pendingReservationSeconds: config.uploadUrlExpirySeconds });
        // The pre-check at creation time used the declared size; this re-check uses the real,
        // server-observed size, and only this one determines whether the object survives.
        if (quota.usedBytes + head.sizeBytes > quota.quotaBytes || quota.usedObjectCount + 1 > quota.quotaObjectCount) {
          rejectionReason = 'quota_exceeded';
        }
      }

      if (rejectionReason !== undefined) {
        // The rejection (and its audit trail) must survive as a committed fact even though the
        // request itself ends in an error response, so this returns instead of throwing: throwing
        // inside `withAuthenticatedUserTransaction` would roll back the very row update that
        // records the rejection.
        if (copiedCanonicalKey !== undefined) await storage.deleteObject({ key: copiedCanonicalKey });
        copiedCanonicalKey = undefined;
        if (stagingHead !== undefined) await storage.deleteObject({ key: asset.upload_object_key });
        await markAssetRejected(transaction, asset.id, rejectionReason);
        await auditMediaEvent(transaction, { action: 'media.upload_rejected', actorUserId: auth.userId, agencyId: params.agencyId, targetId: asset.id });
        return { ok: false as const, reason: rejectionReason };
      }

      await markAssetConfirmed(transaction, asset.id, head!.sizeBytes, head!.contentType!, asset.category);
      await auditMediaEvent(transaction, { action: 'media.upload_confirmed', actorUserId: auth.userId, agencyId: params.agencyId, targetId: asset.id });
      if (asset.category === 'video') {
        if (dependencies.jobs === undefined) throw new Error('Video processing queue is not configured.');
        await dependencies.jobs.enqueueVideoProcessing(transaction, {
          assetId: params.assetId,
          agencyId: params.agencyId,
          actorUserId: auth.userId
        });
      }
      return {
        ok: true as const,
        sizeBytes: head!.sizeBytes,
        contentType: head!.contentType!,
        uploadObjectKey: asset.upload_object_key
      };
      });
    } catch (error) {
      // Object storage is outside PostgreSQL. If any database write, audit insert, queue insert, or
      // commit fails after CopyObject, remove the unreferenced canonical object before retrying.
      if (copiedCanonicalKey !== undefined) {
        try {
          await storage.deleteObject({ key: copiedCanonicalKey });
        } catch (cleanupError) {
          request.log.error({ error: { name: cleanupError instanceof Error ? cleanupError.name : 'UnknownError', code: 'MEDIA_CANONICAL_CLEANUP_FAILED' } }, 'Failed to remove canonical object after confirmation rollback');
        }
      }
      throw error;
    }
    copiedCanonicalKey = undefined;

    if (!result.ok) throw uploadRejected(result.reason);

    // Best-effort staging cleanup happens only after both the confirmed row and durable job have
    // committed. A failure is harmless: the browser can mutate only the staging key, and bucket
    // lifecycle removes it later; the canonical object is already immutable to that URL.
    try {
      await storage.deleteObject({ key: result.uploadObjectKey });
    } catch (error) {
      request.log.warn({ error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'MEDIA_STAGING_CLEANUP_FAILED' } }, 'Failed to remove validated upload staging object');
    }

    return reply.send(parseResponse(completeDocs.schemas.response, {
      assetId: params.assetId,
      status: 'confirmed',
      sizeBytes: result.sizeBytes,
      contentType: result.contentType
    }));
  });

  app.get('/agencies/:agencyId/media/:assetId/download-url', guarded(downloadDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const params = routeParams(downloadDocs.schemas.params, request);
    const query = parseRequest(downloadDocs.schemas.query, request.query);

    const objectKey = await withAuthenticatedUserTransaction(database, auth.claims, async (transaction) => {
      const asset = await findConfirmedAssetWithVariants(transaction, params.assetId, params.agencyId);
      if (asset === undefined) throw assetNotFound();
      // The thumbnail/preview variants exist only for a video whose worker job has finished
      // (issue #24); until then this is a 409, not a 404, since the asset itself is real.
      const key = query.variant === 'original' ? asset.objectKey
        : query.variant === 'thumbnail' ? asset.thumbnailObjectKey
        : asset.previewObjectKey;
      if (key === null) {
        if (asset.videoProcessingStatus === 'failed') throw variantProcessingFailed(asset.videoProcessingError);
        throw variantNotReady();
      }
      await auditMediaEvent(transaction, { action: 'media.download_url_issued', actorUserId: auth.userId, agencyId: params.agencyId, targetId: params.assetId });
      return key;
    });

    const url = await storage.presignGetObject({ key: objectKey, expiresInSeconds: config.downloadUrlExpirySeconds });
    const expiresAt = new Date(Date.now() + config.downloadUrlExpirySeconds * 1_000).toISOString();
    return reply.send(parseResponse(downloadDocs.schemas.response, { url, expiresAt }));
  });
};
