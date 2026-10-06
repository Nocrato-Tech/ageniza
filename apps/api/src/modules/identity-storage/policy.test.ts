import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PROFILE_PHOTO_ACCEPTED_MIME_TYPES } from '@ageniza/contracts';

import { buildClientAvatarKey, buildUserAvatarKey, detectIdentityImageType, isClientAvatarKey } from './policy.js';

/**
 * The web profile screen filters files by the MIME list in `@ageniza/contracts`, but the API is the
 * authority and accepts a type only when the bytes carry one of the signatures below. If an entry
 * leaves the contract while the detector still accepts it, the screen starts refusing a file the
 * API would take; if the detector drops a signature, the screen sends a file the API refuses.
 */
const SAMPLES: Readonly<Record<(typeof PROFILE_PHOTO_ACCEPTED_MIME_TYPES)[number], readonly number[]>> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/gif': [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  'image/webp': [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]
};

describe('identity image allowlist (#108)', () => {
  it.each(PROFILE_PHOTO_ACCEPTED_MIME_TYPES)('detects the bytes of every advertised %s', (mimeType) => {
    expect(detectIdentityImageType(new Uint8Array(SAMPLES[mimeType]))?.contentType).toBe(mimeType);
  });

  it('rejects a type the web must never send, even labelled as an image', () => {
    expect(detectIdentityImageType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeUndefined();
  });
});

describe('isClientAvatarKey (issue #126)', () => {
  const agencyId = randomUUID();
  const clientId = randomUUID();

  it('accepts every key the builder produces for exactly this agency and client', () => {
    for (const extension of ['png', 'jpg', 'webp', 'gif']) {
      expect(isClientAvatarKey(buildClientAvatarKey(agencyId, clientId, randomUUID(), extension), agencyId, clientId)).toBe(true);
    }
  });

  it('refuses a key of another client, another agency, or another owner kind', () => {
    const version = randomUUID();
    expect(isClientAvatarKey(buildClientAvatarKey(agencyId, randomUUID(), version, 'png'), agencyId, clientId)).toBe(false);
    expect(isClientAvatarKey(buildClientAvatarKey(randomUUID(), clientId, version, 'png'), agencyId, clientId)).toBe(false);
    expect(isClientAvatarKey(buildUserAvatarKey(randomUUID(), version, 'png'), agencyId, clientId)).toBe(false);
  });

  it('refuses traversal, nesting, a foreign extension and a non-uuid version inside the right directory', () => {
    const directory = `agencies/${agencyId}/clients/${clientId}/avatar/`;
    const version = randomUUID();
    for (const key of [
      `${directory}../${version}.png`,
      `${directory}nested/${version}.png`,
      `${directory}${version}.svg`,
      `${directory}${version}.html`,
      `${directory}${version}`,
      `${directory}.png`,
      `${directory}not-a-uuid.png`,
      `${directory}${version}.png/extra`,
      `agencies/${agencyId}/clients/${clientId}/avatars/${version}.png`,
      `${directory.toUpperCase()}${version}.png`,
      ''
    ]) {
      expect(isClientAvatarKey(key, agencyId, clientId), key).toBe(false);
    }
  });

  it('throws, rather than comparing, when the ids themselves are not UUIDs', () => {
    expect(() => isClientAvatarKey('agencies/x/clients/y/avatar/z.png', '../x', clientId)).toThrow();
    expect(() => isClientAvatarKey('agencies/x/clients/y/avatar/z.png', agencyId, 'not-a-uuid')).toThrow();
  });
});
