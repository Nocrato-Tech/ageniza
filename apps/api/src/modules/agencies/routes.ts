import { AgencyMeResponseSchema, AgencyPathParamsSchema } from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import { parseResponse } from '../../plugins/infra/zod.js';
import { loadAgencyMe } from './service.js';

export type AgencyPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface AgencyModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Injected by the tenancy module so this module never duplicates agency-access guard SQL. */
  readonly requireAgencyAccess: AgencyPreHandler;
}

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });

const agencyNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Agency not found.' });

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

/** Registers `/agencies/:agencyId/me` (issue #180): the effective permissions of one context. */
export const registerAgencyModule = (app: FastifyInstance, dependencies: AgencyModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  // No extra permission: whoever `requireAgencyAccess` lets into the agency may know what they can
  // do in it. The response is a UX input, never an authorization source.
  app.get('/agencies/:agencyId/me', {
    preHandler: [requireSession, dependencies.requireAgencyAccess],
    config: { permission: null, responseStatus: 200, schemas: { params: AgencyPathParamsSchema, response: AgencyMeResponseSchema } }
  }, async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = request.tenant;
    if (tenant === undefined) throw agencyNotFound();

    const result = await withAuthenticatedUserTransaction(
      dependencies.database,
      auth.claims,
      (transaction) => loadAgencyMe(transaction, tenant.agencyId)
    );
    // The guard ran a separate transaction: if the agency was suspended in between, this is a 404
    // indistinct from a nonexistent or inaccessible one.
    if (result === undefined) throw agencyNotFound();
    return reply.send(parseResponse(AgencyMeResponseSchema, result));
  });
};
