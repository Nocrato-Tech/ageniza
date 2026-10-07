import {
  AgencyClientPathParamsSchema,
  ClientSchema,
  SetClientClosingRequestSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { isRetryableConflict, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { tryAgain } from '../../plugins/infra/conflict.js';
import { routeBody, routeResponse } from '../../plugins/infra/zod.js';
import type { IdentityStorageClient } from '../identity-storage/storage-client.js';
import {
  archiveClient,
  isClosingDateInThePast,
  isLifecycleFunctionRefusal,
  isReactivationNameConflict,
  reactivateClient,
  setClientClosingDate
} from './lifecycle-service.js';
import { createPhotoUrlSigner } from './photo-url.js';
import { clientFromRow, loadClient, type ClientRow, type ClientTransaction } from './service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface LifecycleRouteDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly identityStorage?: IdentityStorageClient;
  readonly photoUrlExpirySeconds: number;
  readonly requireAgencyAccess: PreHandler;
  readonly requirePermission: (key: string) => PreHandler;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const clientNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Client not found.' });
const forbidden = (): HttpError => new HttpError({ statusCode: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });
const clientArchived = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CLIENT_ARCHIVED',
  message: 'Cliente arquivado: a única ação possível é reativar.'
});
const clientNotArchived = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CLIENT_NOT_ARCHIVED',
  message: 'Este cliente já está ativo.'
});
const closingDateNotSet = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CLOSING_DATE_NOT_SET',
  message: 'Este cliente não tem encerramento agendado.'
});
const reactivationNameInUse = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'CLIENT_NAME_IN_USE',
  message: 'Já existe um cliente ativo com este nome. Renomeie um dos dois antes de reativar.'
});
const closingDateInThePast = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path: 'closingDate', code: 'custom', message: 'closingDate must be today or later.' }] }
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

/** A malformed `:clientId` is the same 404 as an absent one, never a 400 that confirms the route exists. */
const clientIdFromRoute = (request: FastifyRequest): string => {
  const value = (request.params as { readonly clientId?: unknown }).clientId;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw clientNotFound();
  return value;
};

interface LifecycleAction {
  /** The state the client must be in; an error here is answered before the function is called. */
  readonly refuse: (client: ClientRow) => HttpError | undefined;
  readonly act: (transaction: ClientTransaction, clientId: string) => Promise<void>;
  /** What an `app_private` function raises for this action, as the public answer. */
  readonly translate?: (error: unknown) => HttpError | undefined;
  /** Whether an archived client explains a refusal the checks before the function did not see. */
  readonly archivedExplainsRefusal: boolean;
}

/**
 * The agency's side of the end of a contract (#131): schedule, clear, archive and reactivate. The
 * state is read first so the usual refusals are answered without calling the function, and the
 * function checks `cliente.arquivar` again on the client's own agency, because it ignores RLS.
 */
export const registerLifecycleRoutes = (app: FastifyInstance, dependencies: LifecycleRouteDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const signPhotoUrl = createPhotoUrlSigner(dependencies, {
    code: 'CLIENT_PHOTO_URL_FAILED',
    message: 'Could not sign the client photo URL; returning null'
  });

  const authenticated = (docs: DocumentedRouteConfig & { permission: string }) => ({
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(docs.permission)],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  const setClosingDocs = {
    permission: 'cliente.arquivar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, body: SetClientClosingRequestSchema, response: ClientSchema }
  } satisfies DocumentedRouteConfig;
  const clearClosingDocs = {
    permission: 'cliente.arquivar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, response: ClientSchema }
  } satisfies DocumentedRouteConfig;
  const archiveDocs = {
    permission: 'cliente.arquivar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, response: ClientSchema }
  } satisfies DocumentedRouteConfig;
  const reactivateDocs = {
    permission: 'cliente.arquivar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, response: ClientSchema }
  } satisfies DocumentedRouteConfig;

  /**
   * Why the function refused what the checks before it let through: the client vanished, was archived
   * in between, or the caller lost the permission. Read back in a fresh transaction, because the one
   * that was refused is aborted. An archived client is only an explanation where archived is a refusal.
   */
  const diagnoseRefusal = async (
    request: FastifyRequest,
    scope: { readonly agencyId: string; readonly clientId: string },
    archivedExplainsRefusal: boolean
  ): Promise<HttpError> => withAuthenticatedUserTransaction(dependencies.database, requireAuth(request).claims, async (transaction) => {
    const client = await loadClient(transaction, scope);
    if (client === undefined) return clientNotFound();
    if (client.status === 'archived' && archivedExplainsRefusal) return clientArchived();
    return forbidden();
  });

  const perform = async (request: FastifyRequest, action: LifecycleAction): Promise<ClientRow> => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const scope = { agencyId: tenant.agencyId, clientId };

    let outcome;
    try {
      outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
        const client = await loadClient(transaction, scope);
        if (client === undefined) return { refused: clientNotFound() } as const;
        const refusal = action.refuse(client);
        if (refusal !== undefined) return { refused: refusal } as const;
        await action.act(transaction, clientId);
        const changed = await loadClient(transaction, scope);
        if (changed === undefined) throw new Error('The client whose lifecycle just changed could not be read back.');
        return { row: changed } as const;
      });
    } catch (error) {
      // A lost race (deadlock with a concurrent resend of the client's invitation, for instance) is
      // not an error of the caller, nothing was written, and repeating the call is the answer.
      if (isRetryableConflict(error)) throw tryAgain();
      const translated = action.translate?.(error);
      if (translated !== undefined) throw translated;
      if (isLifecycleFunctionRefusal(error)) throw await diagnoseRefusal(request, scope, action.archivedExplainsRefusal);
      throw error;
    }

    if ('refused' in outcome) throw outcome.refused;
    return outcome.row;
  };

  const sendClient = async (
    request: FastifyRequest,
    reply: FastifyReply,
    docs: { readonly schemas: { readonly response: typeof ClientSchema } },
    row: ClientRow
  ) =>
    reply.send(routeResponse(docs, request, clientFromRow(row, await signPhotoUrl(request, row.photo_key))));

  app.put('/agencies/:agencyId/clients/:clientId/closing', authenticated(setClosingDocs), async (request, reply) => {
    const body = routeBody(setClosingDocs, request);
    const row = await perform(request, {
      refuse: (client) => (client.status === 'archived' ? clientArchived() : undefined),
      act: (transaction, clientId) => setClientClosingDate(transaction, clientId, body.closingDate),
      translate: (error) => (isClosingDateInThePast(error) ? closingDateInThePast() : undefined),
      archivedExplainsRefusal: true
    });
    return sendClient(request, reply, setClosingDocs, row);
  });

  app.delete('/agencies/:agencyId/clients/:clientId/closing', authenticated(clearClosingDocs), async (request, reply) => {
    const row = await perform(request, {
      refuse: (client) => {
        if (client.status === 'archived') return clientArchived();
        return client.closing_date === null ? closingDateNotSet() : undefined;
      },
      act: (transaction, clientId) => setClientClosingDate(transaction, clientId, null),
      archivedExplainsRefusal: true
    });
    return sendClient(request, reply, clearClosingDocs, row);
  });

  app.post('/agencies/:agencyId/clients/:clientId/archive', authenticated(archiveDocs), async (request, reply) => {
    const row = await perform(request, {
      refuse: (client) => (client.status === 'archived' ? clientArchived() : undefined),
      act: archiveClient,
      archivedExplainsRefusal: true
    });
    return sendClient(request, reply, archiveDocs, row);
  });

  app.post('/agencies/:agencyId/clients/:clientId/reactivate', authenticated(reactivateDocs), async (request, reply) => {
    const row = await perform(request, {
      refuse: (client) => (client.status === 'active' ? clientNotArchived() : undefined),
      act: reactivateClient,
      translate: (error) => (isReactivationNameConflict(error) ? reactivationNameInUse() : undefined),
      archivedExplainsRefusal: false
    });
    return sendClient(request, reply, reactivateDocs, row);
  });
};
