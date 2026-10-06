import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildClientAvatarKey, buildUserAvatarKey, isClientAvatarKey } from './policy.js';

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
