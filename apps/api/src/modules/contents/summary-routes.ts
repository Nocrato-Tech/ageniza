import { AgencyPathParamsSchema, ContentSummaryResponseSchema } from '@ageniza/contracts';
import { withAuthenticatedUserTransaction } from '@ageniza/database';
import type { FastifyInstance } from 'fastify';

import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeResponse } from '../../plugins/infra/zod.js';
import { clientNotFound, unauthenticated } from './errors.js';
import { CONTENT_READ_PERMISSION } from './policy.js';
import type { ContentModuleDependencies } from './routes.js';
import { loadContentSummary } from './summary-service.js';

const summaryDocs = {
  permission: CONTENT_READ_PERMISSION,
  responseStatus: 200,
  schemas: { params: AgencyPathParamsSchema, response: ContentSummaryResponseSchema }
} satisfies DocumentedRouteConfig;

/** The counters of the agency's Início ("Esperando", "Atrasados", "Aprovados no mês", "Agendados"): read-only, under the permission and the policy that show the calendar. */
export const registerContentSummaryRoute = (app: FastifyInstance, dependencies: ContentModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  app.get('/agencies/:agencyId/contents/summary', {
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(CONTENT_READ_PERMISSION)],
    config: summaryDocs
  }, async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const tenant = request.tenant;
    if (tenant === undefined) throw clientNotFound();

    const data = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      loadContentSummary(transaction, { agencyId: tenant.agencyId, now: dependencies.now?.() }));
    return reply.send(routeResponse(summaryDocs, request, { data }));
  });
};
