import {
  AgencyClientInvitationPathParamsSchema,
  AgencyClientMemberPathParamsSchema,
  AgencyClientPathParamsSchema,
  ClientInvitationListQuerySchema,
  ClientInvitationListResponseSchema,
  ClientMemberAddRequestSchema,
  ClientMemberListQuerySchema,
  ClientMemberListResponseSchema,
  ClientMemberSchema,
  buildPaginationMetadata,
  resolvePagination,
  type ClientMemberStatus
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { isRetryableConflict, raw, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { tryAgain } from '../../plugins/infra/conflict.js';
import type { AuthInstance } from '../auth/better-auth.js';
import type { EmailService } from '../auth/email-service.js';
import { revokeUserSessions } from '../auth/session-revocation.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import {
  addClientMember,
  clientInvitationExists,
  clientMemberFromRow,
  convertClientInvitation,
  isAccessFunctionRefusal,
  isNothingToResend,
  isResendTooSoon,
  listClientMembers,
  listPendingClientInvitations,
  loadClientMember,
  resendClientMemberEmail,
  setClientMemberStatus
} from './access-service.js';
import { CLIENT_INVITATION_DEFAULT_PAGE_SIZE, CLIENT_MEMBER_DEFAULT_PAGE_SIZE } from './policy.js';
import { loadClient } from './service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface AccessRouteDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** The welcome e-mail of "Adicionar pessoa". */
  readonly emailService: EmailService;
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
const accessExists = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'ACCESS_EXISTS',
  message: 'Este endereço já tem acesso ao portal deste cliente.'
});
const invitationNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Invitation not found.' });
const accessNotPending = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'ACCESS_NOT_PENDING',
  message: 'Esta pessoa já entrou no portal ou já não tem acesso: não há e-mail para reenviar.'
});
const invitationNotPending = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'INVITATION_NOT_PENDING',
  message: 'O convite não está pendente.'
});
const resendTooSoon = (): HttpError => new HttpError({
  statusCode: 429,
  code: 'RESEND_TOO_SOON',
  message: 'Aguarde um minuto para reenviar o e-mail desta pessoa de novo.'
});
const emailDeliveryFailed = (): HttpError => new HttpError({
  statusCode: 502,
  code: 'EMAIL_DELIVERY_FAILED',
  message: 'Não foi possível entregar o e-mail.'
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
 * The agency's side of a client's portal access (#132, #711): who has access, who lost it, who is added, and what is still
 * pending of the old invitations. Reading and adding use `cliente.convidar_usuario`, removing and reactivating use
 * `cliente.remover_usuario`; both are checked by the guard and again by the functions of the database. A person is an access
 * given to an e-mail address, so every route here names the access, never an account.
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
  const addMemberDocs = {
    permission: 'cliente.convidar_usuario',
    responseStatus: 201,
    schemas: { params: AgencyClientPathParamsSchema, body: ClientMemberAddRequestSchema, response: ClientMemberSchema }
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
  const resendMemberDocs = {
    permission: 'cliente.convidar_usuario',
    responseStatus: 200,
    schemas: { params: AgencyClientMemberPathParamsSchema, response: ClientMemberSchema }
  } satisfies DocumentedRouteConfig;
  const resendInvitationDocs = {
    permission: 'cliente.convidar_usuario',
    responseStatus: 200,
    schemas: { params: AgencyClientInvitationPathParamsSchema, response: ClientMemberSchema }
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
   * Why a function of the access refused a change the checks before it let through: the client was archived or the access
   * vanished in between, or the caller lost the permission. Read back in a fresh transaction, because the one that was
   * refused is aborted. `accessId` is absent when the change was an addition. Whoever lost the permission can no longer read
   * the access either, so the permission is asked before the access is looked for. `invitationId` is present when the change
   * was the conversion of an old invitation.
   */
  const diagnoseRefusal = async (
    request: FastifyRequest,
    scope: { readonly agencyId: string; readonly clientId: string; readonly accessId?: string; readonly invitationId?: string },
    permission: string
  ): Promise<HttpError> => withAuthenticatedUserTransaction(dependencies.database, requireAuth(request).claims, async (transaction) => {
    const client = await loadClient(transaction, scope);
    if (client === undefined) return clientNotFound();
    if (client.status === 'archived') return clientArchived();
    const held = await raw<{ readonly rows: readonly { readonly held: boolean }[] }>(
      transaction,
      'select app_private.has_agency_permission(?::uuid, ?) as held',
      [scope.agencyId, permission]
    );
    if (held.rows[0]?.held !== true) return forbidden();
    if (scope.accessId !== undefined && await loadClientMember(transaction, { ...scope, accessId: scope.accessId }) === undefined) return memberNotFound();
    if (scope.invitationId !== undefined && !await clientInvitationExists(transaction, { ...scope, invitationId: scope.invitationId })) return invitationNotFound();
    return forbidden();
  });

  app.post('/agencies/:agencyId/clients/:clientId/members', authenticated(addMemberDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = uuidFromRoute(request, 'clientId', clientNotFound);
    const body = routeBody(addMemberDocs, request);
    const scope = { agencyId: tenant.agencyId, clientId };

    let outcome;
    try {
      outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
        const client = await loadClient(transaction, scope);
        if (client === undefined) return { kind: 'client-not-found' } as const;
        if (client.status === 'archived') return { kind: 'client-archived' } as const;

        // The database counts the welcome e-mail in the daily limit of the agency (A0095, 429) and refuses a read-only agency
        // (A0090, 409); both reach the error handler as they are.
        const added = await addClientMember(transaction, clientId, body.email);

        // The address changed hands and the account that held it lost the access: that is a removal for it, and ends its sessions.
        if (added.unlinkedUserId !== null) await revokeUserSessions(transaction, added.unlinkedUserId, auth.sessionId);

        const member = await loadClientMember(transaction, { ...scope, accessId: added.accessId });
        if (member === undefined) throw new Error('The access just added could not be read back.');
        const agency = await raw<{ readonly rows: readonly { readonly name: string }[] }>(
          transaction,
          'select name from public.agencies where id = ?::uuid',
          [scope.agencyId]
        );
        return { kind: 'ok', added, member, clientName: client.name, agencyName: agency.rows[0]?.name ?? '' } as const;
      });
    } catch (error) {
      if (isRetryableConflict(error)) throw tryAgain();
      if (!isAccessFunctionRefusal(error)) throw error;
      throw await diagnoseRefusal(request, scope, addMemberDocs.permission);
    }

    if (outcome.kind === 'client-not-found') throw clientNotFound();
    if (outcome.kind === 'client-archived') throw clientArchived();
    if (outcome.added.outcome === 'already_active') throw accessExists();

    // The access is given and committed; the e-mail tells the person. A refused delivery is told to the agency, which can
    // remove the access and add the address again.
    try {
      await dependencies.emailService.sendClientPortalWelcome({
        to: outcome.member.email,
        agencyName: outcome.agencyName,
        clientName: outcome.clientName
      });
    } catch {
      throw emailDeliveryFailed();
    }
    return reply.status(201).send(routeResponse(addMemberDocs, request, clientMemberFromRow(outcome.member)));
  });

  // The access is committed; the e-mail tells the person. A refused delivery is told to the agency, which resends it from the
  // row of the person.
  const sendWelcome = async (outcome: { readonly member: { readonly email: string }; readonly agencyName: string; readonly clientName: string }): Promise<void> => {
    try {
      await dependencies.emailService.sendClientPortalWelcome({
        to: outcome.member.email,
        agencyName: outcome.agencyName,
        clientName: outcome.clientName
      });
    } catch {
      throw emailDeliveryFailed();
    }
  };

  const agencyNameOf = async (transaction: Parameters<typeof loadClient>[0], agencyId: string): Promise<string> => {
    const agency = await raw<{ readonly rows: readonly { readonly name: string }[] }>(
      transaction,
      'select name from public.agencies where id = ?::uuid',
      [agencyId]
    );
    return agency.rows[0]?.name ?? '';
  };

  app.post('/agencies/:agencyId/clients/:clientId/members/:accessId/resend', authenticated(resendMemberDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = uuidFromRoute(request, 'clientId', clientNotFound);
    const accessId = uuidFromRoute(request, 'accessId', memberNotFound);
    const scope = { agencyId: tenant.agencyId, clientId, accessId };

    let outcome;
    try {
      outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
        const client = await loadClient(transaction, scope);
        if (client === undefined) return { kind: 'client-not-found' } as const;
        if (client.status === 'archived') return { kind: 'client-archived' } as const;
        if (await loadClientMember(transaction, scope) === undefined) return { kind: 'member-not-found' } as const;

        // The database counts the e-mail in the daily limit (A0095, 429), refuses a read-only agency (A0090, 409), an access that
        // was removed or whose person entered (A0097) and the second e-mail of the same minute (A0099).
        await resendClientMemberEmail(transaction, accessId);

        const member = await loadClientMember(transaction, scope);
        if (member === undefined) throw new Error('The access just resent could not be read back.');
        return { kind: 'ok', member, clientName: client.name, agencyName: await agencyNameOf(transaction, scope.agencyId) } as const;
      });
    } catch (error) {
      if (isRetryableConflict(error)) throw tryAgain();
      if (isNothingToResend(error)) throw accessNotPending();
      if (isResendTooSoon(error)) throw resendTooSoon();
      if (!isAccessFunctionRefusal(error)) throw error;
      throw await diagnoseRefusal(request, scope, resendMemberDocs.permission);
    }

    if (outcome.kind === 'client-not-found') throw clientNotFound();
    if (outcome.kind === 'client-archived') throw clientArchived();
    if (outcome.kind === 'member-not-found') throw memberNotFound();
    await sendWelcome(outcome);
    return reply.send(routeResponse(resendMemberDocs, request, clientMemberFromRow(outcome.member)));
  });

  app.post('/agencies/:agencyId/clients/:clientId/invitations/:invitationId/resend', authenticated(resendInvitationDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = uuidFromRoute(request, 'clientId', clientNotFound);
    const invitationId = uuidFromRoute(request, 'invitationId', invitationNotFound);
    const scope = { agencyId: tenant.agencyId, clientId };

    let outcome;
    try {
      outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
        const client = await loadClient(transaction, scope);
        if (client === undefined) return { kind: 'client-not-found' } as const;
        if (client.status === 'archived') return { kind: 'client-archived' } as const;

        // The effects of "Adicionar pessoa" for the address of the invitation, and the revocation of the invitation, in this
        // transaction: if anything fails, the invitation is still pending.
        const converted = await convertClientInvitation(transaction, clientId, invitationId);
        if (converted.unlinkedUserId !== null) await revokeUserSessions(transaction, converted.unlinkedUserId, auth.sessionId);

        const member = await loadClientMember(transaction, { ...scope, accessId: converted.accessId });
        if (member === undefined) throw new Error('The access just given could not be read back.');
        return { kind: 'ok', converted, member, clientName: client.name, agencyName: await agencyNameOf(transaction, scope.agencyId) } as const;
      });
    } catch (error) {
      if (isRetryableConflict(error)) throw tryAgain();
      if (isNothingToResend(error)) throw invitationNotPending();
      if (!isAccessFunctionRefusal(error)) throw error;
      throw await diagnoseRefusal(request, { ...scope, invitationId }, resendInvitationDocs.permission);
    }

    if (outcome.kind === 'client-not-found') throw clientNotFound();
    if (outcome.kind === 'client-archived') throw clientArchived();
    if (!outcome.converted.invitationRevoked) throw accessExists();
    await sendWelcome(outcome);
    return reply.send(routeResponse(resendInvitationDocs, request, clientMemberFromRow(outcome.member)));
  });

  const memberStatusHandler = (docs: typeof removeMemberDocs, status: ClientMemberStatus) => async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = uuidFromRoute(request, 'clientId', clientNotFound);
    const accessId = uuidFromRoute(request, 'accessId', memberNotFound);
    const scope = { agencyId: tenant.agencyId, clientId, accessId };

    let outcome;
    try {
      outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
        const client = await loadClient(transaction, scope);
        if (client === undefined) return { kind: 'client-not-found' } as const;
        if (client.status === 'archived') return { kind: 'client-archived' } as const;
        if (await loadClientMember(transaction, scope) === undefined) return { kind: 'member-not-found' } as const;
        const result = await setClientMemberStatus(transaction, accessId, status);
        const member = await loadClientMember(transaction, scope);
        if (member === undefined) throw new Error('The access whose state just changed could not be read back.');
        // Only the transition ends sessions, and it is the function that says whether it wrote: it locks the access and
        // decides, so a reading made before it (a reactivation may land in between) would leave a removed access with live
        // sessions. Removing again, bringing the person back, or removing an access nobody has entered writes nothing that
        // ends them.
        if (status === 'removed' && result.changed && result.accountUserId !== null) {
          await revokeUserSessions(transaction, result.accountUserId, auth.sessionId);
        }
        return { kind: 'ok', member } as const;
      });
    } catch (error) {
      if (isRetryableConflict(error)) throw tryAgain();
      if (!isAccessFunctionRefusal(error)) throw error;
      throw await diagnoseRefusal(request, scope, docs.permission);
    }

    if (outcome.kind === 'client-not-found') throw clientNotFound();
    if (outcome.kind === 'client-archived') throw clientArchived();
    if (outcome.kind === 'member-not-found') throw memberNotFound();
    return reply.send(routeResponse(docs, request, clientMemberFromRow(outcome.member)));
  };

  app.post('/agencies/:agencyId/clients/:clientId/members/:accessId/remove', authenticated(removeMemberDocs), memberStatusHandler(removeMemberDocs, 'removed'));
  app.post('/agencies/:agencyId/clients/:clientId/members/:accessId/reactivate', authenticated(reactivateMemberDocs), memberStatusHandler(reactivateMemberDocs, 'active'));
};
