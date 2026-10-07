import { describe, expect, it } from 'vitest';

import { HttpError } from '@ageniza/core';

import { authLimiterEmailKey, authLimiterIpEmailKey, createAuthLimiter, hashAuthEmail, hashAuthIp } from './auth-limiter.js';

describe('in-memory auth limiter', () => {
  it('uses hashed route/dimension keys that include the IP for the ip-email dimension', () => {
    const now = 1_000;
    const limiter = createAuthLimiter({ now: () => now });
    const email = 'Person@example.test';
    const ip = '203.0.113.10';

    expect(authLimiterIpEmailKey('login', ip, email)).toBe(`login:ip-email:${hashAuthIp(ip)}:${hashAuthEmail('person@example.test')}`);
    expect(authLimiterIpEmailKey('login', ip, email)).not.toContain('Person@example.test');
    expect(authLimiterIpEmailKey('login', ip, email)).not.toContain(ip);
    expect(authLimiterEmailKey('login', email)).toBe(`login:email:${hashAuthEmail('person@example.test')}`);
    expect(limiter.check('login', ip, email)).toBe(true);

    for (let attempt = 1; attempt < 10; attempt += 1) expect(limiter.check('login', ip, email)).toBe(true);
    expect(limiter.check('login', ip, email)).toBe(false);
  });

  it('returns the same public 429 error regardless of which dimension is exhausted', () => {
    const limiter = createAuthLimiter();
    for (let attempt = 0; attempt < 10; attempt += 1) limiter.consume('login', '203.0.113.10', 'person@example.test');

    expect(() => limiter.consume('login', '203.0.113.10', 'person@example.test')).toThrow(HttpError);
    try {
      limiter.consume('login', '203.0.113.10', 'person@example.test');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests' });
    }
  });

  it('resets expired windows and supports an injected store/clock', () => {
    let now = 0;
    const store = new Map();
    const limiter = createAuthLimiter({ now: () => now, store });
    limiter.consume('forgot', '203.0.113.10', 'person@example.test');
    expect(store.size).toBe(2);

    now = 15 * 60 * 1_000;
    expect(limiter.tryConsume('forgot', '203.0.113.10', 'person@example.test')).toBe(true);
    limiter.clear();
    expect(store.size).toBe(0);
  });

  it('does not let different emails from the same IP exhaust each other on the ip-email dimension', () => {
    // login.ipEmail max is 10 per 15 minutes; each distinct email gets its own bucket.
    const limiter = createAuthLimiter();
    const ip = '203.0.113.10';

    for (let account = 0; account < 25; account += 1) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect(limiter.check('login', ip, `person-${account}@example.test`)).toBe(true);
      }
      // The 11th attempt against the SAME email from the SAME IP is blocked by ip-email...
      expect(limiter.check('login', ip, `person-${account}@example.test`)).toBe(false);
    }
    // ...but a brand-new email from that same IP is still allowed, well past login.ip's own
    // limit of 100, proving the ip-email bucket never bleeds into a per-IP-only block here.
    expect(limiter.check('login', ip, 'final-account@example.test')).toBe(true);
  });

  describe('M3: bounded memory (purge and eviction)', () => {
    it('purges expired entries from the store every 1,000 calls', () => {
      let now = 0;
      const store = new Map();
      const limiter = createAuthLimiter({ now: () => now, store });

      // Each call touches 2 distinct keys (ip-email + email-global) with a brand-new email, so
      // all of them expire together once the clock moves past their (short) window.
      for (let index = 0; index < 999; index += 1) {
        limiter.check('forgot', '203.0.113.10', `expired-${index}@example.test`);
      }
      expect(store.size).toBe(999 * 2);

      // Move the clock well past every window created above, then issue the 1,000th call: the
      // purge sweep should now run and drop every expired entry, leaving only this call's own.
      now = 60 * 60 * 1_000;
      limiter.check('forgot', '203.0.113.10', 'call-1000@example.test');
      expect(store.size).toBe(2);
    });

    it('enforces a configurable maxEntries cap by evicting the oldest entries first', () => {
      const store = new Map();
      const limiter = createAuthLimiter({ store, maxEntries: 10 });

      for (let index = 0; index < 20; index += 1) {
        limiter.check('login', '203.0.113.10', `account-${index}@example.test`);
      }

      expect(store.size).toBeLessThanOrEqual(10);
    });

    it('never loses the counter for a key that is still active across a purge sweep', () => {
      const now = 0;
      const store = new Map();
      const limiter = createAuthLimiter({ now: () => now, store });

      const ip = '203.0.113.50';
      const email = 'still-active@example.test';
      // login.ipEmail max is 10 per 15 minutes: use up 9, leaving exactly 1 more allowed.
      for (let attempt = 0; attempt < 9; attempt += 1) expect(limiter.check('login', ip, email)).toBe(true);

      // Trigger 1,000+ calls with distinct, already-expired keys to force a purge sweep without
      // advancing time (so the active key above, whose window has not lapsed, must survive it).
      for (let index = 0; index < 995; index += 1) {
        limiter.check('forgot', '203.0.113.99', `noise-${index}@example.test`);
      }

      // The still-active key's 10th (and last allowed) attempt must still be counted correctly.
      expect(limiter.check('login', ip, email)).toBe(true);
      expect(limiter.check('login', ip, email)).toBe(false);
    });
  });

  it('blocks the same email from different IPs only via the email-global dimension', () => {
    // login.ipEmail max is 10, login.emailGlobal max is 50, both per their own window.
    const limiter = createAuthLimiter();
    const email = 'shared@example.test';

    let allowed = 0;
    for (let ipIndex = 0; ipIndex < 50; ipIndex += 1) {
      const ip = `203.0.113.${ipIndex}`;
      // One attempt per IP: never touches the ip-email cap (10) for any single IP.
      if (limiter.check('login', ip, email)) allowed += 1;
    }
    expect(allowed).toBe(50);

    // The 51st distinct IP is blocked purely by the email-global window, not by ip-email.
    expect(limiter.check('login', '203.0.113.99', email)).toBe(false);
  });

  // Issue #338: the e-mail-global windows (login 50/h, recovery 10/h) are pinned by behavior, with
  // an injected clock so the one-hour window is not waited out in real time. Each window is checked
  // at both edges: still closed one millisecond before it lapses, open one millisecond later.
  it('pins the e-mail-global windows: login 50 per hour and recovery 10 per hour', () => {
    let now = 0;
    const limiter = createAuthLimiter({ now: () => now });

    // Recovery: 10 distinct IPs for one e-mail are allowed, the 11th is blocked...
    for (let ipIndex = 0; ipIndex < 10; ipIndex += 1) {
      expect(limiter.check('forgot', `203.0.113.${ipIndex}`, 'window-forgot@example.test')).toBe(true);
    }
    expect(limiter.check('forgot', '203.0.113.98', 'window-forgot@example.test')).toBe(false);
    // ...still blocked one millisecond before the hour lapses...
    now = 60 * 60 * 1_000 - 1;
    expect(limiter.check('forgot', '203.0.113.97', 'window-forgot@example.test')).toBe(false);
    // ...and open one millisecond later.
    now += 1;
    expect(limiter.check('forgot', '203.0.113.96', 'window-forgot@example.test')).toBe(true);

    // Login: 50 distinct IPs are allowed...
    now = 0;
    for (let ipIndex = 0; ipIndex < 50; ipIndex += 1) {
      expect(limiter.check('login', `203.0.114.${ipIndex}`, 'window-login@example.test')).toBe(true);
    }
    // ...the 51st is blocked, still blocked one millisecond before the hour lapses...
    expect(limiter.check('login', '203.0.114.98', 'window-login@example.test')).toBe(false);
    now = 60 * 60 * 1_000 - 1;
    expect(limiter.check('login', '203.0.114.97', 'window-login@example.test')).toBe(false);
    // ...and open one millisecond later.
    now += 1;
    expect(limiter.check('login', '203.0.114.96', 'window-login@example.test')).toBe(true);
  });
});
