import { AgencyMeResponseSchema, AgencyPathParamsSchema, CreateAgencyRequestSchema, CreateAgencyResponseSchema } from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeResponse } from '../../plugins/infra/zod.js';
import { createTrialAgency, loadAgencyMe } from './service.js';

export type AgencyPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface AgencyModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Injected by the tenancy module so this module never duplicates agency-access guard SQL. */
  readonly requireAgencyAccess: AgencyPreHandler;
  /** `SUPPORT_CONTACT_EMAIL`: the public contact the plan notice shows; absent, the notice names none. */
  readonly supportContactEmail?: string;
}

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });

const agencyNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Agency not found.' });

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

/** Registers `/agencies/:agencyId/me` (issue #180): the effective permissions of one context. */
// Declared once: the same object is the route's documentation metadata and the source of the
// schema the handler validates the response with.
const agencyMeDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { params: AgencyPathParamsSchema, response: AgencyMeResponseSchema }
} satisfies DocumentedRouteConfig;

const createAgencyDocs = {
  permission: null,
  responseStatus: 201,
  schemas: { body: CreateAgencyRequestSchema, response: CreateAgencyResponseSchema }
} satisfies DocumentedRouteConfig;

export const registerAgencyModule = (app: FastifyInstance, dependencies: AgencyModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  // Any signed-in account may ask; the database decides (verified e-mail, one trial per account) and makes the actor
  // Owner, so nothing from the body is trusted but the name.
  app.post('/agencies', { preHandler: requireSession, config: createAgencyDocs }, async (request, reply) => {
    const auth = requireAuth(request);
    const body = routeBody(createAgencyDocs, request);
    const context = await withAuthenticatedUserTransaction(
      dependencies.database,
      auth.claims,
      (transaction) => createTrialAgency(transaction, body.name)
    );
    return reply.status(201).send(routeResponse(createAgencyDocs, request, { context }));
  });

  // No extra permission: whoever `requireAgencyAccess` lets into the agency may know what they can
  // do in it. The response is a UX input, never an authorization source.
  app.get('/agencies/:agencyId/me', {
    preHandler: [requireSession, dependencies.requireAgencyAccess],
    config: agencyMeDocs
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
    return reply.send(routeResponse(agencyMeDocs, request, {
      ...result,
      plan: { ...result.plan, supportContactEmail: dependencies.supportContactEmail ?? null }
    }));
  });
};
