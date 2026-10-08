import {
  AgencyClientMemberPathParamsSchema,
  AgencyClientPathParamsSchema,
  ClientInvitationListQuerySchema,
  ClientInvitationListResponseSchema,
  ClientMemberListQuerySchema,
  ClientMemberListResponseSchema,
  ClientMemberSchema,
  buildPaginationMetadata,
  resolvePagination,
  type ClientMemberStatus
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { revokeUserSessions } from '../auth/session-revocation.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import {
  clientMemberFromRow,
  isMembershipFunctionRefusal,
  listClientMembers,
  listPendingClientInvitations,
  loadClientMember,
  setClientMemberStatus
} from './access-service.js';
import { CLIENT_INVITATION_DEFAULT_PAGE_SIZE, CLIENT_MEMBER_DEFAULT_PAGE_SIZE } from './policy.js';
import { loadClient } from './service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface AccessRouteDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly requireAgencyAccess: PreHandler;
  readonly requirePermission: (key: string) => PreHandler;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const clientNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Client not found.' });
const memberNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Member not found.' });
const forbidden = (): HttpError => new HttpError({ statusCode: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
const clientArchived = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CLIENT_ARCHIVED',
  message: 'Cliente arquivado: o acesso ao portal não pode ser alterado.'
});

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  return auth;
};

const requireTenant = (request: FastifyRequest): NonNullable<FastifyRequest['tenant']> => {
  const tenant = request.tenant;
  if (tenant === undefined) throw clientNotFound();
  return tenant;
};

/** A malformed id is the same 404 as an absent one, never a 400 that confirms the route exists. */
const uuidFromRoute = (request: FastifyRequest, name: string, notFound: () => HttpError): string => {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw notFound();
  return value;
};

/**
 * The agency's side of a client's portal access (#132): who has access, who lost it, and what is
 * still pending. Reading uses `cliente.convidar_usuario`, removing and reactivating use
 * `cliente.remover_usuario`; both are checked by the guard and again by the database. Resending and
 * canceling an invitation are the routes of the invitations module and do not change here.
 */
export const registerAccessRoutes = (app: FastifyInstance, dependencies: AccessRouteDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  const authenticated = (docs: DocumentedRouteConfig & { permission: string }) => ({
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(docs.permission)],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  const listMembersDocs = {
    permission: 'cliente.convidar_usuario',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, query: ClientMemberListQuerySchema, response: ClientMemberListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const removeMemberDocs = {
    permission: 'cliente.remover_usuario',
    responseStatus: 200,
    schemas: { params: AgencyClientMemberPathParamsSchema, response: ClientMemberSchema }
  } satisfies DocumentedRouteConfig;
  const reactivateMemberDocs = {
    permission: 'cliente.remover_usuario',
    responseStatus: 200,
    schemas: { params: AgencyClientMemberPathParamsSchema, response: ClientMemberSchema }
  } satisfies DocumentedRouteConfig;
  const listInvitationsDocs = {
    permission: 'cliente.convidar_usuario',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, query: ClientInvitationListQuerySchema, response: ClientInvitationListResponseSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/agencies/:agencyId/clients/:clientId/members', authenticated(listMembersDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = uuidFromRoute(request, 'clientId', clientNotFound);
    const query = routeQuery(listMembersDocs, request);
    const pagination = resolvePagination(query, CLIENT_MEMBER_DEFAULT_PAGE_SIZE);
    const scope = { agencyId: tenant.agencyId, clientId };

    // An archived client is read-only, not unreadable: only a missing client stops a read.
    const page = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      if (await loadClient(transaction, scope) === undefined) return undefined;
      return listClientMembers(transaction, scope, { status: query.status ?? 'active' }, pagination);
    });
    if (page === undefined) throw clientNotFound();

    return reply.send(routeResponse(listMembersDocs, request, {
      data: page.items.map(clientMemberFromRow),
      meta: buildPaginationMetadata(pagination, page.totalItems)
    }));
  });

  app.get('/agencies/:agencyId/clients/:clientId/invitations', authenticated(listInvitationsDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = uuidFromRoute(request, 'clientId', clientNotFound);
    const query = routeQuery(listInvitationsDocs, request);
    const pagination = resolvePagination(query, CLIENT_INVITATION_DEFAULT_PAGE_SIZE);
    const scope = { agencyId: tenant.agencyId, clientId };

    const page = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      if (await loadClient(transaction, scope) === undefined) return undefined;
      return listPendingClientInvitations(transaction, scope, pagination);
    });
    if (page === undefined) throw clientNotFound();

    return reply.send(routeResponse(listInvitationsDocs, request, {
      data: page.items.map((row) => ({ invitationId: row.id, email: row.email, expiresAt: new Date(row.expires_at).toISOString() })),
      meta: buildPaginationMetadata(pagination, page.totalItems)
    }));
  });

  /**
   * Why the function refused a change the checks before it let through: the client was archived or
   * the link vanished in between, or the caller lost the permission. Read back in a fresh
   * transaction, because the one that was refused is aborted.
   */
  const diagnoseRefusal = async (
    request: FastifyRequest,
    scope: { readonly agencyId: string; readonly clientId: string; readonly membershipId: string }
  ): Promise<HttpError> => withAuthenticatedUserTransaction(dependencies.database, requireAuth(request).claims, async (transaction) => {
    const client = await loadClient(transaction, scope);
    if (client === undefined) return clientNotFound();
    if (client.status === 'archived') return clientArchived();
    if (await loadClientMember(transaction, scope) === undefined) return memberNotFound();
    return forbidden();
  });

  const memberStatusHandler = (docs: typeof removeMemberDocs, status: ClientMemberStatus) => async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = uuidFromRoute(request, 'clientId', clientNotFound);
    const membershipId = uuidFromRoute(request, 'membershipId', memberNotFound);
    const scope = { agencyId: tenant.agencyId, clientId, membershipId };

    let outcome;
    try {
      outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
        const client = await loadClient(transaction, scope);
        if (client === undefined) return { kind: 'client-not-found' } as const;
        if (client.status === 'archived') return { kind: 'client-archived' } as const;
        const current = await loadClientMember(transaction, scope);
        if (current === undefined) return { kind: 'member-not-found' } as const;
        await setClientMemberStatus(transaction, membershipId, status);
        // Only the transition ends sessions: removing again, or bringing the person back, changes none.
        if (status === 'removed' && current.status === 'active') await revokeUserSessions(transaction, current.user_id, auth.sessionId);
        const member = await loadClientMember(transaction, scope);
        if (member === undefined) throw new Error('The member whose access just changed could not be read back.');
        return { kind: 'ok', member } as const;
      });
    } catch (error) {
      if (!isMembershipFunctionRefusal(error)) throw error;
      throw await diagnoseRefusal(request, scope);
    }

    if (outcome.kind === 'client-not-found') throw clientNotFound();
    if (outcome.kind === 'client-archived') throw clientArchived();
    if (outcome.kind === 'member-not-found') throw memberNotFound();
    return reply.send(routeResponse(docs, request, clientMemberFromRow(outcome.member)));
  };

  app.post('/agencies/:agencyId/clients/:clientId/members/:membershipId/remove', authenticated(removeMemberDocs), memberStatusHandler(removeMemberDocs, 'removed'));
  app.post('/agencies/:agencyId/clients/:clientId/members/:membershipId/reactivate', authenticated(reactivateMemberDocs), memberStatusHandler(reactivateMemberDocs, 'active'));
};
