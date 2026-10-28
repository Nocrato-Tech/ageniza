import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import type { GoogleOAuthConfig } from '@ageniza/config/server';

/**
 * A stand-in for Google, installed over `fetch` for the two hosts Better Auth reaches: the token endpoint and the
 * certificates of the id token. It answers the way Google does: a code is single-use and bound to the redirect URI, the
 * client and the PKCE challenge, and the id token is signed (RS256) with a key published at the certificates URL, so what
 * the code under test verifies is a real signature and not a stub. Nothing else on Google's hosts is answered, and any
 * other request goes to the real `fetch` (the app under test is driven through `inject`, which never uses it).
 */
export const TEST_GOOGLE: GoogleOAuthConfig = {
  clientId: 'ageniza-test.apps.googleusercontent.com',
  clientSecret: 'google-test-client-secret-value',
  callbackUrl: 'http://127.0.0.1:5173/api/auth/callback/google'
};

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export interface FakeGoogleIdentity {
  readonly sub: string;
  readonly email: string;
  readonly name?: string;
  /** Google sends a boolean; a test may send what a hostile or broken issuer would. */
  readonly emailVerified?: unknown;
}

export interface FakeGoogleOverrides {
  /** What the id token carries instead of the nonce the request sent. */
  readonly nonce?: string | null;
  readonly audience?: string;
  readonly issuer?: string;
  readonly expiresInSeconds?: number;
  /** Sign with a key that is not the one published. */
  readonly signWithOtherKey?: boolean;
}

interface IssuedCode {
  readonly identity: FakeGoogleIdentity;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string | null;
  readonly overrides: FakeGoogleOverrides;
}

export interface FakeGoogleTokenRequest {
  readonly grantType: string | null;
  readonly clientId: string | null;
  readonly clientSecret: string | null;
  readonly redirectUri: string | null;
  readonly codeVerifier: string | null;
}

const base64Url = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

export interface FakeGoogle {
  /** The parameters the browser was sent to Google with. */
  parseAuthorization(location: string): URLSearchParams;
  /** Google's side of the consent: issues a code for the identity and returns the query Google sends back to the callback. */
  authorize(location: string, identity: FakeGoogleIdentity, overrides?: FakeGoogleOverrides): { readonly code: string; readonly state: string };
  readonly tokenRequests: FakeGoogleTokenRequest[];
  readonly calls: { token: number; certs: number; other: string[] };
  restore(): void;
}

export const installFakeGoogle = (config: GoogleOAuthConfig = TEST_GOOGLE): FakeGoogle => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fake-google-key';
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, IssuedCode>();
  const tokenRequests: FakeGoogleTokenRequest[] = [];
  const calls = { token: 0, certs: 0, other: [] as string[] };
  const realFetch = globalThis.fetch;

  const signIdToken = (claims: Record<string, unknown>, withOtherKey: boolean): string => {
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const payload = base64Url(JSON.stringify(claims));
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(withOtherKey ? otherKey.privateKey : key.privateKey);
    return `${header}.${payload}.${base64Url(signature)}`;
  };

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const answerToken = async (init: RequestInit | undefined): Promise<Response> => {
    calls.token += 1;
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '');
    const request: FakeGoogleTokenRequest = {
      grantType: form.get('grant_type'),
      clientId: form.get('client_id'),
      clientSecret: form.get('client_secret'),
      redirectUri: form.get('redirect_uri'),
      codeVerifier: form.get('code_verifier')
    };
    tokenRequests.push(request);

    const code = form.get('code');
    const issued = code === null ? undefined : codes.get(code);
    if (code !== null) codes.delete(code);
    const verifierMatches = request.codeVerifier !== null && issued !== undefined
      && createHash('sha256').update(request.codeVerifier).digest('base64url') === issued.codeChallenge;
    if (request.clientId !== config.clientId || request.clientSecret !== config.clientSecret) return json(401, { error: 'invalid_client' });
    if (request.grantType !== 'authorization_code' || issued === undefined || request.redirectUri !== issued.redirectUri || !verifierMatches) {
      return json(400, { error: 'invalid_grant' });
    }

    const now = Math.floor(Date.now() / 1_000);
    const { identity, overrides } = issued;
    const claims: Record<string, unknown> = {
      iss: overrides.issuer ?? 'https://accounts.google.com',
      aud: overrides.audience ?? config.clientId,
      azp: config.clientId,
      sub: identity.sub,
      email: identity.email,
      email_verified: identity.emailVerified ?? true,
      name: identity.name ?? 'Pessoa do Google',
      picture: 'https://lh3.googleusercontent.com/a/not-stored',
      iat: now,
      exp: now + (overrides.expiresInSeconds ?? 3_600)
    };
    const nonce = overrides.nonce === undefined ? issued.nonce : overrides.nonce;
    if (nonce !== null) claims.nonce = nonce;

    return json(200, {
      access_token: `fake-access-${randomBytes(6).toString('hex')}`,
      refresh_token: `fake-refresh-${randomBytes(6).toString('hex')}`,
      expires_in: 3_600,
      token_type: 'Bearer',
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      id_token: signIdToken(claims, overrides.signWithOtherKey === true)
    });
  };

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === TOKEN_URL) return answerToken(init);
    if (url === CERTS_URL) {
      calls.certs += 1;
      return json(200, { keys: [jwk] });
    }
    const host = new URL(url, 'http://localhost').hostname;
    if (host.endsWith('google.com') || host.endsWith('googleapis.com')) {
      calls.other.push(url);
      return json(404, { error: 'not_handled_by_the_fake' });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const parseAuthorization = (location: string): URLSearchParams => new URL(location).searchParams;

  return {
    parseAuthorization,
    authorize(location, identity, overrides = {}) {
      const params = parseAuthorization(location);
      const code = `fake-code-${randomBytes(12).toString('hex')}`;
      codes.set(code, {
        identity,
        clientId: params.get('client_id') ?? '',
        redirectUri: params.get('redirect_uri') ?? '',
        codeChallenge: params.get('code_challenge') ?? '',
        nonce: params.get('nonce'),
        overrides
      });
      return { code, state: params.get('state') ?? '' };
    },
    tokenRequests,
    calls,
    restore() { globalThis.fetch = realFetch; }
  };
};

export interface GoogleSignInResult {
  readonly start: Awaited<ReturnType<FastifyInstance['inject']>>;
  readonly callback: Awaited<ReturnType<FastifyInstance['inject']>>;
  readonly location: string;
  /** The cookie header of the browser after the callback: the state is spent, the session is there when it signed in. */
  readonly cookie: string;
}

const cookieHeader = (cookies: ReadonlyArray<{ readonly name: string; readonly value: string }>, previous = ''): string => {
  const jar = new Map<string, string>();
  for (const pair of previous.split('; ').filter(Boolean)) {
    const separator = pair.indexOf('=');
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  for (const cookie of cookies) {
    if (cookie.value === '') jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
};

let browsers = 0;
const nextBrowserAddress = (): string => {
  browsers += 1;
  return `10.77.${Math.floor(browsers / 250) % 250}.${(browsers % 250) + 1}`;
};

/**
 * One whole trip through the browser: start, Google's consent, and the callback, with the cookies the browser would carry.
 * `query` replaces what comes back to the callback (a tampered state, a missing code) without touching the rest.
 */
export const signInWithGoogle = async (
  app: FastifyInstance,
  google: FakeGoogle,
  identity: FakeGoogleIdentity,
  options: {
    readonly overrides?: FakeGoogleOverrides;
    readonly intent?: 'login' | 'reauth';
    readonly remoteAddress?: string;
    readonly cookie?: string;
    readonly query?: (issued: { code: string; state: string }) => Record<string, string | undefined>;
  } = {}
): Promise<GoogleSignInResult> => {
  // A browser of its own for every trip, so the per-address limit of the start route is not what a test exercises by accident.
  const remoteAddress = options.remoteAddress ?? nextBrowserAddress();
  const start = await app.inject({
    method: 'GET',
    url: `/auth/google/start${options.intent === undefined ? '' : `?intent=${options.intent}`}`,
    remoteAddress,
    ...(options.cookie === undefined ? {} : { headers: { cookie: options.cookie } })
  });
  const authorizeUrl = start.headers.location;
  if (start.statusCode !== 302 || typeof authorizeUrl !== 'string') throw new Error(`The start did not redirect: ${start.statusCode} ${start.body}`);
  let cookie = cookieHeader(start.cookies, options.cookie);

  const issued = google.authorize(authorizeUrl, identity, options.overrides);
  const query = options.query === undefined ? { code: issued.code, state: issued.state } : options.query(issued);
  const search = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString();
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/callback/google${search === '' ? '' : `?${search}`}`,
    remoteAddress,
    headers: { cookie }
  });
  cookie = cookieHeader(callback.cookies, cookie);
  return { start, callback, location: String(callback.headers.location ?? ''), cookie };
};
