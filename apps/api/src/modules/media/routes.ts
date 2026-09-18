import { randomUUID } from 'node:crypto';

import {
  CompleteMediaUploadRequestSchema,
  CompleteMediaUploadResponseSchema,
  CreateMediaUploadRequestSchema,
  CreateMediaUploadResponseSchema,
  MediaDownloadUrlResponseSchema,
  RequestMediaUploadPartsRequestSchema,
  RequestMediaUploadPartsResponseSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';
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
  findConfirmedAsset,
  insertPendingAsset,
  lockAssetForCompletion,
  markAssetConfirmed,
  markAssetRejected,
  readQuotaSnapshot,
  setMultipartUploadId
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
}

const agencyParamsSchema = z.object({ agencyId: z.string().uuid() }).strict();
const assetParamsSchema = z.object({ agencyId: z.string().uuid(), assetId: z.string().uuid() }).strict();

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
const uploadRejected = (reason: string): HttpError => new HttpError({ statusCode: 422, code: 'UPLOAD_REJECTED', message: `The uploaded object was rejected: ${reason}.`, details: { reason } });

const routeParams = <T>(schema: z.ZodType<T>, request: FastifyRequest): T => parseRequest(schema, request.params);

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

const objectKeyFor = (agencyId: string, assetId: string, extension: string): string => `${agencyId}/${assetId}/original.${extension}`;

/** Registers the direct-to-R2 upload routes (issue #21). Every route requires `requireAgencyAccess`
 * then `requirePermission('midia.enviar')`, so a signed URL is emitted only after tenant and
 * capability are both confirmed -- an agency never obtains a URL for another agency's object,
 * because the object key, the DB row, and RLS are all scoped to `:agencyId` end to end. */
export const registerMediaModule = (app: FastifyInstance, dependencies: MediaModuleDependencies): void => {
  const { database, storage, config } = dependencies;
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const guarded = (permission: string) => [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(permission)];
  const signedUrlRoute = {
    config: {
      rateLimit: {
        max: MEDIA_RATE_LIMITS.signedUrlIssuance.max,
        timeWindow: MEDIA_RATE_LIMITS.signedUrlIssuance.windowMs,
        addHeaders: false
      }
    }
  };

  app.post('/agencies/:agencyId/media/uploads', { preHandler: guarded('midia.enviar'), ...signedUrlRoute }, async (request, reply) => {
    const auth = requireAuth(request);
    const params = routeParams(agencyParamsSchema, request);
    const body = parseRequest(CreateMediaUploadRequestSchema, request.body);

    const descriptor = describeMediaContentType(body.contentType);
    if (descriptor === undefined) throw unsupportedType();
    if (body.declaredSizeBytes > maxBytesForCategory(config, descriptor.category)) throw payloadTooLarge();

    const assetId = randomUUID();
    const objectKey = objectKeyFor(params.agencyId, assetId, descriptor.extension);
    const expiresAt = new Date(Date.now() + config.uploadUrlExpirySeconds * 1_000).toISOString();

    const upload = await withAuthenticatedUserTransaction(database, auth.claims, async (transaction) => {
      const quota = await readQuotaSnapshot(transaction, params.agencyId, {
        quotaBytes: config.quotaDefaultBytes,
        quotaObjectCount: config.quotaDefaultObjectCount
      });
      if (quota.usedBytes + body.declaredSizeBytes > quota.quotaBytes) throw quotaExceeded();
      if (quota.usedObjectCount + 1 > quota.quotaObjectCount) throw quotaExceeded();

      await insertPendingAsset(transaction, {
        id: assetId,
        agencyId: params.agencyId,
        category: descriptor.category,
        declaredContentType: body.contentType,
        extension: descriptor.extension,
        objectKey,
        declaredSizeBytes: body.declaredSizeBytes,
        createdByUserId: auth.userId
      });

      if (usesMultipartUpload(config, body.declaredSizeBytes)) {
        const { uploadId } = await storage.createMultipartUpload({ key: objectKey, contentType: body.contentType });
        await setMultipartUploadId(transaction, assetId, uploadId);
        const plan = multipartPlan(body.declaredSizeBytes, config.multipartPartBytes);
        await auditMediaEvent(transaction, { action: 'media.upload_initiated', actorUserId: auth.userId, agencyId: params.agencyId, targetId: assetId });
        return { type: 'multipart' as const, uploadId, partSizeBytes: plan.partSizeBytes, partCount: plan.partCount };
      }

      const url = await storage.presignPutObject({ key: objectKey, contentType: body.contentType, expiresInSeconds: config.uploadUrlExpirySeconds });
      await auditMediaEvent(transaction, { action: 'media.upload_initiated', actorUserId: auth.userId, agencyId: params.agencyId, targetId: assetId });
      return { type: 'single' as const, url };
    });

    return reply.status(201).send(parseResponse(CreateMediaUploadResponseSchema, {
      assetId,
      objectKey,
      category: descriptor.category,
      upload: upload.type === 'single'
        ? { type: 'single', url: upload.url, expiresAt }
        : { type: 'multipart', uploadId: upload.uploadId, partSizeBytes: upload.partSizeBytes, partCount: upload.partCount }
    }));
  });

  app.post('/agencies/:agencyId/media/uploads/:assetId/parts', { preHandler: guarded('midia.enviar'), ...signedUrlRoute }, async (request, reply) => {
    const auth = requireAuth(request);
    const params = routeParams(assetParamsSchema, request);
    const body = parseRequest(RequestMediaUploadPartsRequestSchema, request.body);
    const expiresAt = new Date(Date.now() + config.uploadUrlExpirySeconds * 1_000).toISOString();

    const parts = await withAuthenticatedUserTransaction(database, auth.claims, async (transaction) => {
      const asset = await lockAssetForCompletion(transaction, params.assetId, params.agencyId);
      if (asset === undefined) throw assetNotFound();
      if (asset.status !== 'pending' || asset.multipart_upload_id === null) throw notPending();

      return Promise.all(body.partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await storage.presignUploadPart({
          key: asset.object_key,
          uploadId: asset.multipart_upload_id!,
          partNumber,
          expiresInSeconds: config.uploadUrlExpirySeconds
        })
      })));
    });

    return reply.send(parseResponse(RequestMediaUploadPartsResponseSchema, { parts, expiresAt }));
  });

  app.post('/agencies/:agencyId/media/uploads/:assetId/complete', { preHandler: guarded('midia.enviar') }, async (request, reply) => {
    const auth = requireAuth(request);
    const params = routeParams(assetParamsSchema, request);
    const body = parseRequest(CompleteMediaUploadRequestSchema, request.body);

    const result = await withAuthenticatedUserTransaction(database, auth.claims, async (transaction) => {
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
        await storage.completeMultipartUpload({ key: asset.object_key, uploadId: asset.multipart_upload_id!, parts: body.parts! });
      }

      // The R2/S3 protocol offers no upload-time size policy for a presigned POST/PUT, so this
      // HeadObject is the only point where the real, server-observed size and content type exist
      // (issue #21). Everything declared before this point was untrusted client input.
      const head = await storage.headObject({ key: asset.object_key });
      const maxBytes = maxBytesForCategory(config, asset.category);

      let rejectionReason: string | undefined;
      if (head === undefined) {
        rejectionReason = 'object_not_found';
      } else if (head.contentType === undefined || describeMediaContentType(head.contentType)?.category !== asset.category) {
        rejectionReason = 'content_type_mismatch';
      } else if (head.sizeBytes > maxBytes) {
        rejectionReason = 'too_large';
      } else {
        const quota = await readQuotaSnapshot(transaction, params.agencyId, {
          quotaBytes: config.quotaDefaultBytes,
          quotaObjectCount: config.quotaDefaultObjectCount
        });
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
        if (head !== undefined) await storage.deleteObject({ key: asset.object_key });
        await markAssetRejected(transaction, asset.id, rejectionReason);
        await auditMediaEvent(transaction, { action: 'media.upload_rejected', actorUserId: auth.userId, agencyId: params.agencyId, targetId: asset.id });
        return { ok: false as const, reason: rejectionReason };
      }

      await markAssetConfirmed(transaction, asset.id, head!.sizeBytes, head!.contentType!);
      await auditMediaEvent(transaction, { action: 'media.upload_confirmed', actorUserId: auth.userId, agencyId: params.agencyId, targetId: asset.id });
      return { ok: true as const, sizeBytes: head!.sizeBytes, contentType: head!.contentType! };
    });

    if (!result.ok) throw uploadRejected(result.reason);

    return reply.send(parseResponse(CompleteMediaUploadResponseSchema, {
      assetId: params.assetId,
      status: 'confirmed',
      sizeBytes: result.sizeBytes,
      contentType: result.contentType
    }));
  });

  app.get('/agencies/:agencyId/media/:assetId/download-url', { preHandler: guarded('midia.enviar'), ...signedUrlRoute }, async (request, reply) => {
    const auth = requireAuth(request);
    const params = routeParams(assetParamsSchema, request);

    const objectKey = await withAuthenticatedUserTransaction(database, auth.claims, async (transaction) => {
      const asset = await findConfirmedAsset(transaction, params.assetId, params.agencyId);
      if (asset === undefined) throw assetNotFound();
      await auditMediaEvent(transaction, { action: 'media.download_url_issued', actorUserId: auth.userId, agencyId: params.agencyId, targetId: params.assetId });
      return asset.objectKey;
    });

    const url = await storage.presignGetObject({ key: objectKey, expiresInSeconds: config.downloadUrlExpirySeconds });
    const expiresAt = new Date(Date.now() + config.downloadUrlExpirySeconds * 1_000).toISOString();
    return reply.send(parseResponse(MediaDownloadUrlResponseSchema, { url, expiresAt }));
  });
};
