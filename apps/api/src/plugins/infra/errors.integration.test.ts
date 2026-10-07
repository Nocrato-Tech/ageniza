import { createServer, get as httpGet, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';

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

const flushLogs = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const waitUntil = async (predicate: () => boolean, timeoutMs = 4_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Declares a body larger than what is actually sent and destroys the socket mid-body. `inject`
 * cannot simulate this, so the request goes over a real TCP connection; the server should see the
 * abort during parsing, before any route handler.
 */
const abortRequestBody = async (port: number, path: string): Promise<void> => {
  await new Promise<void>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          `Origin: ${TEST_APP_PUBLIC_URL}\r\n` +
          'Content-Type: application/json\r\n' +
          'Content-Length: 1000\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          '{"email":'
      );
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 100);
    });
    socket.on('error', () => resolve());
  });
};

describe('malformed request bodies answer 400/415, never 500 (#191)', () => {
  const openApps: TestApp[] = [];
  let app: TestApp;
  let logs: CapturedLogs;
  let user: TestUserFixture;
  let cookie: string;
  let ownedAgencyId: string | undefined;
  let serverPort: number;

  beforeEach(() => {
    mockedCaptureUnexpectedError.mockClear();
  });

  beforeAll(async () => {
    logs = captureLogs();
    app = await buildTestApp({ logger: logs.logger });
    openApps.push(app);
    // The abort case needs a real TCP connection: `inject` never aborts mid-body.
    const address = await app.app.listen({ port: 0, host: '127.0.0.1' });
    serverPort = Number(new URL(address).port);

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

  // Review of #194, finding 1: an aborted body is `ECONNRESET` with the raw request aborted, and
  // must not reach the 500 branch either. The log line names the dedicated code, so the assertion
  // cannot pass by simply never handling the request.
  it('answers 400 REQUEST_ABORTED for a body aborted mid-stream, with no error log and no Sentry event', async () => {
    const logOffset = logs.lines().length;
    await abortRequestBody(serverPort, '/auth/login');
    await waitUntil(() => {
      const requestLogs = logs.lines().slice(logOffset).join('\n');
      return requestLogs.includes('"code":"REQUEST_ABORTED"') || requestLogs.includes('Request failed unexpectedly');
    });
    await flushLogs();

    const requestLogs = logs.lines().slice(logOffset).join('\n');
    expect(requestLogs).toContain('"code":"REQUEST_ABORTED"');
    expect(requestLogs).toContain('"level":30');
    expect(requestLogs).not.toContain('"level":50');
    expect(requestLogs).not.toContain('Request failed unexpectedly');
    expect(mockedCaptureUnexpectedError).not.toHaveBeenCalled();
  });
});

// Review of #194, finding 2: an error that merely carries a 4xx `statusCode` is still unexpected
// unless its exact code is mapped. The second case also guards that a body abort is recognised by
// the body stream's own error, not by any `ECONNRESET` (issue #195).
describe('errors outside the map are never downgraded by statusCode (#194 review)', () => {
  it('answers 500 INTERNAL_ERROR and captures once for an unmapped 4xx error', async () => {
    const logs = captureLogs();
    const app = await buildTestApp({
      logger: logs.logger,
      registerExtraRoutes: (fastifyApp) => {
        fastifyApp.get('/__test/unmapped-4xx', async () => {
          throw Object.assign(new Error('unmapped 4xx must stay unexpected'), { statusCode: 400, code: 'FST_ERR_TEST_UNMAPPED' });
        });
      }
    });
    try {
      mockedCaptureUnexpectedError.mockClear();
      const response = await app.app.inject({ method: 'GET', url: '/__test/unmapped-4xx' });

      expect(response.statusCode).toBe(500);
      expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe('INTERNAL_ERROR');
      expect(mockedCaptureUnexpectedError).toHaveBeenCalledTimes(1);

      await flushLogs();
      expect(logs.text()).toContain('"level":50');
      expect(logs.text()).toContain('Request failed unexpectedly');
    } finally {
      await app.close();
    }
  });

  it('answers 500 INTERNAL_ERROR for an upstream ECONNRESET, which is not a body abort', async () => {
    const logs = captureLogs();
    const app = await buildTestApp({
      logger: logs.logger,
      registerExtraRoutes: (fastifyApp) => {
        fastifyApp.get('/__test/upstream-econnreset', async () => {
          // An upstream reset (pg, S3, SMTP) reads `read ECONNRESET`; only Node's own body-abort is
          // the exact `Error('aborted')` with `code === 'ECONNRESET'` (issue #195).
          throw Object.assign(new Error('read ECONNRESET'), { statusCode: 400, code: 'ECONNRESET' });
        });
      }
    });
    try {
      mockedCaptureUnexpectedError.mockClear();
      const response = await app.app.inject({ method: 'GET', url: '/__test/upstream-econnreset' });

      expect(response.statusCode).toBe(500);
      expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe('INTERNAL_ERROR');
      expect(mockedCaptureUnexpectedError).toHaveBeenCalledTimes(1);

      await flushLogs();
      expect(logs.text()).toContain('"level":50');
    } finally {
      await app.close();
    }
  });
});

// Issue #217 (security review of #96): a path segment over Fastify's `maxParamLength` of 100 threw
// FST_ERR_MAX_PARAM_LENGTH, which escaped as the framework's raw 414 body and echoed the path. The
// code is now mapped like the parser errors: fixed envelope, no path, info log, no Sentry.
describe('an over-long path parameter answers 414 inside the envelope (#217)', () => {
  const openApps: TestApp[] = [];
  let app: TestApp;
  let logs: CapturedLogs;
  let user: TestUserFixture;
  let cookie: string;
  let ownedAgencyId: string | undefined;

  const overlong = 'x'.repeat(101);

  beforeAll(async () => {
    logs = captureLogs();
    app = await buildTestApp({ logger: logs.logger });
    openApps.push(app);

    user = await insertTestUser(app.pool, app.auth, { emailLabel: 'param-length' });
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

  const assertOverlong = async (response: { readonly statusCode: number; readonly body: string; json(): unknown }): Promise<void> => {
    expect(response.statusCode).toBe(414);
    const parsed = ApiErrorResponseSchema.parse(response.json());
    expect(parsed.error.code).toBe('URI_TOO_LONG');
    expect(parsed.error.message).toBe('O caminho da requisição é longo demais.');
    // Neither the path nor the framework's raw code is echoed back.
    expect(response.body).not.toContain(overlong);
    expect(response.body).not.toContain('FST_ERR_MAX_PARAM_LENGTH');

    expect(mockedCaptureUnexpectedError).not.toHaveBeenCalled();
    await flushLogs();
    const requestLogs = logs.lines().slice(logOffset).join('\n');
    expect(requestLogs).toContain('"code":"URI_TOO_LONG"');
    expect(requestLogs).toContain('"level":30');
    expect(requestLogs).not.toContain('"level":50');
    expect(requestLogs).not.toContain('Request failed unexpectedly');
  };

  let logOffset = 0;
  beforeEach(() => {
    mockedCaptureUnexpectedError.mockClear();
    logOffset = logs.lines().length;
  });

  it('answers 414 for a public route', async () => {
    const response = await app.app.inject({ method: 'GET', url: `/invitations/${overlong}`, headers: origin });
    await assertOverlong(response);
  });

  it('answers 414 for an authenticated route', async () => {
    const response = await app.app.inject({ method: 'GET', url: `/agencies/${overlong}/me`, headers: { ...origin, cookie } });
    await assertOverlong(response);
  });

  // The same router hook carries FST_ERR_BAD_URL; mapping it is what keeps a malformed URL a 400
  // envelope instead of an unexpected 500 once `frameworkErrors` feeds this path.
  it('answers a malformed URL component as a 400 envelope, not a 500', async () => {
    const offset = logs.lines().length;
    const response = await app.app.inject({ method: 'GET', url: '/invitations/%ZZ', headers: origin });
    expect(response.statusCode).toBe(400);
    expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe('INVALID_URL');
    expect(response.body).not.toContain('%ZZ');
    expect(mockedCaptureUnexpectedError).not.toHaveBeenCalled();
    await flushLogs();
    const requestLogs = logs.lines().slice(offset).join('\n');
    expect(requestLogs).not.toContain('"level":50');
  });

  // Issue #227: the synthetic reply of `frameworkErrors` skips the `onRequest` hooks, so these
  // responses used to go out without the correlation and security headers every other reply has.
  // Issue #309: the security half is compared by EQUALITY with a normal reply, by header name, not
  // by `toContain` or truthiness -- a divergent CSP or an HSTS max-age=1 in this path stayed green.
  type InjectedResponse = Awaited<ReturnType<TestApp['app']['inject']>>;

  /** Every header helmet touches, matched by name so a new default is compared too. */
  const SECURITY_HEADER_PATTERN = /^(content-security-policy|x-content-type-options|x-frame-options|x-xss-protection|x-dns-prefetch-control|x-download-options|x-permitted-cross-domain-policies|referrer-policy|strict-transport-security|origin-agent-cluster|cross-origin-(opener|embedder|resource)-policy)$/;

  const securityHeadersOf = (response: InjectedResponse): Record<string, unknown> =>
    Object.fromEntries(Object.entries(response.headers).filter(([name]) => SECURITY_HEADER_PATTERN.test(name)));

  const expectRouterErrorHeaders = (response: InjectedResponse, reference: InjectedResponse): void => {
    expect(response.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(response.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9._:-]+$/);
    // Same source, not a lookalike: `toEqual` also fails when the router error is missing a header
    // the normal reply carries.
    expect(securityHeadersOf(response)).toEqual(securityHeadersOf(reference));
  };

  it('carries the correlation and security headers on the 414 and the 400, identical to a normal reply', async () => {
    const health = await app.app.inject({ method: 'GET', url: '/health', headers: origin });
    expect(health.statusCode).toBe(200);

    // Review of #321 (issue #309): the equality above cannot see a regression that changes the
    // header in BOTH replies -- they come from the same `SECURITY_HEADER_OPTIONS` -- so the whole
    // reference set is pinned by value too, in one assertion (full CSP, full HSTS, the rest).
    expect(securityHeadersOf(health)).toEqual({
      'content-security-policy': "default-src 'none';base-uri 'none';font-src 'self' https: data:;form-action 'self';frame-ancestors 'none';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests",
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
      'origin-agent-cluster': '?1',
      'referrer-policy': 'no-referrer',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      'x-dns-prefetch-control': 'off',
      'x-download-options': 'noopen',
      'x-frame-options': 'SAMEORIGIN',
      'x-permitted-cross-domain-policies': 'none',
      'x-xss-protection': '0'
    });

    const overlongResponse = await app.app.inject({ method: 'GET', url: `/invitations/${overlong}`, headers: origin });
    expect(overlongResponse.statusCode).toBe(414);
    expectRouterErrorHeaders(overlongResponse, health);

    const badUrlResponse = await app.app.inject({ method: 'GET', url: '/invitations/%ZZ', headers: origin });
    expect(badUrlResponse.statusCode).toBe(400);
    expectRouterErrorHeaders(badUrlResponse, health);
  });

  it('preserves a valid inbound correlation id on the router error', async () => {
    const response = await app.app.inject({
      method: 'GET',
      url: `/invitations/${overlong}`,
      headers: { ...origin, 'x-correlation-id': 'flow-42' }
    });

    expect(response.statusCode).toBe(414);
    expect(response.headers['x-correlation-id']).toBe('flow-42');
  });

  // Issue #309 (review of PR #230, M1): the router error reaches `applyCorrelationHeaders` through
  // the synthetic reply too, so a correlation id the pattern refuses -- a markup fragment, say --
  // must be replaced by a generated one, never echoed back to the caller.
  it('does not echo an invalid inbound correlation id on the router error', async () => {
    const hostile = '<img src=x onerror=1>';
    const overlongResponse = await app.app.inject({
      method: 'GET',
      url: `/invitations/${overlong}`,
      headers: { ...origin, 'x-correlation-id': hostile }
    });
    expect(overlongResponse.statusCode).toBe(414);
    expect(overlongResponse.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(overlongResponse.headers['x-correlation-id']).not.toBe(hostile);
    expect(overlongResponse.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:-]+$/);

    const badUrlResponse = await app.app.inject({
      method: 'GET',
      url: '/invitations/%ZZ',
      headers: { ...origin, 'x-correlation-id': hostile }
    });
    expect(badUrlResponse.statusCode).toBe(400);
    expect(badUrlResponse.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(badUrlResponse.headers['x-correlation-id']).not.toBe(hostile);
    expect(badUrlResponse.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:-]+$/);
  });
});

// Issue #195: `raw.readableAborted` is true whenever a client leaves, even on a bodyless GET, so the
// body abort must be recognised by the body stream's own error. These tests use a real port and a raw
// socket, because `inject` cannot make a client leave in the middle of a request.
describe('a client that left does not hide a real failure (#195)', () => {
  const openApps: TestApp[] = [];
  let app: TestApp;
  let logs: CapturedLogs;
  let port: number;

  beforeAll(async () => {
    logs = captureLogs();
    app = await buildTestApp({
      logger: logs.logger,
      registerExtraRoutes: (fastifyApp) => {
        fastifyApp.get('/__test/upstream-econnreset-after-leave', async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          throw Object.assign(new Error('read ECONNRESET'), { statusCode: 400, code: 'ECONNRESET' });
        });
        fastifyApp.get('/__test/generic-failure-after-leave', async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          throw new Error('boom');
        });
      }
    });
    openApps.push(app);
    const address = await app.app.listen({ port: 0, host: '127.0.0.1' });
    port = Number(new URL(address).port);
  });

  afterAll(async () => {
    await Promise.all(openApps.splice(0).map((opened) => opened.close()));
  });

  const abandonGet = async (path: string): Promise<void> => {
    await new Promise<void>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 50);
      });
      socket.on('error', () => resolve());
    });
  };

  const logsAfterHandling = async (offset: number): Promise<string> => {
    await waitUntil(() => {
      const text = logs.lines().slice(offset).join('\n');
      return mockedCaptureUnexpectedError.mock.calls.length > 0 || text.includes('"code":"REQUEST_ABORTED"');
    });
    await flushLogs();
    return logs.lines().slice(offset).join('\n');
  };

  it('keeps an upstream ECONNRESET after the client left on the 500 + Sentry path', async () => {
    mockedCaptureUnexpectedError.mockClear();
    const offset = logs.lines().length;
    await abandonGet('/__test/upstream-econnreset-after-leave');
    const requestLogs = await logsAfterHandling(offset);

    expect(mockedCaptureUnexpectedError).toHaveBeenCalledTimes(1);
    expect(requestLogs).toContain('"code":"INTERNAL_ERROR"');
    expect(requestLogs).toContain('"level":50');
    expect(requestLogs).not.toContain('"code":"REQUEST_ABORTED"');
  });

  it('keeps a generic handler failure after the client left on the 500 + Sentry path', async () => {
    mockedCaptureUnexpectedError.mockClear();
    const offset = logs.lines().length;
    await abandonGet('/__test/generic-failure-after-leave');
    const requestLogs = await logsAfterHandling(offset);

    expect(mockedCaptureUnexpectedError).toHaveBeenCalledTimes(1);
    expect(requestLogs).toContain('"code":"INTERNAL_ERROR"');
    expect(requestLogs).toContain('"level":50');
    expect(requestLogs).not.toContain('"code":"REQUEST_ABORTED"');
  });
});

// Issue #211: with the shape of the error alone, a truncated **upstream** response -- the very same
// `Error('aborted')` with `ECONNRESET` Node raises for a body abort -- became a 400 for a client that
// was still connected, hiding a real failure from Sentry. The abort now needs both signs, and these
// tests exercise the two ways a single signal lies.
describe('a body abort needs the error shape and the aborted request (#211)', () => {
  const openApps: TestApp[] = [];
  let app: TestApp;
  let logs: CapturedLogs;
  let port: number;
  let upstream: Server;
  let upstreamPort: number;

  /** Reads an upstream body that promises more bytes than it sends, like a cut S3/R2 or HTTP reply. */
  const readTrimmedUpstream = (targetPort: number): Promise<string> => new Promise((resolve, reject) => {
    const request = httpGet({ host: '127.0.0.1', port: targetPort, path: '/body' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.on('error', reject);
  });

  beforeAll(async () => {
    upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      response.write('partial');
      setImmediate(() => response.socket?.destroy());
    });
    await new Promise<void>((resolve) => { upstream.listen(0, '127.0.0.1', () => resolve()); });
    upstreamPort = (upstream.address() as AddressInfo).port;

    logs = captureLogs();
    app = await buildTestApp({
      logger: logs.logger,
      registerExtraRoutes: (fastifyApp) => {
        // Client still connected; the abort belongs to the upstream, not to the request.
        fastifyApp.get('/__test/trimmed-upstream', async () => readTrimmedUpstream(upstreamPort));
        // The exact message, but no `ECONNRESET` code: not the body abort.
        fastifyApp.get('/__test/aborted-without-code', async () => { throw new Error('aborted'); });
        fastifyApp.get('/__test/aborted-without-code-after-leave', async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          throw new Error('aborted');
        });
      }
    });
    openApps.push(app);
    const address = await app.app.listen({ port: 0, host: '127.0.0.1' });
    port = Number(new URL(address).port);
  });

  afterAll(async () => {
    await Promise.all(openApps.splice(0).map((opened) => opened.close()));
    await new Promise<void>((resolve) => { upstream.close(() => resolve()); });
  });

  beforeEach(() => {
    mockedCaptureUnexpectedError.mockClear();
  });

  const abandonGet = async (path: string): Promise<void> => {
    await new Promise<void>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 50);
      });
      socket.on('error', () => resolve());
    });
  };

  const logsAfterHandling = async (offset: number): Promise<string> => {
    await waitUntil(() => {
      const text = logs.lines().slice(offset).join('\n');
      return mockedCaptureUnexpectedError.mock.calls.length > 0 || text.includes('"code":"REQUEST_ABORTED"');
    });
    await flushLogs();
    return logs.lines().slice(offset).join('\n');
  };

  it('answers 500 and reaches Sentry when an upstream response is cut with the client connected', async () => {
    const offset = logs.lines().length;
    const response = await app.app.inject({ method: 'GET', url: '/__test/trimmed-upstream' });
    await flushLogs();

    expect(response.statusCode).toBe(500);
    expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe('INTERNAL_ERROR');
    expect(mockedCaptureUnexpectedError).toHaveBeenCalledTimes(1);
    expect(logs.lines().slice(offset).join('\n')).toContain('"level":50');
    expect(logs.lines().slice(offset).join('\n')).not.toContain('"code":"REQUEST_ABORTED"');
  });

  it('answers 500 for an Error("aborted") that carries no ECONNRESET code', async () => {
    const offset = logs.lines().length;
    const response = await app.app.inject({ method: 'GET', url: '/__test/aborted-without-code' });
    await flushLogs();

    expect(response.statusCode).toBe(500);
    expect(ApiErrorResponseSchema.parse(response.json()).error.code).toBe('INTERNAL_ERROR');
    expect(mockedCaptureUnexpectedError).toHaveBeenCalledTimes(1);
    expect(logs.lines().slice(offset).join('\n')).toContain('"level":50');
  });

  it('answers 500 for an Error("aborted") without a code after the client left', async () => {
    const offset = logs.lines().length;
    await abandonGet('/__test/aborted-without-code-after-leave');
    const requestLogs = await logsAfterHandling(offset);

    expect(mockedCaptureUnexpectedError).toHaveBeenCalledTimes(1);
    expect(requestLogs).toContain('"code":"INTERNAL_ERROR"');
    expect(requestLogs).not.toContain('"code":"REQUEST_ABORTED"');
  });
});
