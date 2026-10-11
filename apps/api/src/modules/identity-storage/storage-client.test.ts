import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { IdentityStorageConfig } from '@ageniza/config/server';

import { createIdentityStorageClient } from './storage-client.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingHttpHeaders;
}

/** An S3 that answers a PutObject the way S3 does (200 and an ETag) and records every request it sees. */
const startFakeS3 = async (): Promise<{ readonly server: Server; readonly endpoint: string; readonly requests: RecordedRequest[] }> => {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers });
      response.writeHead(200, { etag: '"d41d8cd98f00b204e9800998ecf8427e"' });
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
};

const configFor = (endpoint: string): IdentityStorageConfig => ({
  endpoint,
  publicEndpoint: endpoint,
  region: 'auto',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  bucket: 'ageniza-identity-test',
  forcePathStyle: true,
  downloadUrlExpirySeconds: 300,
  maxImageBytes: 5 * 1024 * 1024
});

const checksumHeaders = (headers: IncomingHttpHeaders): string[] =>
  Object.keys(headers).filter((name) => /checksum|trailer/i.test(name));

describe('identity storage client and the SDK checksum defaults (#292, #306)', () => {
  let running: Server | undefined;
  afterEach(async () => {
    const server = running;
    running = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // S3-compatible stores that predate the SDK's default CRC32 (and R2 in the past) refuse or mishandle it;
  // the API was written and reviewed without it, and the bump to a newer SDK must not add it silently.
  it('uploads with no checksum or trailer header, and still sends the body and the content type', async () => {
    const fake = await startFakeS3();
    running = fake.server;
    const client = createIdentityStorageClient(configFor(fake.endpoint));

    const uploaded = await client.uploadIdentityImage({ keyPrefix: 'users/u/avatar/v', body: PNG });

    expect(uploaded.key).toBe('users/u/avatar/v.png');
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(request?.method).toBe('PUT');
    expect(request?.url?.split('?')[0]).toBe('/ageniza-identity-test/users/u/avatar/v.png');
    expect(request?.headers['content-type']).toBe('image/png');
    expect(request?.headers['content-length']).toBe(String(PNG.length));
    expect(checksumHeaders(request?.headers ?? {})).toEqual([]);
  });

  it('presigns a GET with no checksum mode parameter, keeping the forced content type', async () => {
    const client = createIdentityStorageClient(configFor('http://127.0.0.1:9'));

    const url = await client.presignGetObject({ key: 'users/u/avatar/v.png', expiresInSeconds: 60 });

    const parameters = new URL(url).searchParams;
    expect([...parameters.keys()].filter((name) => /checksum/i.test(name))).toEqual([]);
    expect(parameters.get('response-content-type')).toBe('image/png');
    expect(parameters.get('response-content-disposition')).toBe('inline');
  });
});
