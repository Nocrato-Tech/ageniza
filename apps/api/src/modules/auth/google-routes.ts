import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import {
  AuthGoogleCallbackQuerySchema,
  AuthGoogleStartQuerySchema,
  AuthProvidersResponseSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';

import { GOOGLE_NONCE_KEY } from './google.js';
import { applyAuthCookies, toAuthHeaders, toPublicAuthError } from './bridge.js';
import type { AuthInstance } from './better-auth.js';
import { perIpRateLimit } from './per-ip-rate-limit.js';
import { AUTH_RATE_LIMITS } from './policy.js';
import { mobileAppRedirectOf } from '../../plugins/infra/mobile-app-origin.js';
import { noStore } from '../../plugins/infra/no-store.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeQuery, routeResponse } from '../../plugins/infra/zod.js';

export interface GoogleRoutesDependencies {
  readonly auth: AuthInstance;
  /** Absent when Google sign-in is not configured: the routes then answer 404 and `GET /auth/providers` says so. */
  readonly google?: { readonly appPublicUrl: string; readonly mobileAppOrigins: readonly string[] };
}

const providersDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { response: AuthProvidersResponseSchema }
} satisfies DocumentedRouteConfig;
const startDocs = {
  permission: null,
  responseStatus: 302,
  schemas: { query: AuthGoogleStartQuerySchema }
} satisfies DocumentedRouteConfig;
const callbackDocs = {
  permission: null,
  responseStatus: 302,
  schemas: { query: AuthGoogleCallbackQuerySchema }
} satisfies DocumentedRouteConfig;

const notFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Resource not found.' });

/** The screen every refusal ends on, whatever the reason: it shows the same message as a wrong password. */
const FAILURE_PATH = '/entrar?erro=google';
const LANDING_PATH = '/entrar/google';

/**
 * The browser-facing half of "Entrar com o Google" (issue #707): `start` sends the browser to Google, `callback` is where
 * Google sends it back. Both are plain navigations, so they answer with redirects, and every failure of the callback
 * lands on the same screen with the same message: the redirect never says why (an address Google did not verify, an
 * account that is not the one linked to that subject, a bad state), so nothing here tells whether an address has an account.
 */
export const registerGoogleRoutes = (app: FastifyInstance, dependencies: GoogleRoutesDependencies): void => {
  const { auth, google } = dependencies;

  app.get('/auth/providers', { config: providersDocs }, async (request) =>
    routeResponse(providersDocs, request, { google: google !== undefined }));

  app.get('/auth/google/start', { ...perIpRateLimit(AUTH_RATE_LIMITS.google.ip, startDocs), onRequest: noStore }, async (request, reply) => {
    if (google === undefined) throw notFound();
    const query = routeQuery(startDocs, request);
    const reauth = query.intent === 'reauth';
    // The flow began in the app: it comes back to the deep link it named, and only to a scheme the environment listed.
    const appRedirect = query.appRedirect === undefined ? undefined : mobileAppRedirectOf(query.appRedirect, google.mobileAppOrigins);
    if (query.appRedirect !== undefined && appRedirect === undefined) {
      throw new HttpError({ statusCode: 400, code: 'VALIDATION_ERROR', message: 'Request validation failed' });
    }
    // Bound to this flow through the state record, and sent to Google as the `nonce` the id token must come back with.
    const nonce = randomBytes(32).toString('base64url');

    let started;
    try {
      started = await auth.api.signInSocial({
        body: {
          provider: 'google',
          callbackURL: appRedirect?.toString() ?? `${google.appPublicUrl}${LANDING_PATH}${reauth ? '?intent=reauth' : ''}`,
          errorCallbackURL: appRedirect?.toString() ?? `${google.appPublicUrl}${FAILURE_PATH}`,
          disableRedirect: true,
          // Authenticating again is what "recent" means for the account that has no password.
          ...(reauth ? { additionalParams: { prompt: 'login' } } : {}),
          additionalData: { [GOOGLE_NONCE_KEY]: nonce }
        },
        headers: toAuthHeaders(request),
        returnHeaders: true
      });
    } catch (error) {
      throw toPublicAuthError(error, { statusCode: 500, code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' });
    }
    if (started.response.url === undefined) throw new Error('Better Auth returned no authorization URL.');

    // `nonce` is reserved in Better Auth's own parameters, so it is added here, to the URL it built.
    const url = new URL(started.response.url);
    url.searchParams.set('nonce', nonce);
    applyAuthCookies(reply, started.headers);
    return reply.redirect(url.toString(), 302);
  });

  app.get('/auth/callback/google', { ...perIpRateLimit(AUTH_RATE_LIMITS.google.ip, callbackDocs), onRequest: noStore }, async (request, reply) => {
    if (google === undefined) throw notFound();
    const query = routeQuery(callbackDocs, request);

    let outcome: Response;
    try {
      outcome = await auth.api.callbackOAuth({
        params: { id: 'google' },
        query,
        headers: toAuthHeaders(request),
        asResponse: true
      });
    } catch (error) {
      request.log.warn({ operation: 'auth.google_callback', status: 'failed', error: { name: error instanceof Error ? error.name : 'UnknownError' } }, 'Google callback failed');
      return reply.redirect(`${google.appPublicUrl}${FAILURE_PATH}`, 302);
    }

    applyAuthCookies(reply, outcome.headers);
    const location = outcome.headers.get('location');
    let landed = false;
    const appTarget = location === null ? undefined : mobileAppRedirectOf(location, google.mobileAppOrigins);
    if (location !== null && appTarget !== undefined) {
      // The deep link carries the session in `cookie` (the Expo plugin puts it there); a refusal carries nothing and,
      // like the web, never says why.
      if (appTarget.searchParams.has('error')) {
        appTarget.search = '?erro=google';
        return reply.redirect(appTarget.toString(), 302);
      }
      return reply.redirect(location, 302);
    }
    if (location !== null) {
      try {
        const target = new URL(location, google.appPublicUrl);
        landed = target.origin === new URL(google.appPublicUrl).origin && target.pathname === LANDING_PATH && !target.searchParams.has('error');
      } catch {
        landed = false;
      }
    }
    return reply.redirect(landed && location !== null ? location : `${google.appPublicUrl}${FAILURE_PATH}`, 302);
  });
};
