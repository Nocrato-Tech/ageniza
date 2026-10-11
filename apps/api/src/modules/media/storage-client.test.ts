import { describe, expect, it } from 'vitest';

import type { StorageConfig } from '@ageniza/config/server';

import { createMediaStorageClient } from './storage-client.js';

// Nothing here opens a connection: presigning only signs. The endpoint is a port nobody listens on.
const config: StorageConfig = {
  endpoint: 'http://127.0.0.1:9',
  publicEndpoint: 'http://127.0.0.1:9',
  region: 'auto',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'ageniza-media-test',
  forcePathStyle: true,
  uploadUrlExpirySeconds: 900,
  downloadUrlExpirySeconds: 300,
  multipartThresholdBytes: 8 * 1024 * 1024,
  multipartPartBytes: 8 * 1024 * 1024,
  maxImageBytes: 25 * 1024 * 1024,
  maxVideoBytes: 5 * 1024 * 1024 * 1024,
  quotaDefaultBytes: 10 * 1024 * 1024 * 1024,
  quotaDefaultObjectCount: 2_000
};

const checksumParameters = (url: string): string[] =>
  [...new URL(url).searchParams.keys()].filter((name) => /checksum/i.test(name));

describe('media storage client presigned URLs (#292, #306)', () => {
  // The browser follows these URLs. The SDK's default since 3.729 bakes `x-amz-checksum-crc32` into a presigned
  // PUT, and the browser's bytes can never match a checksum computed before it has them: every upload would fail.
  it('presigns a PUT with no checksum parameter, but still signed and expiring', async () => {
    const client = createMediaStorageClient(config);

    const url = await client.presignPutObject({ key: 'agencies/a/media/original', contentType: 'video/mp4', expiresInSeconds: 900 });

    expect(checksumParameters(url)).toEqual([]);
    const parameters = new URL(url).searchParams;
    expect(parameters.get('X-Amz-Expires')).toBe('900');
    expect(parameters.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('presigns an upload part with no checksum parameter', async () => {
    const client = createMediaStorageClient(config);

    const url = await client.presignUploadPart({ key: 'agencies/a/media/original', uploadId: 'upload-1', partNumber: 3, expiresInSeconds: 900 });

    expect(checksumParameters(url)).toEqual([]);
    const parameters = new URL(url).searchParams;
    expect(parameters.get('partNumber')).toBe('3');
    expect(parameters.get('uploadId')).toBe('upload-1');
  });

  it('presigns a GET with no checksum mode parameter', async () => {
    const client = createMediaStorageClient(config);

    const url = await client.presignGetObject({ key: 'agencies/a/media/original', expiresInSeconds: 300 });

    expect(checksumParameters(url)).toEqual([]);
    expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe('300');
  });
});
