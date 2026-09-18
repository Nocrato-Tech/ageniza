import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import type { WorkerStorageConfig } from '@ageniza/config/server';

/**
 * S3-compatible client the worker uses directly (issue #24): Cloudflare R2 in production, MinIO
 * locally -- the same bucket the API's media module writes originals to (issue #21). Unlike the
 * API's client, this one never presigns a browser-facing URL: every call runs against
 * `config.endpoint`, which only the worker itself needs to reach.
 */
export interface MediaProcessingStorageClient {
  /** Streams the object at `key` to `destinationPath`, overwriting it. */
  downloadToFile(input: { readonly key: string; readonly destinationPath: string }): Promise<void>;
  /** Uploads the local file at `sourcePath` to `key`. `sizeBytes` must match the file's actual size. */
  uploadFile(input: { readonly key: string; readonly sourcePath: string; readonly contentType: string }): Promise<void>;
}

export const createMediaProcessingStorageClient = (config: WorkerStorageConfig): MediaProcessingStorageClient => {
  const client = new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }
  });

  return {
    async downloadToFile({ key, destinationPath }) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      const body = result.Body;
      if (body === undefined) throw new Error('GetObject did not return a body.');
      // The SDK's Node runtime always resolves Body to a Readable; the union also covers browser
      // stream types that this server-only client never sees.
      await pipeline(body as NodeJS.ReadableStream, createWriteStream(destinationPath));
    },

    async uploadFile({ key, sourcePath, contentType }) {
      const contentLength = statSync(sourcePath).size;
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: createReadStream(sourcePath),
        ContentType: contentType,
        ContentLength: contentLength
      }));
    }
  };
};
