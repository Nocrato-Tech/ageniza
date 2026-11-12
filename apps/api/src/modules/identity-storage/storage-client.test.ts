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

  // The SDK's default CRC32 on PutObject was not part of what this API was written and reviewed with, and a
  // store that validates a checksum it did not expect could reject the upload; a newer SDK must not add it silently.
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

/** An S3 that answers every GET with the status, the headers and the body given, as a bucket would for an object it holds or does not. */
const startFakeGet = async (answer: { readonly status: number; readonly headers?: Record<string, string>; readonly body?: Uint8Array | string }): Promise<Server> => {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(answer.status, answer.headers ?? {});
      response.end(answer.body === undefined ? undefined : Buffer.from(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
};

const endpointOf = (server: Server): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

describe('reading an identity image through the API (security review of the A2, round 1)', () => {
  let running: Server | undefined;
  afterEach(async () => {
    const server = running;
    running = undefined;
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns the bytes with the content type the bytes say, not the one stored on the object', async () => {
    running = await startFakeGet({ status: 200, headers: { 'content-type': 'text/html' }, body: PNG });
    const client = createIdentityStorageClient(configFor(endpointOf(running)));

    const image = await client.readImage({ key: 'users/u/avatar/v.png' });

    expect(image?.contentType).toBe('image/png');
    expect([...(image?.body ?? [])]).toEqual([...PNG]);
  });

  it('answers nothing for bytes that are no image this deployment accepts, whatever the object says it is', async () => {
    running = await startFakeGet({ status: 200, headers: { 'content-type': 'image/png' }, body: '<html><script>alert(1)</script></html>' });
    const client = createIdentityStorageClient(configFor(endpointOf(running)));

    expect(await client.readImage({ key: 'users/u/avatar/v.png' })).toBeUndefined();
  });

  it('answers nothing for an object that is not there', async () => {
    running = await startFakeGet({
      status: 404,
      headers: { 'content-type': 'application/xml' },
      body: '<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>'
    });
    const client = createIdentityStorageClient(configFor(endpointOf(running)));

    expect(await client.readImage({ key: 'users/u/avatar/gone.png' })).toBeUndefined();
  });

  it('refuses an object over the size limit instead of reading it', async () => {
    running = await startFakeGet({ status: 200, body: new Uint8Array(1024) });
    const small = { ...configFor(endpointOf(running)), maxImageBytes: 512 };

    await expect(createIdentityStorageClient(small).readImage({ key: 'users/u/avatar/v.png' })).rejects.toMatchObject({ name: 'IdentityImageTooLargeError' });
  });

  it('lets a failure of the bucket through, as a failure and not as "no photo"', async () => {
    running = await startFakeGet({ status: 500, headers: { 'content-type': 'application/xml' }, body: '<Error><Code>InternalError</Code></Error>' });

    await expect(createIdentityStorageClient(configFor(endpointOf(running))).readImage({ key: 'users/u/avatar/v.png' })).rejects.toBeDefined();
  });
});
