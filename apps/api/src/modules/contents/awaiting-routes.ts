import { AgencyPathParamsSchema, AwaitingClientResponseSchema } from '@ageniza/contracts';
import { withAuthenticatedUserTransaction } from '@ageniza/database';
import type { FastifyInstance } from 'fastify';

import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeResponse } from '../../plugins/infra/zod.js';
import { clientNotFound, unauthenticated } from './errors.js';
import { CONTENT_READ_PERMISSION } from './policy.js';
import type { ContentModuleDependencies } from './routes.js';
import { listAwaitingClient } from './awaiting-service.js';

const awaitingDocs = {
  permission: CONTENT_READ_PERMISSION,
  responseStatus: 200,
  schemas: { params: AgencyPathParamsSchema, response: AwaitingClientResponseSchema }
} satisfies DocumentedRouteConfig;

/** "Parado no cliente" of the agency's Início: the contents that wait for a decision, under the permission and the policy that show the calendar. */
export const registerAwaitingClientRoute = (app: FastifyInstance, dependencies: ContentModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  app.get('/agencies/:agencyId/contents/awaiting-client', {
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(CONTENT_READ_PERMISSION)],
    config: awaitingDocs
  }, async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const tenant = request.tenant;
    if (tenant === undefined) throw clientNotFound();

    const body = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      listAwaitingClient(transaction, { agencyId: tenant.agencyId, now: dependencies.now?.() }));
    return reply.send(routeResponse(awaitingDocs, request, body));
  });
};
