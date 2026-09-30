import { randomUUID } from 'node:crypto';

import {
  UpdateMyProfileRequestSchema,
  UpdateMyProfileResponseSchema,
  UploadMyPhotoRequestSchema,
  UploadMyPhotoResponseSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import { buildUserAvatarKeyPrefix } from '../identity-storage/policy.js';
import {
  IdentityImageTooLargeError,
  IdentityImageTypeRejectedError,
  type IdentityStorageClient,
  type UploadedIdentityImage
} from '../identity-storage/storage-client.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';
import { profilePhotoBodyLimitBytes } from './policy.js';
import { loadOwnProfile, updateOwnImage, updateOwnName } from './service.js';

export interface ProfileModuleConfig {
  readonly maxImageBytes: number;
  readonly downloadUrlExpirySeconds: number;
}

export interface ProfileModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** The identity bucket client from issue #100; the photo never touches the media bucket. */
  readonly identityStorage: IdentityStorageClient;
  readonly config: ProfileModuleConfig;
}

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
const imageTooLarge = (): HttpError => new HttpError({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The image exceeds the size limit.' });
const imageTypeRejected = (): HttpError => new HttpError({ statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'This image type is not accepted.' });

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

/**
 * Registers the self-service profile routes (issue #101): `PATCH /me/profile` (name) and
 * `POST /me/photo` (photo). Both are deliberately unscoped by agency and require no module
 * permission: name, e-mail and photo belong to the global `auth."user"`, and editing your own
 * profile is about yourself, resolved by identity.
 *
 * The route shape enforces the invariant the whole task turns on. `auth."user"` has no RLS, so the
 * target is always the verified session user (`request.auth.userId`) and never a value from the
 * body, the query or the path. The body schema is `.strict()`, so an extra `userId` field is a 400
 * rather than a silently ignored key; the query is never read; and no `/:userId` segment exists.
 */
export const registerProfileModule = (app: FastifyInstance, dependencies: ProfileModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  // Declared once per route: the same object is the documentation metadata and the source of the
  // schemas the handler validates with.
  const profileDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { body: UpdateMyProfileRequestSchema, response: UpdateMyProfileResponseSchema }
  } satisfies DocumentedRouteConfig;
  const photoDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { body: UploadMyPhotoRequestSchema, response: UploadMyPhotoResponseSchema }
  } satisfies DocumentedRouteConfig;

  app.patch('/me/profile', { preHandler: requireSession, config: profileDocs }, async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseRequest(profileDocs.schemas.body, request.body);

    const updated = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      updateOwnName(transaction, auth.userId, body.name)
    );
    if (updated === undefined) throw new Error('The authenticated user no longer exists.');

    return reply.send(parseResponse(profileDocs.schemas.response, updated));
  });

  app.post('/me/photo', {
    preHandler: requireSession,
    // Own limit, at least the configured image size plus base64/JSON overhead; the global body
    // limit is not raised for this route (issue #100's README).
    bodyLimit: profilePhotoBodyLimitBytes(dependencies.config.maxImageBytes),
    config: photoDocs
  }, async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseRequest(photoDocs.schemas.body, request.body);
    const bytes = Buffer.from(body.imageBase64, 'base64');

    let uploaded: UploadedIdentityImage;
    try {
      uploaded = await dependencies.identityStorage.uploadIdentityImage({
        keyPrefix: buildUserAvatarKeyPrefix(auth.userId, randomUUID()),
        body: bytes
      });
    } catch (error) {
      if (error instanceof IdentityImageTooLargeError) throw imageTooLarge();
      if (error instanceof IdentityImageTypeRejectedError) throw imageTypeRejected();
      throw error;
    }

    // Commit the new key first, reading the previous one in the same transaction. Only after this
    // commits does anything treat the new object as current (issue #100's protocol).
    let previousKey: string | null;
    try {
      previousKey = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
        const current = await loadOwnProfile(transaction, auth.userId);
        if (current === undefined) throw new Error('The authenticated user no longer exists.');
        await updateOwnImage(transaction, auth.userId, uploaded.key);
        return current.image;
      });
    } catch (error) {
      // The object is written but no committed reference points at it; remove it so a failed write
      // cannot leave a live, unreferenced avatar behind.
      await dependencies.identityStorage.deleteObject({ key: uploaded.key }).catch((cleanupError) => {
        request.log.error({
          error: { name: cleanupError instanceof Error ? cleanupError.name : 'UnknownError', code: 'PROFILE_PHOTO_CLEANUP_FAILED' }
        }, 'Failed to remove the uncommitted avatar object after the profile write failed');
      });
      throw error;
    }

    // The previous object is deleted only after the new reference committed. If this fails the old
    // object is merely orphaned -- never referenced and never served -- not a correctness problem.
    if (previousKey !== null) {
      await dependencies.identityStorage.deleteObject({ key: previousKey }).catch((cleanupError) => {
        request.log.warn({
          error: { name: cleanupError instanceof Error ? cleanupError.name : 'UnknownError', code: 'PROFILE_PHOTO_PREVIOUS_CLEANUP_FAILED' }
        }, 'Failed to remove the previous avatar object after the new one was committed');
      });
    }

    const imageUrl = await dependencies.identityStorage.presignGetObject({
      key: uploaded.key,
      expiresInSeconds: dependencies.config.downloadUrlExpirySeconds
    });
    return reply.send(parseResponse(photoDocs.schemas.response, { imageUrl }));
  });
};
