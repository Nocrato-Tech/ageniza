import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { StorageConfig } from '@ageniza/config/server';

export interface HeadObjectResult {
  readonly sizeBytes: number;
  readonly contentType: string | undefined;
}

export interface CompletedPart {
  readonly partNumber: number;
  readonly eTag: string;
}

/**
 * S3-compatible client for the media module (issue #21): Cloudflare R2 in production, MinIO
 * locally. Every mutating/inspecting call (multipart control, HeadObject, delete) runs against
 * `endpoint`, which only the API itself needs to reach. Presigned URLs are always built against
 * `publicEndpoint`, because the *browser* is the one following them -- see `StorageConfig` for why
 * the two can differ locally.
 */
export interface MediaStorageClient {
  createMultipartUpload(input: { readonly key: string; readonly contentType: string }): Promise<{ readonly uploadId: string }>;
  presignPutObject(input: { readonly key: string; readonly contentType: string; readonly expiresInSeconds: number }): Promise<string>;
  presignUploadPart(input: { readonly key: string; readonly uploadId: string; readonly partNumber: number; readonly expiresInSeconds: number }): Promise<string>;
  completeMultipartUpload(input: { readonly key: string; readonly uploadId: string; readonly parts: readonly CompletedPart[] }): Promise<void>;
  abortMultipartUpload(input: { readonly key: string; readonly uploadId: string }): Promise<void>;
  /** Returns `undefined` when the object does not exist, instead of throwing. */
  headObject(input: { readonly key: string }): Promise<HeadObjectResult | undefined>;
  deleteObject(input: { readonly key: string }): Promise<void>;
  presignGetObject(input: { readonly key: string; readonly expiresInSeconds: number }): Promise<string>;
}

export const createMediaStorageClient = (config: StorageConfig): MediaStorageClient => {
  const clientOptions = {
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
  };
  const internalClient = new S3Client({ ...clientOptions, endpoint: config.endpoint });
  // A distinct client whose only purpose is to build browser-facing presigned URLs; it never
  // opens a connection of its own (`getSignedUrl` only signs, it does not call the network).
  const presignClient = new S3Client({ ...clientOptions, endpoint: config.publicEndpoint });

  return {
    async createMultipartUpload({ key, contentType }) {
      const result = await internalClient.send(new CreateMultipartUploadCommand({
        Bucket: config.bucket,
        Key: key,
        ContentType: contentType
      }));
      if (result.UploadId === undefined) throw new Error('CreateMultipartUpload did not return an upload id.');
      return { uploadId: result.UploadId };
    },

    async presignPutObject({ key, contentType, expiresInSeconds }) {
      const command = new PutObjectCommand({ Bucket: config.bucket, Key: key, ContentType: contentType });
      return getSignedUrl(presignClient, command, { expiresIn: expiresInSeconds });
    },

    async presignUploadPart({ key, uploadId, partNumber, expiresInSeconds }) {
      const command = new UploadPartCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber });
      return getSignedUrl(presignClient, command, { expiresIn: expiresInSeconds });
    },

    async completeMultipartUpload({ key, uploadId, parts }) {
      await internalClient.send(new CompleteMultipartUploadCommand({
        Bucket: config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.eTag }))
        }
      }));
    },

    async abortMultipartUpload({ key, uploadId }) {
      await internalClient.send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId }));
    },

    async headObject({ key }) {
      try {
        const result = await internalClient.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
        if (result.ContentLength === undefined) throw new Error('HeadObject did not return a content length.');
        return { sizeBytes: result.ContentLength, contentType: result.ContentType };
      } catch (error) {
        if (error instanceof NotFound) return undefined;
        // MinIO answers a missing key with a plain 404 that the SDK does not always model as
        // `NotFound`; treat any "Not Found"-shaped error the same way instead of masking real faults.
        if (typeof error === 'object' && error !== null && 'name' in error && (error as { name?: unknown }).name === 'NotFound') return undefined;
        throw error;
      }
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
