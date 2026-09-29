import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TEST_IDENTITY_STORAGE_CONFIG, TEST_STORAGE_CONFIG } from '../auth/test-support/harness.js';
import { buildClientAvatarKey, buildUserAvatarKey, describeIdentityContentType } from './policy.js';
import { createIdentityStorageClient } from './storage-client.js';

// Issue #100 acceptance tests. Runs against the real local LocalStack started by
// `pnpm storage:start` -- see apps/api/src/modules/identity-storage/README.md.
describe('identity storage client (issue #100)', () => {
  it('uploads through the server, reads back only via a signed URL, and deletes on removal', async () => {
    const client = createIdentityStorageClient(TEST_IDENTITY_STORAGE_CONFIG);
    const key = buildUserAvatarKey(randomUUID(), 'png');
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    await client.uploadObject({ key, contentType: 'image/png', body });

    const signedUrl = await client.presignGetObject({ key, expiresInSeconds: 60 });
    const response = await fetch(signedUrl);
    expect(response.ok).toBe(true);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);

    // Bucket/object privacy itself (rejecting an anonymous, unsigned request) is not exercised
    // here: LocalStack does not enforce access control the way R2 does, the same gap the media
    // module documents for credential rejection -- see this module's README's "could not be
    // verified locally" section. The only client-observable acceptance signal available locally
    // is that this module never hands out anything but a signed URL, which every route above does.

    await client.deleteObject({ key });
    const afterDelete = await fetch(signedUrl);
    expect(afterDelete.ok).toBe(false);
  });

  it('never touches the media bucket: the two configs point at distinct buckets', () => {
    expect(TEST_IDENTITY_STORAGE_CONFIG.bucket).not.toBe(TEST_STORAGE_CONFIG.bucket);
  });

  it('builds owner-scoped keys for both future callers (#101 user profile, #126 client photo)', () => {
    const userId = randomUUID();
    const agencyId = randomUUID();
    const clientId = randomUUID();
    expect(buildUserAvatarKey(userId, 'png')).toBe(`users/${userId}/avatar.png`);
    expect(buildClientAvatarKey(agencyId, clientId, 'webp')).toBe(`agencies/${agencyId}/clients/${clientId}/avatar.webp`);
  });

  it('accepts only the still-image allowlist media already uses, and rejects everything else', () => {
    expect(describeIdentityContentType('image/png')).toEqual({ extension: 'png' });
    expect(describeIdentityContentType('image/jpeg')).toEqual({ extension: 'jpg' });
    expect(describeIdentityContentType('image/webp')).toEqual({ extension: 'webp' });
    expect(describeIdentityContentType('image/gif')).toEqual({ extension: 'gif' });
    expect(describeIdentityContentType('IMAGE/PNG')).toEqual({ extension: 'png' });
    expect(describeIdentityContentType('video/mp4')).toBeUndefined();
    expect(describeIdentityContentType('application/pdf')).toBeUndefined();
  });
});
