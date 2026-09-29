import { randomUUID } from 'node:crypto';

import { HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { TEST_IDENTITY_STORAGE_CONFIG, TEST_STORAGE_CONFIG } from '../auth/test-support/harness.js';
import { buildClientAvatarKey, buildClientAvatarKeyPrefix, buildUserAvatarKey, buildUserAvatarKeyPrefix, detectIdentityImageType } from './policy.js';
import { createIdentityStorageClient, IdentityImageTooLargeError, IdentityImageTypeRejectedError } from './storage-client.js';

// Issue #100 acceptance tests. Runs against the real local LocalStack started by
// `pnpm storage:start` -- see apps/api/src/modules/identity-storage/README.md.
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const HTML_DISGUISED_AS_IMAGE = new TextEncoder().encode('<script>alert(1)</script>');
const SVG_BODY = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

describe('identity storage client (issue #100)', () => {
  it('uploads through the server (validating size and content by magic bytes), reads back only via a signed URL forcing a safe content type, and deletes on removal', async () => {
    const client = createIdentityStorageClient(TEST_IDENTITY_STORAGE_CONFIG);
    const keyPrefix = buildUserAvatarKeyPrefix(randomUUID(), randomUUID());

    const uploaded = await client.uploadIdentityImage({ keyPrefix, body: PNG_SIGNATURE });
    expect(uploaded).toEqual({ key: `${keyPrefix}.png`, contentType: 'image/png', extension: 'png' });

    const signedUrl = await client.presignGetObject({ key: uploaded.key, expiresInSeconds: 60 });
    const response = await fetch(signedUrl);
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe('inline');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_SIGNATURE);

    // Bucket/object privacy itself (rejecting an anonymous, unsigned request) is not exercised
    // here: LocalStack does not enforce access control the way R2 does, the same gap the media
    // module documents for credential rejection -- see this module's README's "could not be
    // verified locally" section.

    await client.deleteObject({ key: uploaded.key });
    const afterDelete = await fetch(signedUrl);
    expect(afterDelete.ok).toBe(false);
  });

  it('rejects a body over maxImageBytes and never writes it', async () => {
    const client = createIdentityStorageClient(TEST_IDENTITY_STORAGE_CONFIG);
    const keyPrefix = buildUserAvatarKeyPrefix(randomUUID(), randomUUID());
    const oversized = new Uint8Array(TEST_IDENTITY_STORAGE_CONFIG.maxImageBytes + 1);
    oversized.set(PNG_SIGNATURE);

    await expect(client.uploadIdentityImage({ keyPrefix, body: oversized })).rejects.toBeInstanceOf(IdentityImageTooLargeError);

    const rawClient = new S3Client({
      region: TEST_IDENTITY_STORAGE_CONFIG.region,
      forcePathStyle: TEST_IDENTITY_STORAGE_CONFIG.forcePathStyle,
      endpoint: TEST_IDENTITY_STORAGE_CONFIG.endpoint,
      credentials: { accessKeyId: TEST_IDENTITY_STORAGE_CONFIG.accessKeyId, secretAccessKey: TEST_IDENTITY_STORAGE_CONFIG.secretAccessKey }
    });
    await expect(rawClient.send(new HeadObjectCommand({ Bucket: TEST_IDENTITY_STORAGE_CONFIG.bucket, Key: `${keyPrefix}.png` }))).rejects.toBeInstanceOf(NotFound);
  });

  it('rejects HTML and SVG disguised as an image, by content rather than by declared type or extension', async () => {
    const client = createIdentityStorageClient(TEST_IDENTITY_STORAGE_CONFIG);
    const keyPrefix = buildUserAvatarKeyPrefix(randomUUID(), randomUUID());

    await expect(client.uploadIdentityImage({ keyPrefix, body: HTML_DISGUISED_AS_IMAGE })).rejects.toBeInstanceOf(IdentityImageTypeRejectedError);
    await expect(client.uploadIdentityImage({ keyPrefix, body: SVG_BODY })).rejects.toBeInstanceOf(IdentityImageTypeRejectedError);
  });

  it('detects every allowed still-image signature and nothing else, ignoring any declared type', () => {
    expect(detectIdentityImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toEqual({ contentType: 'image/png', extension: 'png' });
    expect(detectIdentityImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ contentType: 'image/jpeg', extension: 'jpg' });
    expect(detectIdentityImageType(new TextEncoder().encode('GIF89a'))).toEqual({ contentType: 'image/gif', extension: 'gif' });
    const webp = new Uint8Array(16);
    webp.set(new TextEncoder().encode('RIFF'), 0);
    webp.set(new TextEncoder().encode('WEBP'), 8);
    expect(detectIdentityImageType(webp)).toEqual({ contentType: 'image/webp', extension: 'webp' });
    expect(detectIdentityImageType(HTML_DISGUISED_AS_IMAGE)).toBeUndefined();
    expect(detectIdentityImageType(SVG_BODY)).toBeUndefined();
    expect(detectIdentityImageType(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('never writes to the media bucket: the same key is absent there after an identity upload (critério de aceite)', async () => {
    const client = createIdentityStorageClient(TEST_IDENTITY_STORAGE_CONFIG);
    const keyPrefix = buildUserAvatarKeyPrefix(randomUUID(), randomUUID());
    const uploaded = await client.uploadIdentityImage({ keyPrefix, body: PNG_SIGNATURE });

    const mediaClient = new S3Client({
      region: TEST_STORAGE_CONFIG.region,
      forcePathStyle: TEST_STORAGE_CONFIG.forcePathStyle,
      endpoint: TEST_STORAGE_CONFIG.endpoint,
      credentials: { accessKeyId: TEST_STORAGE_CONFIG.accessKeyId, secretAccessKey: TEST_STORAGE_CONFIG.secretAccessKey }
    });
    await expect(mediaClient.send(new HeadObjectCommand({ Bucket: TEST_STORAGE_CONFIG.bucket, Key: uploaded.key }))).rejects.toBeInstanceOf(NotFound);

    await client.deleteObject({ key: uploaded.key });
  });

  it('builds owner-scoped, versioned keys for both future callers (#101 user profile, #126 client photo)', () => {
    const userId = randomUUID();
    const agencyId = randomUUID();
    const clientId = randomUUID();
    const versionId = randomUUID();
    expect(buildUserAvatarKeyPrefix(userId, versionId)).toBe(`users/${userId}/avatar/${versionId}`);
    expect(buildClientAvatarKeyPrefix(agencyId, clientId, versionId)).toBe(`agencies/${agencyId}/clients/${clientId}/avatar/${versionId}`);
    expect(buildUserAvatarKey(userId, versionId, 'png')).toBe(`users/${userId}/avatar/${versionId}.png`);
    expect(buildClientAvatarKey(agencyId, clientId, versionId, 'webp')).toBe(`agencies/${agencyId}/clients/${clientId}/avatar/${versionId}.webp`);
  });

  it('refuses a non-UUID id, including a path-traversal attempt, and an unknown extension', () => {
    expect(() => buildUserAvatarKeyPrefix('../escape', randomUUID())).toThrow(/must be a UUID/);
    expect(() => buildUserAvatarKeyPrefix(randomUUID(), '../escape')).toThrow(/must be a UUID/);
    expect(() => buildClientAvatarKeyPrefix('../escape', randomUUID(), randomUUID())).toThrow(/must be a UUID/);
    expect(() => buildUserAvatarKey(randomUUID(), randomUUID(), 'svg')).toThrow(/extension must be one produced by detectIdentityImageType/);
    expect(() => buildUserAvatarKey(randomUUID(), randomUUID(), 'html')).toThrow(/extension must be one produced by detectIdentityImageType/);
  });
});
