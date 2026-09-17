import type { FastifyInstance } from 'fastify';

import { HttpError } from '@ageniza/core';

export interface OriginProtectionOptions {
  /** The public application URL whose origin is allowed for state-changing requests. */
  appPublicUrl: string;
}

const stateChangingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Installs the one global CSRF/origin check used by the API.
 *
 * The hook is deliberately registered at the application root so it applies to
 * every current and future route. A6 calls this once while building the app.
 */
export const registerOriginProtection = (app: FastifyInstance, options: OriginProtectionOptions): void => {
  const expectedOrigin = new URL(options.appPublicUrl).origin;

  app.addHook('onRequest', (request, _reply, done) => {
    if (!stateChangingMethods.has(request.method)) {
      done();
      return;
    }

    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin !== expectedOrigin) {
      throw new HttpError({
        statusCode: 403,
        code: 'CSRF_REJECTED',
        message: 'Request origin is not allowed'
      });
    }
    done();
  });
};
