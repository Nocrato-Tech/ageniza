import type { FastifyInstance } from 'fastify';

import { HttpError } from '@ageniza/core';

import { mobileAppOriginOf, type MobileAppOrigins } from './mobile-app-origin.js';

export interface OriginProtectionOptions {
  /** The public application URL whose origin is allowed for state-changing requests. */
  appPublicUrl: string;
  /** Deep-link schemes of the native app that may also write; empty (the default) keeps the web origin as the only one. */
  mobileAppOrigins?: MobileAppOrigins;
}

const stateChangingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Installs the one global CSRF/origin check used by the API.
 *
 * The hook is deliberately registered at the application root so it applies to
 * every current and future route. A6 calls this once while building the app.
 *
 * A native app sends no `Origin` of its own: Better Auth's Expo client names itself in `expo-origin`. That header counts
 * only when `Origin` is absent (a browser always sends `Origin` on a write, so it cannot be used to impersonate the app)
 * and only for a scheme the environment listed.
 */
export const registerOriginProtection = (app: FastifyInstance, options: OriginProtectionOptions): void => {
  const expectedOrigin = new URL(options.appPublicUrl).origin;
  const mobileAppOrigins = options.mobileAppOrigins ?? [];

  app.addHook('onRequest', (request, _reply, done) => {
    if (!stateChangingMethods.has(request.method)) {
      done();
      return;
    }

    const origin = request.headers.origin;
    const claimed = origin ?? request.headers['expo-origin'];
    const isApp = typeof claimed === 'string' && mobileAppOriginOf(claimed, mobileAppOrigins) !== undefined;
    if (!isApp && origin !== expectedOrigin) {
      throw new HttpError({
        statusCode: 403,
        code: 'CSRF_REJECTED',
        message: 'Request origin is not allowed'
      });
    }
    done();
  });
};
