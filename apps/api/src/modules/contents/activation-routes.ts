import { AgencyPathParamsSchema, ContentActivationResponseSchema } from '@ageniza/contracts';
import { withAuthenticatedUserTransaction } from '@ageniza/database';
import type { FastifyInstance } from 'fastify';

import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeResponse } from '../../plugins/infra/zod.js';
import { clientNotFound, unauthenticated } from './errors.js';
import { CONTENT_READ_PERMISSION } from './policy.js';
import type { ContentModuleDependencies } from './routes.js';
import { loadActivation } from './activation-service.js';

const activationDocs = {
  permission: CONTENT_READ_PERMISSION,
  responseStatus: 200,
  schemas: { params: AgencyPathParamsSchema, response: ContentActivationResponseSchema }
} satisfies DocumentedRouteConfig;

/** The facts the agency's Início needs to show the activation path; read-only, under the same policy as the calendar. */
export const registerContentActivationRoute = (app: FastifyInstance, dependencies: ContentModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  app.get('/agencies/:agencyId/contents/activation', {
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(CONTENT_READ_PERMISSION)],
    config: activationDocs
  }, async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const tenant = request.tenant;
    if (tenant === undefined) throw clientNotFound();

    const data = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) => loadActivation(transaction, tenant.agencyId));
    return reply.send(routeResponse(activationDocs, request, { data }));
  });
};
