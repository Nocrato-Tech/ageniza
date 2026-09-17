import type { FastifyRequest } from 'fastify';

import { HttpError } from '@ageniza/core';
import { createVerifiedUserClaims, type VerifiedUserClaims } from '@ageniza/database';

import type { AuthInstance } from './better-auth.js';
import { toAuthHeaders } from './bridge.js';
import { AUTH_SESSION_MAX_AGE_MS } from './policy.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireSession` once a session has been verified for this request. */
    auth?: {
      readonly userId: string;
      readonly sessionId: string;
      readonly claims: VerifiedUserClaims;
    };
  }
}

export interface SessionGuardDependencies {
  readonly auth: AuthInstance;
}

const unauthenticated = (): HttpError => new HttpError({
  statusCode: 401,
  code: 'UNAUTHENTICATED',
  message: 'Authentication is required.'
});

const sessionExpired = (): HttpError => new HttpError({
  statusCode: 401,
  code: 'SESSION_EXPIRED',
  message: 'Session has expired.'
});

/**
 * Builds the `requireSession` preHandler shared by every module that needs an authenticated
 * request (this slice and the 20B/20C slices that follow it).
 *
 * Enforces the 30-day absolute session lifetime on top of Better Auth's own 7-day inactivity
 * expiry/1-day renewal: a session older than `AUTH_SESSION_MAX_AGE_MS` since `createdAt` is
 * revoked here and rejected, even if Better Auth would still consider it fresh.
 */
export const createRequireSession = (dependencies: SessionGuardDependencies) =>
  async (request: FastifyRequest): Promise<void> => {
    const headers = toAuthHeaders(request);
    const result = await dependencies.auth.api.getSession({ headers });
    if (result === null) throw unauthenticated();

    const { session, user } = result;
    const ageMs = Date.now() - new Date(session.createdAt).getTime();
    if (ageMs > AUTH_SESSION_MAX_AGE_MS) {
      await dependencies.auth.api.revokeSession({ body: { token: session.token }, headers }).catch(() => {
        // Best-effort revocation: the client is rejected either way below.
      });
      throw sessionExpired();
    }

    request.auth = {
      userId: user.id,
      sessionId: session.id,
      claims: createVerifiedUserClaims({ userId: user.id })
    };
  };
