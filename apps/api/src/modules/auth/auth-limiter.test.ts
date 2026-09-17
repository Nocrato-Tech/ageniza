import { describe, expect, it } from 'vitest';

import { HttpError } from '@ageniza/core';

import { authLimiterKey, createAuthLimiter, hashAuthEmail } from './auth-limiter.js';

describe('in-memory auth limiter', () => {
  it('uses hashed route/dimension keys and applies both windows', () => {
    const now = 1_000;
    const limiter = createAuthLimiter({ now: () => now });
    const email = 'Person@example.test';

    expect(authLimiterKey('login', 'ip', email)).toBe(`login:ip:${hashAuthEmail('person@example.test')}`);
    expect(authLimiterKey('login', 'ip', email)).not.toContain('Person@example.test');
    expect(limiter.check('login', email)).toBe(true);

    for (let attempt = 1; attempt < 10; attempt += 1) expect(limiter.check('login', email)).toBe(true);
    expect(limiter.check('login', email)).toBe(false);
  });

  it('returns the same public 429 error regardless of which dimension is exhausted', () => {
    const limiter = createAuthLimiter();
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.consume('login', 'person@example.test');

    expect(() => limiter.consume('login', 'person@example.test')).toThrow(HttpError);
    try {
      limiter.consume('login', 'person@example.test');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests' });
    }
  });

  it('resets expired windows and supports an injected store/clock', () => {
    let now = 0;
    const store = new Map();
    const limiter = createAuthLimiter({ now: () => now, store });
    limiter.consume('forgot', 'person@example.test');
    expect(store.size).toBe(2);

    now = 15 * 60 * 1_000;
    expect(limiter.tryConsume('forgot', 'person@example.test')).toBe(true);
    limiter.clear();
    expect(store.size).toBe(0);
  });
});
