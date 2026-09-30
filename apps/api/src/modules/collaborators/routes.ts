import {
  AgencyPathParamsSchema,
  CollaboratorListQuerySchema,
  CollaboratorListResponseSchema,
  buildPaginationMetadata,
  resolvePagination,
  type Collaborator
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { IdentityStorageClient } from '../identity-storage/storage-client.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';
import { listCollaborators, type CollaboratorRow } from './service.js';

export type CollaboratorPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface CollaboratorModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Identity storage (issue #100): `auth."user".image` holds a key, never a public address. */
  readonly identityStorage: IdentityStorageClient;
  readonly identityDownloadUrlExpirySeconds: number;
  /** Injected from `tenancy` so this module never duplicates agency-access guard SQL. */
  readonly requireAgencyAccess: CollaboratorPreHandler;
  readonly requirePermission: (key: string) => CollaboratorPreHandler;
}

// specs/colaboradores.md §6: 24 per page. The route declares only the default; `resolvePagination`
// owns the global ceiling (100) and the offset.
const COLLABORATOR_DEFAULT_PAGE_SIZE = 24;

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });

const agencyNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Agency not found.' });

/**
 * Turns the stored identity key into a short-lived signed URL, or null when there is no photo. The
 * key belongs to a global user, and the bucket stays private: the signed URL is the only way
 * anything reads it (`identity-storage` README).
 *
 * A legacy or malformed key (`presignGetObject` refuses anything without a known image extension)
 * degrades that one person to no photo instead of failing the whole page for every role. The
 * warning carries only the error name/code: the key contains a user id and is never logged.
 */
const signedPhotoUrl = async (
  dependencies: CollaboratorModuleDependencies,
  key: string | null,
  log: FastifyRequest['log']
): Promise<string | null> => {
  if (key === null) return null;
  try {
    return await dependencies.identityStorage.presignGetObject({ key, expiresInSeconds: dependencies.identityDownloadUrlExpirySeconds });
  } catch (error) {
    log.warn({
      operation: 'collaborators.photo_url',
      status: 'failed',
      error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'IDENTITY_PHOTO_PRESIGN_FAILED' }
    }, 'Could not sign a collaborator photo URL; serving the list without it');
    return null;
  }
};

const collaboratorFromRow = async (
  dependencies: CollaboratorModuleDependencies,
  row: CollaboratorRow,
  log: FastifyRequest['log']
): Promise<Collaborator> => ({
  membershipId: row.membership_id,
  name: row.name,
  email: row.email,
  photoUrl: await signedPhotoUrl(dependencies, row.photo_key, log),
  jobTitle: row.job_title,
  role: { key: row.role_key, name: row.role_name },
  isOwner: row.is_owner === true,
  status: row.status,
  joinedAt: new Date(row.created_at).toISOString()
});

// Declared once: the same object is the route's documentation metadata and the source of the
// schemas the handler validates with.
const collaboratorListDocs = {
  permission: 'colaborador.visualizar',
  responseStatus: 200,
  schemas: { params: AgencyPathParamsSchema, query: CollaboratorListQuerySchema, response: CollaboratorListResponseSchema }
} satisfies DocumentedRouteConfig;

/** Registers `GET /agencies/:agencyId/collaborators` (issue #95), the product's first listing. */
export const registerCollaboratorModule = (app: FastifyInstance, dependencies: CollaboratorModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  app.get('/agencies/:agencyId/collaborators', {
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requirePermission(collaboratorListDocs.permission)
    ],
    config: collaboratorListDocs
  }, async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const tenant = request.tenant;
    if (tenant === undefined) throw agencyNotFound();

    const query = parseRequest(collaboratorListDocs.schemas.query, request.query);
    const pagination = resolvePagination(query, COLLABORATOR_DEFAULT_PAGE_SIZE);

    const page = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      listCollaborators(transaction, tenant.agencyId, {
        status: query.status ?? 'active',
        q: query.q,
        role: query.role,
        jobTitle: query.jobTitle
      }, pagination)
    );

    return reply.send(parseResponse(collaboratorListDocs.schemas.response, {
      data: await Promise.all(page.items.map((row) => collaboratorFromRow(dependencies, row, request.log))),
      meta: buildPaginationMetadata(pagination, page.totalItems)
    }));
  });
};
