import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyRequest, FastifyReply } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { isInsufficientPrivilegeError } from '../tenancy/guards.js';
import { clientArchived, forbidden, notFound, translateClientMediaError } from './client-media-errors.js';
import type { ClientScope } from './folder-service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface ClientMediaRouteDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly requireAgencyAccess: PreHandler;
  readonly requirePermission: (key: string) => PreHandler;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  return auth;
};

export const requireTenant = (request: FastifyRequest): NonNullable<FastifyRequest['tenant']> => {
  const tenant = request.tenant;
  if (tenant === undefined) throw notFound('Agency not found.');
  return tenant;
};

/** A malformed id is the same 404 as an absent one, never a 400 that confirms the route exists. */
export const idFromRoute = (request: FastifyRequest, name: string, message: string): string => {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw notFound(message);
  return value;
};

export const requireReadableClient = (scope: ClientScope): void => {
  if (scope === 'not-found') throw notFound('Client not found.');
};

export const requireWritableClient = (scope: ClientScope): void => {
  requireReadableClient(scope);
  if (scope === 'archived') throw clientArchived();
};

/**
 * What the routes of a client's media library share: the guard chain (session, agency access, the permission, and for a write the
 * read of Conteúdo as well, since with `operar` alone the role would write what it cannot read back) and the transaction that answers
 * what the database refuses. A refusal by the row-level security means the route read the client as open and the archive of the
 * client committed before the statement, so a write of the client says which of the two it was (`whenRefusedByRls`); anything else
 * it refuses is the 403.
 */
export const createClientMediaRouteKit = (dependencies: ClientMediaRouteDependencies) => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  const guarded = (docs: DocumentedRouteConfig & { permission: string }, alsoReads = false) => ({
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requirePermission(docs.permission),
      ...(alsoReads ? [dependencies.requirePermission('conteudo.visualizar')] : [])
    ],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  const inTransaction = async <T>(
    request: FastifyRequest,
    work: Parameters<typeof withAuthenticatedUserTransaction<T>>[2],
    whenRefusedByRls?: () => Promise<HttpError>
  ): Promise<T> => {
    try {
      return await withAuthenticatedUserTransaction(dependencies.database, requireAuth(request).claims, work);
    } catch (error) {
      const translated = translateClientMediaError(error);
      if (translated !== undefined) throw translated;
      if (isInsufficientPrivilegeError(error)) throw whenRefusedByRls === undefined ? forbidden() : await whenRefusedByRls();
      throw error;
    }
  };

  return { guarded, inTransaction };
};
