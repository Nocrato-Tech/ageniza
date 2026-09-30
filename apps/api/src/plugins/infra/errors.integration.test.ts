import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiErrorResponseSchema } from '@ageniza/contracts';
import { captureUnexpectedError } from '@ageniza/core';

import {
  buildTestApp,
  captureLogs,
  cleanupOwnedAgencyContext,
  cleanupTestUser,
  grantOwnedAgencyContext,
  insertTestUser,
  TEST_APP_PUBLIC_URL,
  type CapturedLogs,
  type TestApp,
  type TestUserFixture
} from '../../modules/auth/test-support/harness.js';

// `errors.ts` imports `captureUnexpectedError` directly, so proving it is *not* called needs the
// module seam mocked. The factory keeps every real export and replaces only the Sentry call, which
// is a no-op in tests anyway: without it a 500 would be invisible and the assertion empty.
vi.mock('@ageniza/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, captureUnexpectedError: vi.fn() };
});

const mockedCaptureUnexpectedError = vi.mocked(captureUnexpectedError);

const origin = { origin: TEST_APP_PUBLIC_URL };

// Issue #191. Every body the Fastify parser can reject: malformed JSON, an empty body declared as
// JSON, and a content-type no parser accepts. The payloads carry a sentinel so the response is also
// checked against echoing a fragment of the rejected body.
const sentinel = 'sentinel-must-not-be-echoed';

interface BodyCase {
  readonly label: string;
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly headers: Record<string, string>;
  readonly payload?: string;
}

const bodyCases: readonly BodyCase[] = [
  {
    label: 'malformed JSON',
    status: 400,
    code: 'INVALID_BODY',
    message: 'O corpo da requisição é inválido.',
    headers: { 'content-type': 'application/json' },
    payload: `{"leak":"${sentinel}"`
  },
  {
    label: 'empty body declared as JSON',
    status: 400,
    code: 'INVALID_BODY',
    message: 'O corpo da requisição é inválido.',
    headers: { 'content-type': 'application/json' }
  },
  {
    label: 'unsupported content-type',
    status: 415,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'O tipo de conteúdo da requisição não é suportado.',
    headers: { 'content-type': 'application/xml' },
    payload: `<leak>${sentinel}</leak>`
  }
];

const publicRoutes: readonly { readonly method: 'POST'; readonly url: string }[] = [
  { method: 'POST', url: '/auth/login' },
  { method: 'POST', url: '/auth/password/forgot' },
  { method: 'POST', url: '/invitations/some-token/accept-new-account' }
];

const cookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

describe('malformed request bodies answer 400/415, never 500 (#191)', () => {
  const openApps: TestApp[] = [];
  let app: TestApp;
  let logs: CapturedLogs;
  let user: TestUserFixture;
  let cookie: string;
  let ownedAgencyId: string | undefined;

  const flushLogs = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  beforeEach(() => {
    mockedCaptureUnexpectedError.mockClear();
  });

  beforeAll(async () => {
    logs = captureLogs();
    app = await buildTestApp({ logger: logs.logger });
    openApps.push(app);

    // A real, valid session for the one authenticated write route below. Body parsing runs before
    // the session guard, so the session is not what makes these cases pass -- it is what makes the
    // authenticated route a fair target, exactly as a signed-in browser would hit it.
    user = await insertTestUser(app.pool, app.auth, { emailLabel: 'malformed-body' });
    ownedAgencyId = await grantOwnedAgencyContext(user.id);
    const login = await app.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: origin,
      payload: { email: user.email, password: user.password }
    });
    expect(login.statusCode).toBe(200);
    cookie = cookieHeader(login.cookies);
  });

  afterAll(async () => {
    if (ownedAgencyId !== undefined) await cleanupOwnedAgencyContext(ownedAgencyId);
    if (user !== undefined) await cleanupTestUser(app.pool, user.id);
    await Promise.all(openApps.splice(0).map((opened) => opened.close()));
  });

  const assertAnswer = async (
    response: { readonly statusCode: number; readonly body: string; json(): unknown },
    bodyCase: BodyCase,
    logOffset: number
  ): Promise<void> => {
    expect(response.statusCode).toBe(bodyCase.status);
    const parsed = ApiErrorResponseSchema.parse(response.json());
    expect(parsed.error.code).toBe(bodyCase.code);
    expect(parsed.error.message).toBe(bodyCase.message);
    expect(response.body).not.toContain(sentinel);

    // A 500 would call both of these; the fix keeps the case out of that branch entirely.
    expect(mockedCaptureUnexpectedError).not.toHaveBeenCalled();
    await flushLogs();
    const requestLogs = logs.lines().slice(logOffset).join('\n');
    expect(requestLogs).not.toContain('"level":50');
    expect(requestLogs).not.toContain('Request failed unexpectedly');
  };

  for (const route of publicRoutes) {
    describe(`${route.method} ${route.url}`, () => {
      for (const bodyCase of bodyCases) {
        it(`answers ${bodyCase.status} ${bodyCase.code} for ${bodyCase.label}`, async () => {
          const logOffset = logs.lines().length;
          const response = await app.app.inject({
            method: route.method,
            url: route.url,
            headers: { ...origin, ...bodyCase.headers },
            ...(bodyCase.payload === undefined ? {} : { payload: bodyCase.payload })
          });
          await assertAnswer(response, bodyCase, logOffset);
        });
      }
    });
  }

  describe('PUT /me/last-context (authenticated write)', () => {
    for (const bodyCase of bodyCases) {
      it(`answers ${bodyCase.status} ${bodyCase.code} for ${bodyCase.label}`, async () => {
        const logOffset = logs.lines().length;
        const response = await app.app.inject({
          method: 'PUT',
          url: '/me/last-context',
          headers: { ...origin, ...bodyCase.headers, cookie },
          ...(bodyCase.payload === undefined ? {} : { payload: bodyCase.payload })
        });
        await assertAnswer(response, bodyCase, logOffset);
      });
    }
  });
});
