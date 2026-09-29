import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { IdentityStorageConfig } from '@ageniza/config/server';

import { contentTypeForExtension, detectIdentityImageType } from './policy.js';

/** Thrown by `uploadIdentityImage` when the body exceeds `IdentityStorageConfig.maxImageBytes`. */
export class IdentityImageTooLargeError extends Error {
  constructor(sizeBytes: number, maxImageBytes: number) {
    super(`identity image is ${sizeBytes} bytes; the limit is ${maxImageBytes} bytes`);
    this.name = 'IdentityImageTooLargeError';
  }
}

/** Thrown by `uploadIdentityImage` when the bytes do not open with a signature this deployment
 * accepts (see `policy.ts`'s `detectIdentityImageType`) -- regardless of any declared header. */
export class IdentityImageTypeRejectedError extends Error {
  constructor() {
    super('identity image content was not recognized as png, jpeg, webp, or gif');
    this.name = 'IdentityImageTypeRejectedError';
  }
}

export interface UploadedIdentityImage {
  /** The final object key, `keyPrefix` plus the extension detected from the actual bytes. */
  readonly key: string;
  readonly contentType: string;
  readonly extension: string;
}

/**
 * S3-compatible client for identity assets (issue #100): Cloudflare R2 in production, LocalStack
 * locally -- a bucket and credential pair separate from the media module's, so a user's photo
 * never depends on any one agency's lifecycle or quota (`docs/business/decisions.md`,
 * 2026-09-24). `apps/api/src/modules/media/storage-client.ts` is the sibling this mirrors.
 *
 * Unlike media, upload runs through the API itself rather than a presigned PUT: an identity image
 * is small (`IdentityStorageConfig.maxImageBytes`, capped at 10 MiB, default 5 MiB), so a
 * synchronous `PutObject` can validate the real bytes before writing -- no staging key, no
 * confirm step, no HeadObject round trip. `uploadIdentityImage` is the only way this client
 * writes an object, and it is the single point that enforces the size limit and detects the real
 * image type from content (never a caller-declared header or file extension) -- see `policy.ts`.
 * Reading still goes through a signed URL, exactly like media: the bucket and every object in it
 * stay private, and the signed URL forces a safe `Content-Type`/`Content-Disposition` regardless
 * of what is stored on the object, so nothing served through it is ever `text/html`.
 */
export interface IdentityStorageClient {
  /** Validates size and content, then uploads. Throws `IdentityImageTooLargeError` or
   * `IdentityImageTypeRejectedError` instead of writing anything on a rejected image. */
  uploadIdentityImage(input: { readonly keyPrefix: string; readonly body: Uint8Array }): Promise<UploadedIdentityImage>;
  deleteObject(input: { readonly key: string }): Promise<void>;
  presignGetObject(input: { readonly key: string; readonly expiresInSeconds: number }): Promise<string>;
}

export const createIdentityStorageClient = (config: IdentityStorageConfig): IdentityStorageClient => {
  const clientOptions = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
  };
  const internalClient = new S3Client({ ...clientOptions, endpoint: config.endpoint });
  // Distinct client whose only purpose is to build browser-facing presigned URLs; see
  // `StorageConfig.publicEndpoint` (media) for why this can differ from `endpoint` locally.
  const presignClient = new S3Client({ ...clientOptions, endpoint: config.publicEndpoint });

  return {
    async uploadIdentityImage({ keyPrefix, body }) {
      if (body.length > config.maxImageBytes) throw new IdentityImageTooLargeError(body.length, config.maxImageBytes);
      const detected = detectIdentityImageType(body);
      if (detected === undefined) throw new IdentityImageTypeRejectedError();
      const key = `${keyPrefix}.${detected.extension}`;
      await internalClient.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: detected.contentType }));
      return { key, contentType: detected.contentType, extension: detected.extension };
    },

    async deleteObject({ key }) {
      await internalClient.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },

    async presignGetObject({ key, expiresInSeconds }) {
      const extension = key.slice(key.lastIndexOf('.') + 1);
      const contentType = contentTypeForExtension(extension);
      if (contentType === undefined) throw new Error(`presignGetObject refuses a key with no known image extension: "${key}"`);
      // Forced regardless of what is stored on the object: the response the browser receives can
      // never be text/html or any other active content type, even if the stored metadata were
      // ever wrong.
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: 'inline'
      });
      return getSignedUrl(presignClient, command, { expiresIn: expiresInSeconds });
    }
  };
};
