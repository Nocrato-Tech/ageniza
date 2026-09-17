import { afterAll, describe, expect, it } from 'vitest';

import { buildTestApp, TEST_APP_PUBLIC_URL, uniqueTestEmail, type TestApp } from './test-support/harness.js';
import { AUTH_RATE_LIMITS } from './policy.js';
import type { AuthLimiterOptions } from './auth-limiter.js';

// Issue #31 acceptance test #12. Uses small, test-only injected limits for the IP+email and
// email-global dimensions (per issue instructions); the per-IP dimension comes from
// `@fastify/rate-limit`, wired directly into the route with the production policy.ts numbers, so
// this suite works within those real numbers instead of changing production code to inject smaller
// ones.
const origin = { origin: TEST_APP_PUBLIC_URL };

// Small windows for the two in-memory dimensions this suite controls; the real per-IP window
// (policy.ts `forgot.ip`) is left untouched. `AUTH_RATE_LIMITS`'s own declared type pins each
// number to its production literal (e.g. `10`), so the smaller test-only values are asserted
// through `AuthLimiterOptions['limits']` here instead of loosening that production type.
const smallLimits = {
  login: { ip: AUTH_RATE_LIMITS.login.ip, ipEmail: { max: 2, windowMs: 60_000 }, emailGlobal: { max: 3, windowMs: 60_000 } },
  forgot: { ip: AUTH_RATE_LIMITS.forgot.ip, ipEmail: { max: 2, windowMs: 60_000 }, emailGlobal: { max: 3, windowMs: 60_000 } }
} as unknown as NonNullable<AuthLimiterOptions['limits']>;

const openApps: TestApp[] = [];
const openApp = async (): Promise<TestApp> => {
  const app = await buildTestApp({ limiterOptions: { limits: smallLimits } });
  openApps.push(app);
  return app;
};

afterAll(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

const forgot = (app: TestApp, email: string, remoteAddress: string) =>
  app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email }, remoteAddress });

const rateLimitedBody = { error: { code: 'RATE_LIMITED', message: 'Too many requests' } };

describe('auth rate limiting (#12)', () => {
  it('#12 the IP+email limit trips before the per-IP limit for the same IP and email', async () => {
    const app = await openApp();
    const email = uniqueTestEmail('rl-ip-email');
    const ip = '203.0.113.11';

    const first = await forgot(app, email, ip);
    const second = await forgot(app, email, ip);
    const third = await forgot(app, email, ip);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject(rateLimitedBody);
  });

  it('#12 different emails from the same IP are not blocked until the per-IP limit', async () => {
    const app = await openApp();
    const ip = '203.0.113.12';
    const perIpMax = AUTH_RATE_LIMITS.forgot.ip.max;

    const responses = [];
    for (let index = 0; index < perIpMax; index += 1) {
      // Sequential by design: each request must land inside the same fixed window as the next.
      responses.push(await forgot(app, uniqueTestEmail(`rl-diverse-${index}`), ip));
    }
    expect(responses.every((response) => response.statusCode === 202)).toBe(true);

    const overLimit = await forgot(app, uniqueTestEmail('rl-diverse-over'), ip);
    expect(overLimit.statusCode).toBe(429);
    expect(overLimit.json()).toMatchObject(rateLimitedBody);
  }, 20_000);

  it('#12 the same email from different IPs is blocked by the email-global limit', async () => {
    const app = await openApp();
    const email = uniqueTestEmail('rl-email-global');

    const first = await forgot(app, email, '203.0.113.20');
    const second = await forgot(app, email, '203.0.113.21');
    const third = await forgot(app, email, '203.0.113.22');
    const fourth = await forgot(app, email, '203.0.113.23');

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(third.statusCode).toBe(202);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toMatchObject(rateLimitedBody);
  });
});
