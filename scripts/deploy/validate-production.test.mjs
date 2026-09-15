import { describe, expect, it } from 'vitest';

import { assertImmutableGhcrImage, isImmutableGhcrImage } from './validate-image-ref.mjs';

describe('production image references', () => {
  const digest = 'a'.repeat(64);

  it('accepts a lowercase GHCR repository pinned by a sha256 digest', () => {
    expect(isImmutableGhcrImage(`ghcr.io/nocrato-tech/ageniza-api@sha256:${digest}`)).toBe(true);
  });

  it.each([
    'ghcr.io/nocrato-tech/ageniza-api:main',
    `ghcr.io/Nocrato-Tech/ageniza-api@sha256:${digest}`,
    `ghcr.io/nocrato-tech/ageniza-api@sha256:${'A'.repeat(64)}`,
    `ghcr.io/nocrato-tech/ageniza-api@sha256:${'a'.repeat(63)}`
  ])('rejects a mutable or malformed reference: %s', (reference) => {
    expect(() => assertImmutableGhcrImage('API image', reference)).toThrow('64 lowercase hex');
  });
});
