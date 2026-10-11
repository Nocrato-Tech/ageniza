import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkerStorageConfig } from '@ageniza/config/server';

import { createMediaProcessingStorageClient } from './media-storage.js';

interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
}

/** An S3 that answers a PutObject with 200 and an ETag and a GetObject with the object bytes, recording every request. */
const startFakeS3 = async (): Promise<{ readonly server: Server; readonly endpoint: string; readonly requests: RecordedRequest[] }> => {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers });
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '5', etag: '"abc"' });
        response.end('hello');
        return;
      }
      response.writeHead(200, { etag: '"abc"' });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
};

const configFor = (endpoint: string): WorkerStorageConfig => ({
  endpoint,
  region: 'auto',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'ageniza-media-test',
  forcePathStyle: true
});

const checksumHeaders = (headers: IncomingHttpHeaders): string[] =>
  Object.keys(headers).filter((name) => /checksum|trailer/i.test(name));

describe('worker media storage client and the SDK checksum defaults (#292, #306)', () => {
  let running: Server | undefined;
  let workdir: string | undefined;
  afterEach(async () => {
    const server = running;
    running = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (workdir !== undefined) rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
  });

  // The SDK's default since 3.729 sends a streamed PutObject as `aws-chunked` with a CRC32 trailer; that is the
  // shape S3-compatible stores handle worst, and the worker streams every thumbnail and preview it uploads.
  it('streams an upload as a plain PUT with its length, with no checksum, trailer or aws-chunked encoding', async () => {
    const fake = await startFakeS3();
    running = fake.server;
    workdir = mkdtempSync(join(tmpdir(), 'ageniza-worker-storage-'));
    const source = join(workdir, 'thumbnail.jpg');
    writeFileSync(source, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    const client = createMediaProcessingStorageClient(configFor(fake.endpoint));

    await client.uploadFile({ key: 'agencies/a/thumb.jpg', sourcePath: source, contentType: 'image/jpeg', signal: new AbortController().signal });

    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.method).toBe('PUT');
    expect(request?.url?.split('?')[0]).toBe('/ageniza-media-test/agencies/a/thumb.jpg');
    expect(request?.headers['content-length']).toBe('7');
    expect(request?.headers['content-encoding']).toBeUndefined();
    expect(checksumHeaders(request?.headers ?? {})).toEqual([]);
  });

  it('downloads without asking the store to compute a checksum', async () => {
    const fake = await startFakeS3();
    running = fake.server;
    workdir = mkdtempSync(join(tmpdir(), 'ageniza-worker-storage-'));
    const destination = join(workdir, 'original.mp4');
    const client = createMediaProcessingStorageClient(configFor(fake.endpoint));

    await client.downloadToFile({ key: 'agencies/a/original.mp4', destinationPath: destination, signal: new AbortController().signal });

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.method).toBe('GET');
    expect(checksumHeaders(fake.requests[0]?.headers ?? {})).toEqual([]);
  });
});
