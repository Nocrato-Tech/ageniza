import { describe, expect, it } from 'vitest';

import { credentialIsStill } from './credential-recheck.js';

describe('credentialIsStill (#719)', () => {
  it('holds only when the hash read now is the hash that was checked', async () => {
    expect(await credentialIsStill(async () => 'hash-a', 'hash-a')).toBe(true);
    expect(await credentialIsStill(async () => 'hash-b', 'hash-a')).toBe(false);
    expect(await credentialIsStill(async () => undefined, 'hash-a')).toBe(false);
  });

  it('answers no when nothing was checked, even if nothing is there now', async () => {
    expect(await credentialIsStill(async () => undefined, undefined)).toBe(false);
  });

  it('answers no when the read fails', async () => {
    expect(await credentialIsStill(async () => { throw new Error('connection reset'); }, 'hash-a')).toBe(false);
  });
});
