import {
  AgencyClientPathParamsSchema,
  AgencyPathParamsSchema,
  ClientDetailResponseSchema,
  ClientListQuerySchema,
  ClientListResponseSchema,
  ClientSchema,
  CreateClientRequestSchema,
  UpdateClientRequestSchema,
  buildPaginationMetadata,
  resolvePagination,
  type ClientListItem
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { IdentityStorageClient } from '../identity-storage/storage-client.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeResponse } from '../../plugins/infra/zod.js';
import {
  clientFromRow,
  createClient,
  isActiveClientNameConflict,
  listClients,
  loadClient,
  loadClientSummary,
  updateClient
} from './service.js';

export type ClientPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface ClientModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Absent when identity storage is not configured; then every photoUrl is null. */
  readonly identityStorage?: IdentityStorageClient;
  readonly photoUrlExpirySeconds: number;
  /** Injected by the tenancy module so this module never duplicates the agency-access guard. */
  readonly requireAgencyAccess: ClientPreHandler;
  /** Injected by the tenancy module; same named-permission rule the RLS policy enforces. */
  readonly requirePermission: (key: string) => ClientPreHandler;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// specs/clientes.md §6: 20 per page. The route declares only the default; `resolvePagination`
// owns the global ceiling (100) and the offset.
const CLIENT_DEFAULT_PAGE_SIZE = 20;

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });

// One 404 for nonexistent, other-agency and invalid-id clients: the response never confirms which.
const clientNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Client not found.' });

const clientNameInUse = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CLIENT_NAME_IN_USE',
  message: 'Já existe um cliente ativo com este nome.'
});

const clientArchived = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CLIENT_ARCHIVED',
  message: 'Cliente arquivado não pode ser editado.'
});

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

// The agency guard already rejected a missing tenant; this keeps the handler total and indistinct.
const requireTenant = (request: FastifyRequest): { readonly agencyId: string } => {
  const tenant = request.tenant;
  if (tenant === undefined) throw clientNotFound();
  return tenant;
};

/** A malformed `:clientId` is the same 404 as an absent one, never a 400 that confirms the route. */
const clientIdFromRoute = (request: FastifyRequest): string => {
  const value = (request.params as { readonly clientId?: unknown }).clientId;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw clientNotFound();
  return value;
};

export const registerClientModule = (app: FastifyInstance, dependencies: ClientModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  const signPhotoUrl = async (request: FastifyRequest, photoKey: string | null): Promise<string | null> => {
    if (photoKey === null || dependencies.identityStorage === undefined) return null;
    try {
      return await dependencies.identityStorage.presignGetObject({ key: photoKey, expiresInSeconds: dependencies.photoUrlExpirySeconds });
    } catch (error) {
      // A stored key the storage rejects is not worth a 500: the client still loads, photoUrl null.
      request.log.warn({
        error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'CLIENT_PHOTO_URL_FAILED' }
      }, 'Could not sign the client photo URL; returning null');
      return null;
    }
  };

  const authenticated = (docs: DocumentedRouteConfig & { permission: string }) => ({
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(docs.permission)],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  // Declared once per route: the same object is the documentation metadata and the source of the
  // schemas the handler validates with, so a handler cannot drift from what is documented.
  const listDocs = {
    permission: 'cliente.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyPathParamsSchema, query: ClientListQuerySchema, response: ClientListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const createDocs = {
    permission: 'cliente.cadastrar',
    responseStatus: 201,
    schemas: { params: AgencyPathParamsSchema, body: CreateClientRequestSchema, response: ClientSchema }
  } satisfies DocumentedRouteConfig;
  const detailDocs = {
    permission: 'cliente.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, response: ClientDetailResponseSchema }
  } satisfies DocumentedRouteConfig;
  const updateDocs = {
    permission: 'cliente.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, body: UpdateClientRequestSchema, response: ClientSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/agencies/:agencyId/clients', authenticated(listDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = request.tenant;
    if (tenant === undefined) throw clientNotFound();
    const query = parseRequest(listDocs.schemas.query, request.query);
    const pagination = resolvePagination(query, CLIENT_DEFAULT_PAGE_SIZE);

    const page = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      listClients(transaction, tenant.agencyId, {
        status: query.status ?? 'active',
        search: query.search,
        sort: query.sort ?? 'attention',
        includePendingInvitations: tenant.isOwner || tenant.permissions.has('cliente.convidar_usuario')
      }, pagination));

    const data = await Promise.all(page.items.map(async (row): Promise<ClientListItem> => {
      const item: ClientListItem = {
        id: row.id,
        name: row.name,
        photoUrl: await signPhotoUrl(request, row.photo_key),
        instagramHandle: row.instagram_handle,
        status: row.status,
        closingDate: row.closing_date,
        threadsAwaitingAgency: Number(row.threads_awaiting_agency)
      };
      // Omitted, not zeroed, for a caller without `cliente.convidar_usuario` (issue #125).
      return row.pending_invitations === null ? item : { ...item, pendingInvitations: Number(row.pending_invitations) };
    }));

    return reply.send(parseResponse(listDocs.schemas.response, {
      data,
      meta: buildPaginationMetadata(pagination, page.totalItems)
    }));
  });

  app.post('/agencies/:agencyId/clients', authenticated(createDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const body = routeBody(createDocs, request);

    let row;
    try {
      row = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
        createClient(transaction, { agencyId: tenant.agencyId, name: body.name }));
    } catch (error) {
      if (isActiveClientNameConflict(error)) throw clientNameInUse();
      throw error;
    }
    return reply.status(201).send(routeResponse(createDocs, request, clientFromRow(row, null)));
  });

  app.get('/agencies/:agencyId/clients/:clientId', authenticated(detailDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);

    const result = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const row = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (row === undefined) return undefined;
      const summary = await loadClientSummary(transaction, clientId);
      return { row, summary };
    });
    if (result === undefined) throw clientNotFound();

    const photoUrl = await signPhotoUrl(request, result.row.photo_key);
    return reply.send(routeResponse(detailDocs, request, {
      ...clientFromRow(result.row, photoUrl),
      summary: result.summary
    }));
  });

  app.patch('/agencies/:agencyId/clients/:clientId', authenticated(updateDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const body = routeBody(updateDocs, request);

    const outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      let updated;
      try {
        updated = await updateClient(transaction, {
          agencyId: tenant.agencyId,
          clientId,
          actorUserId: auth.userId,
          changes: body
        });
      } catch (error) {
        if (isActiveClientNameConflict(error)) throw clientNameInUse();
        throw error;
      }
      if (updated !== undefined) return { kind: 'updated', row: updated } as const;
      // Zero rows: the client exists in this agency but RLS refused the write -- archived. A row
      // that is not there at all is the same 404 as everywhere else.
      const existing = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      return existing === undefined ? { kind: 'not-found' } as const : { kind: 'archived' } as const;
    });

    if (outcome.kind === 'not-found') throw clientNotFound();
    if (outcome.kind === 'archived') throw clientArchived();
    const photoUrl = await signPhotoUrl(request, outcome.row.photo_key);
    return reply.send(routeResponse(updateDocs, request, clientFromRow(outcome.row, photoUrl)));
  });
};
