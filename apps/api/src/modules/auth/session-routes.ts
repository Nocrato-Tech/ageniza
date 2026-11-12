import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  AuthRevokeOtherSessionsRequestSchema,
  AuthRevokeOtherSessionsResponseSchema,
  AuthRevokeSessionRequestSchema,
  AuthSessionListResponseSchema,
  AuthSessionPathParamsSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import type { DatabaseClient } from '@ageniza/database';

import type { AuthInstance } from './better-auth.js';
import { AUTH_RATE_LIMITS, type AuthRateLimitWindow } from './policy.js';
import { revokeUserSessions } from './session-revocation.js';
import { createRequireSession } from './session-guard.js';
import { isSessionId, listActiveSessions, revokeOwnSession } from './sessions.js';
import { noStore } from '../../plugins/infra/no-store.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeParams, routeResponse } from '../../plugins/infra/zod.js';

export interface SessionRoutesDependencies {
  readonly auth: AuthInstance;
  readonly database: DatabaseClient;
}

const listDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { response: AuthSessionListResponseSchema }
} satisfies DocumentedRouteConfig;
const revokeDocs = {
  permission: null,
  responseStatus: 204,
  schemas: { params: AuthSessionPathParamsSchema, body: AuthRevokeSessionRequestSchema }
} satisfies DocumentedRouteConfig;
const revokeOthersDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { body: AuthRevokeOtherSessionsRequestSchema, response: AuthRevokeOtherSessionsResponseSchema }
} satisfies DocumentedRouteConfig;

/** One answer for a session that is another account's, one that does not exist, one that ended and a malformed id. */
const sessionNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'SESSION_NOT_FOUND', message: 'Sessão não encontrada.' });

const useLogout = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'USE_LOGOUT',
  message: 'Esta é a sessão deste aparelho. Para sair dela, use "Sair".'
});

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  if (request.auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  return request.auth;
};

/**
 * The person's own sessions (specs/auth.md section 14): the list, ending one, and ending every one but this. Every query names
 * the account of the session the request holds, never one the request chose, and the guard is the plain one: the account of an
 * invitation that has not confirmed its e-mail opens none of them (decision 2026-10-27). CSRF/origin checking is global.
 */
export const registerSessionRoutes = (app: FastifyInstance, dependencies: SessionRoutesDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  // After `requireSession` (`hook: 'preHandler'`), so the bucket is the account and a refused request counts for nobody.
  const perUser = (limit: AuthRateLimitWindow) => ({
    rateLimit: {
      max: limit.max,
      timeWindow: limit.windowMs,
      hook: 'preHandler' as const,
      keyGenerator: (request: FastifyRequest) => request.auth?.userId ?? request.ip
    }
  });

  app.get('/auth/sessions', {
    onRequest: noStore,
    preHandler: requireSession,
    config: { ...listDocs, ...perUser(AUTH_RATE_LIMITS.sessions.list) }
  }, async (request) => {
    const auth = requireAuth(request);
    const sessions = await listActiveSessions(dependencies.database.knex, auth.userId, auth.sessionId);
    return routeResponse(listDocs, request, { sessions });
  });

  app.delete('/auth/sessions/:sessionId', {
    preHandler: requireSession,
    config: { ...revokeDocs, ...perUser(AUTH_RATE_LIMITS.sessions.revoke) }
  }, async (request, reply) => {
    const auth = requireAuth(request);
    const { sessionId } = routeParams(revokeDocs, request);
    routeBody(revokeDocs, request);
    if (!isSessionId(sessionId)) throw sessionNotFound();

    if (sessionId.toLowerCase() === auth.sessionId) throw useLogout();
    if (!await revokeOwnSession(dependencies.database.knex, auth.userId, auth.sessionId, sessionId)) throw sessionNotFound();
    return reply.status(204).send();
  });

  // 200 with the number, not the 204 the SPEC's table says: the same SPEC asks for the number, and a 204 has no body.
  app.post('/auth/sessions/revoke-others', {
    preHandler: requireSession,
    config: { ...revokeOthersDocs, ...perUser(AUTH_RATE_LIMITS.sessions.revoke) }
  }, async (request) => {
    const auth = requireAuth(request);
    routeBody(revokeOthersDocs, request);
    const revoked = await dependencies.database.transaction((transaction) => revokeUserSessions(transaction, auth.userId, auth.sessionId));
    return routeResponse(revokeOthersDocs, request, { revoked });
  });
};
