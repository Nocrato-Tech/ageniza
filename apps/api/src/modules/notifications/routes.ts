import {
  AgencyNotificationPathParamsSchema,
  AgencyPathParamsSchema,
  NOTIFICATIONS_PAGE_SIZE,
  NotificationListQuerySchema,
  NotificationListResponseSchema,
  NotificationUnreadCountResponseSchema,
  buildPaginationMetadata,
  resolvePagination
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeParams, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import { notificationNotFound, translateDatabaseError } from './errors.js';
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  notificationFromRow,
  type NotificationTransaction
} from './service.js';

export type NotificationPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface NotificationModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Injected from `tenancy`: the link with the agency is all the routes ask for, since the notification is the person's own. */
  readonly requireAgencyAccess: NotificationPreHandler;
}

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
const agencyNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Agency not found.' });

const listDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { params: AgencyPathParamsSchema, query: NotificationListQuerySchema, response: NotificationListResponseSchema }
} satisfies DocumentedRouteConfig;

const unreadCountDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { params: AgencyPathParamsSchema, response: NotificationUnreadCountResponseSchema }
} satisfies DocumentedRouteConfig;

const readDocs = {
  permission: null,
  responseStatus: 204,
  schemas: { params: AgencyNotificationPathParamsSchema }
} satisfies DocumentedRouteConfig;

const readAllDocs = {
  permission: null,
  responseStatus: 204,
  schemas: { params: AgencyPathParamsSchema }
} satisfies DocumentedRouteConfig;

/**
 * Registers the notifications of the person in one agency (specs/notificacoes.md section 6): the list, the count for the bell, and the
 * two ways of marking as read. Every route is guarded by the link with the agency and nothing else, because a notification belongs to the
 * person who receives it and the database decides, at every read, whether it is still theirs (link, and the permission of the subject).
 * No route creates a notification: the events do, inside the database functions that carry them out.
 */
export const registerNotificationsModule = (app: FastifyInstance, dependencies: NotificationModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const preHandler = [requireSession, dependencies.requireAgencyAccess];

  // The agency comes only from the guard, never from the body or the query; the person is the session's.
  const asPerson = async <TResult>(
    request: FastifyRequest,
    work: (transaction: NotificationTransaction, agencyId: string) => Promise<TResult>
  ): Promise<TResult> => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const tenant = request.tenant;
    if (tenant === undefined) throw agencyNotFound();
    try {
      return await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) => work(transaction, tenant.agencyId));
    } catch (error) {
      throw translateDatabaseError(error) ?? error;
    }
  };

  app.get('/agencies/:agencyId/notifications', { preHandler, config: listDocs }, async (request, reply) => {
    const query = routeQuery(listDocs, request);
    const pagination = resolvePagination(query, NOTIFICATIONS_PAGE_SIZE);
    const page = await asPerson(request, (transaction, agencyId) =>
      listNotifications(transaction, agencyId, { unread: query.unread === 'true' }, pagination)
    );
    return reply.send(routeResponse(listDocs, request, {
      data: page.items.map(notificationFromRow),
      meta: buildPaginationMetadata(pagination, page.totalItems)
    }));
  });

  app.get('/agencies/:agencyId/notifications/unread-count', { preHandler, config: unreadCountDocs }, async (request, reply) => {
    const count = await asPerson(request, countUnreadNotifications);
    return reply.send(routeResponse(unreadCountDocs, request, { data: { count } }));
  });

  app.post('/agencies/:agencyId/notifications/:notificationId/read', { preHandler, config: readDocs }, async (request, reply) => {
    const params = routeParams(readDocs, request);
    // Decided by what the function found, never by a read before it: false is the one 404 for another person's notification,
    // another agency's, one no longer readable and one that is not there.
    const found = await asPerson(request, (transaction, agencyId) => markNotificationRead(transaction, agencyId, params.notificationId));
    if (!found) throw notificationNotFound();
    return reply.status(204).send();
  });

  app.post('/agencies/:agencyId/notifications/read-all', { preHandler, config: readAllDocs }, async (request, reply) => {
    await asPerson(request, markAllNotificationsRead);
    return reply.status(204).send();
  });
};
