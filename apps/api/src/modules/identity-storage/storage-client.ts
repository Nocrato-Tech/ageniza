import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { IdentityStorageConfig } from '@ageniza/config/server';

/**
 * S3-compatible client for identity assets (issue #100): Cloudflare R2 in production, LocalStack
 * locally -- a bucket and credential pair separate from the media module's, so a user's photo
 * never depends on any one agency's lifecycle or quota (`docs/business/decisions.md`,
 * 2026-09-24). `apps/api/src/modules/media/storage-client.ts` is the sibling this mirrors.
 *
 * Unlike media, upload runs through the API itself rather than a presigned PUT: an identity image
 * is small (`IdentityStorageConfig.maxImageBytes`, 5 MiB by default), so a synchronous
 * `PutObject` lets the caller validate the real byte length and content type before writing --
 * no staging key, no confirm step, no HeadObject round trip. Reading still goes through a signed
 * URL, exactly like media: the bucket and every object in it stay private.
 */
export interface IdentityStorageClient {
  uploadObject(input: { readonly key: string; readonly contentType: string; readonly body: Uint8Array }): Promise<void>;
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
    async uploadObject({ key, contentType, body }) {
      await internalClient.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body, ContentType: contentType }));
    },

    async deleteObject({ key }) {
      await internalClient.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },

    async presignGetObject({ key, expiresInSeconds }) {
      const command = new GetObjectCommand({ Bucket: config.bucket, Key: key });
      return getSignedUrl(presignClient, command, { expiresIn: expiresInSeconds });
    }
  };
};
