import type { FastifyRequest } from 'fastify';

import type { IdentityStorageClient } from '../identity-storage/storage-client.js';

export interface PhotoUrlSignerDependencies {
  /** Absent when identity storage is not configured; then every URL is null. */
  readonly identityStorage?: IdentityStorageClient;
  readonly photoUrlExpirySeconds: number;
}

/**
 * Signs a stored identity key into a short-lived read URL, or null: no key, no storage, or a key
 * the storage refuses. A key that cannot be signed is not worth a 500 -- the page still loads, the
 * photo is null -- and the failure is logged with `code`, never the key.
 */
export const createPhotoUrlSigner = (
  dependencies: PhotoUrlSignerDependencies,
  failure: { readonly code: string; readonly message: string }
) => async (request: FastifyRequest, photoKey: string | null): Promise<string | null> => {
  if (photoKey === null || dependencies.identityStorage === undefined) return null;
  try {
    return await dependencies.identityStorage.presignGetObject({ key: photoKey, expiresInSeconds: dependencies.photoUrlExpirySeconds });
  } catch (error) {
    request.log.warn({
      error: { name: error instanceof Error ? error.name : 'UnknownError', code: failure.code }
    }, failure.message);
    return null;
  }
};
