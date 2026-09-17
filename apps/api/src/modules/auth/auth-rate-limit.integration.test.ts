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

const forgot = (app: TestApp, email: string, remoteAddress: string, requestId?: string) =>
  app.app.inject({
    method: 'POST', url: '/auth/password/forgot',
    headers: requestId === undefined ? origin : { ...origin, 'x-request-id': requestId },
    payload: { email }, remoteAddress
  });

// A deliberately wrong password: every login attempt here should be rejected by the rate
// limiter before it ever reaches Better Auth's own credential check.
const login = (app: TestApp, email: string, remoteAddress: string, requestId?: string) =>
  app.app.inject({
    method: 'POST', url: '/auth/login',
    headers: requestId === undefined ? origin : { ...origin, 'x-request-id': requestId },
    payload: { email, password: 'definitely the wrong password' }, remoteAddress
  });

const rateLimitedBody = { error: { code: 'RATE_LIMITED', message: 'Too many requests' } };

/** The response headers that must never differ between a per-IP 429 (from `@fastify/rate-limit`)
 * and an in-memory-dimension 429 (from `InMemoryAuthLimiter`) — B6: neither may reveal which
 * limit tripped. Content-type/length and the app's own correlation headers are excluded since
 * those are expected to vary by response body/request, not by which limiter fired. */
const relevantHeaderNames = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'];
const relevantHeaders = (headers: Record<string, unknown>): Record<string, unknown> => {
  const picked: Record<string, unknown> = {};
  for (const name of relevantHeaderNames) if (name in headers) picked[name] = headers[name];
  return picked;
};

describe('auth rate limiting (#12)', () => {
  it('#12 the IP+email limit trips before the per-IP limit for the same IP and email', async () => {
    const app = await openApp();
    const email = uniqueTestEmail('rl-ip-email');
    const ip = '203.0.113.11';
    const sharedRequestId = 'rl-ip-email-shared-request-id';

    const first = await forgot(app, email, ip);
    const second = await forgot(app, email, ip);
    const third = await forgot(app, email, ip, sharedRequestId);
    const fourth = await forgot(app, email, ip, sharedRequestId);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject(rateLimitedBody);
    // Two 429s from the SAME dimension, with the same client-supplied request id, must be
    // byte-for-byte identical (M5's stricter body comparison).
    expect(fourth.statusCode).toBe(429);
    expect(fourth.body).toBe(third.body);
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

  it('#12 (M5) the login route mirrors the forgot route: IP+email trips before per-IP', async () => {
    const app = await openApp();
    const email = uniqueTestEmail('rl-login-ip-email');
    const ip = '203.0.113.31';
    const sharedRequestId = 'rl-login-ip-email-shared-request-id';

    const first = await login(app, email, ip);
    const second = await login(app, email, ip);
    const third = await login(app, email, ip, sharedRequestId);
    const fourth = await login(app, email, ip, sharedRequestId);

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject(rateLimitedBody);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.body).toBe(third.body);
  });

  it('#12 (M5) the login route mirrors the forgot route: different emails not blocked until per-IP', async () => {
    const app = await openApp();
    const ip = '203.0.113.32';
    const perIpMax = AUTH_RATE_LIMITS.login.ip.max;

    const responses = [];
    for (let index = 0; index < perIpMax; index += 1) {
      responses.push(await login(app, uniqueTestEmail(`rl-login-diverse-${index}`), ip));
    }
    expect(responses.every((response) => response.statusCode === 401)).toBe(true);

    const overLimit = await login(app, uniqueTestEmail('rl-login-diverse-over'), ip);
    expect(overLimit.statusCode).toBe(429);
    expect(overLimit.json()).toMatchObject(rateLimitedBody);
  }, 60_000);

  it('#12 (M5) the login route mirrors the forgot route: same email from different IPs blocked by email-global', async () => {
    const app = await openApp();
    const email = uniqueTestEmail('rl-login-email-global');

    const first = await login(app, email, '203.0.113.40');
    const second = await login(app, email, '203.0.113.41');
    const third = await login(app, email, '203.0.113.42');
    const fourth = await login(app, email, '203.0.113.43');

    expect(first.statusCode).toBe(401);
    expect(second.statusCode).toBe(401);
    expect(third.statusCode).toBe(401);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json()).toMatchObject(rateLimitedBody);
  });

  it('#12 (M5, B6) a per-IP 429 and an in-memory-dimension 429 carry the same relevant headers', async () => {
    const app = await openApp();
    const sharedRequestId = 'rl-headers-shared-request-id';

    // Trips the in-memory ip-email dimension (max 2 for `forgot` in this suite's small limits).
    const dimensionIp = '203.0.113.50';
    const dimensionEmail = uniqueTestEmail('rl-headers-dimension');
    await forgot(app, dimensionEmail, dimensionIp);
    await forgot(app, dimensionEmail, dimensionIp);
    const dimension429 = await forgot(app, dimensionEmail, dimensionIp, sharedRequestId);
    expect(dimension429.statusCode).toBe(429);

    // Trips the real per-IP `@fastify/rate-limit` dimension for `forgot` (max 30) with a fresh IP
    // and a distinct email on every request, so no in-memory dimension trips first.
    const perIpIp = '203.0.113.51';
    const perIpMax = AUTH_RATE_LIMITS.forgot.ip.max;
    for (let index = 0; index < perIpMax; index += 1) {
      await forgot(app, uniqueTestEmail(`rl-headers-perip-${index}`), perIpIp);
    }
    const perIp429 = await forgot(app, uniqueTestEmail('rl-headers-perip-over'), perIpIp, sharedRequestId);
    expect(perIp429.statusCode).toBe(429);

    // Same client-supplied request id on both requests: an identical body proves the two 429s
    // are indistinguishable beyond status code (M5).
    expect(perIp429.body).toBe(dimension429.body);
    expect(relevantHeaders(perIp429.headers)).toEqual(relevantHeaders(dimension429.headers));
    // Neither 429 leaks any of the informative rate-limit headers at all (B6).
    expect(relevantHeaders(perIp429.headers)).toEqual({});
  }, 20_000);
});
