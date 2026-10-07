import {
  AgencyPathParamsSchema,
  AgencyRolesQuerySchema,
  AgencyRolesResponseSchema,
  AgencyCollaboratorPathParamsSchema,
  CollaboratorDetailQuerySchema,
  CollaboratorJobTitlesQuerySchema,
  CollaboratorJobTitlesResponseSchema,
  CollaboratorListQuerySchema,
  CollaboratorListResponseSchema,
  CollaboratorSchema,
  UpdateCollaboratorRequestSchema,
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
import { routeBody, routeParams, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import { isInsufficientPrivilegeError, tenantHolds } from '../tenancy/guards.js';
import { COLLABORATOR_ROLES_READ_PERMISSIONS, COLLABORATOR_UPDATE_PERMISSIONS } from './permissions.js';
import { COLLABORATOR_PERMISSIONS, permissionsRequiredByChange } from './policy.js';
import {
  findAssignableRole,
  getCollaborator,
  listAgencyJobTitles,
  listAgencyRoles,
  listCollaborators,
  lockActiveMembership,
  updateMembership,
  type CollaboratorRow
} from './service.js';

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
  readonly requireAnyPermission: (keys: readonly string[]) => CollaboratorPreHandler;
}

// specs/colaboradores.md §6: 24 per page. The route declares only the default; `resolvePagination`
// owns the global ceiling (100) and the offset.
const COLLABORATOR_DEFAULT_PAGE_SIZE = 24;

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });

const agencyNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Agency not found.' });

// The one 404 the detail route returns: a membership of another agency, a nonexistent one, a
// malformed one and a removed one are indistinguishable on purpose.
const collaboratorNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Collaborator not found.' });

const forbidden = (message = 'You do not have permission to perform this action.'): HttpError =>
  new HttpError({ statusCode: 403, code: 'FORBIDDEN', message });

// The route's own refusals say what is missing. A 42501 that reaches the catch below comes from the
// database barrier and keeps the generic message, so the two layers can be told apart.
const MISSING_PERMISSION_MESSAGES: Readonly<Record<string, string>> = {
  [COLLABORATOR_PERMISSIONS.changeJobTitle]: 'Você não tem permissão para alterar o cargo.',
  [COLLABORATOR_PERMISSIONS.changeRole]: 'Você não tem permissão para alterar o papel.',
  [COLLABORATOR_PERMISSIONS.grantAdmin]: 'Só o Owner da agência pode conceder o papel de Admin.'
};

const invalidRole = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'INVALID_ROLE',
  message: 'O papel informado não é válido para esta agência.'
});

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

// The job-title filter of the grid (#102) needs the values that exist in the agency, and the
// listing only returns one page. Its own minimal route, same guard and permission as the listing.
const collaboratorJobTitlesDocs = {
  permission: 'colaborador.visualizar',
  responseStatus: 200,
  schemas: { params: AgencyPathParamsSchema, query: CollaboratorJobTitlesQuerySchema, response: CollaboratorJobTitlesResponseSchema }
} satisfies DocumentedRouteConfig;

// The detail returns the very same item schema the list uses, so the modal and the badge cannot
// drift. Its own URL makes a person shareable without paging to find them (issue #96).
const collaboratorDetailDocs = {
  permission: 'colaborador.visualizar',
  responseStatus: 200,
  schemas: {
    params: AgencyCollaboratorPathParamsSchema,
    query: CollaboratorDetailQuerySchema,
    response: CollaboratorSchema
  }
} satisfies DocumentedRouteConfig;

// The assignable roles of the agency (issue #287) serve the invite (#107), the role PATCH (#97)
// and the reactivation (#98): all three resolve the role by its uuid, and this is the only place
// the ids are exposed. Either of the two permissions is enough to read the list; the metadata
// says both, so the docs and the `x-permission` extension tell the truth (review of #293,
// finding 3; decisions.md, 2026-10-06, pending validation). The tuple lives in `permissions.ts`
// (a leaf), and the guard below demands exactly `agencyRolesDocs.permission` -- the same object
// the route registers and the catalog documents, so a wider guard cannot hide behind the docs.
const agencyRolesDocs = {
  permission: COLLABORATOR_ROLES_READ_PERMISSIONS,
  responseStatus: 200,
  schemas: { params: AgencyPathParamsSchema, query: AgencyRolesQuerySchema, response: AgencyRolesResponseSchema }
} satisfies DocumentedRouteConfig;

// The permission depends on which fields the body carries. The metadata and the guard name the two
// that can change anything at all (either one is enough to enter), and the handler then demands the
// one of each field present once the body is parsed (`policy.ts`, issue #97).
const collaboratorUpdateDocs = {
  permission: COLLABORATOR_UPDATE_PERMISSIONS,
  responseStatus: 200,
  schemas: {
    params: AgencyCollaboratorPathParamsSchema,
    body: UpdateCollaboratorRequestSchema,
    response: CollaboratorSchema
  }
} satisfies DocumentedRouteConfig;

/** Registers the collaborator routes of one agency: the listing (#95), job titles (#218), roles (#287), the detail (#96) and the update (#97). */
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

    const query = routeQuery(collaboratorListDocs, request);
    const pagination = resolvePagination(query, COLLABORATOR_DEFAULT_PAGE_SIZE);

    const page = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      listCollaborators(transaction, tenant.agencyId, {
        status: query.status ?? 'active',
        q: query.q,
        role: query.role,
        jobTitle: query.jobTitle
      }, pagination)
    );

    return reply.send(routeResponse(collaboratorListDocs, request, {
      data: await Promise.all(page.items.map((row) => collaboratorFromRow(dependencies, row, request.log))),
      meta: buildPaginationMetadata(pagination, page.totalItems)
    }));
  });

  // Registered before `/collaborators/:membershipId`: the literal `job-titles` must never be read
  // as a membership id, which the detail would then refuse as a malformed one (issue #218).
  app.get('/agencies/:agencyId/collaborators/job-titles', {
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requirePermission(collaboratorJobTitlesDocs.permission)
    ],
    config: collaboratorJobTitlesDocs
  }, async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const tenant = request.tenant;
    if (tenant === undefined) throw agencyNotFound();

    // The route declares no query parameter: an undeclared one (`?x=1`) is a 400, like the listing.
    routeQuery(collaboratorJobTitlesDocs, request);
    const jobTitles = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      listAgencyJobTitles(transaction, tenant.agencyId)
    );

    return reply.send(routeResponse(collaboratorJobTitlesDocs, request, { data: jobTitles }));
  });

  app.get('/agencies/:agencyId/roles', {
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requireAnyPermission(agencyRolesDocs.permission)
    ],
    config: agencyRolesDocs
  }, async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const tenant = request.tenant;
    if (tenant === undefined) throw agencyNotFound();

    // No query parameter exists on this route; an undeclared one (`?x=1`) is a 400.
    routeQuery(agencyRolesDocs, request);
    const roles = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      listAgencyRoles(transaction, tenant.agencyId, tenant.isOwner)
    );

    return reply.send(routeResponse(agencyRolesDocs, request, { data: roles }));
  });

  app.get('/agencies/:agencyId/collaborators/:membershipId', {
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requirePermission(collaboratorDetailDocs.permission)
    ],
    config: collaboratorDetailDocs
  }, async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const tenant = request.tenant;
    if (tenant === undefined) throw agencyNotFound();

    const params = routeParams(collaboratorDetailDocs, request);
    routeQuery(collaboratorDetailDocs, request);
    // The schema accepts any short string so a malformed id reaches this uniform 404 instead of a
    // 400 that would say "this id is not a uuid", which a valid-but-foreign id cannot say.
    if (!uuidPattern.test(params.membershipId)) throw collaboratorNotFound();

    const row = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      getCollaborator(transaction, tenant.agencyId, params.membershipId)
    );
    // A membership of another agency, a nonexistent one and a removed one all reach here as "no
    // row", and answer the same 404.
    if (row === undefined) throw collaboratorNotFound();
    return reply.send(routeResponse(collaboratorDetailDocs, request, await collaboratorFromRow(dependencies, row, request.log)));
  });

  app.patch('/agencies/:agencyId/collaborators/:membershipId', {
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requireAnyPermission(collaboratorUpdateDocs.permission)
    ],
    config: collaboratorUpdateDocs
  }, async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const tenant = request.tenant;
    if (tenant === undefined) throw agencyNotFound();

    const params = routeParams(collaboratorUpdateDocs, request);
    const body = routeBody(collaboratorUpdateDocs, request);

    const assertHolds = (grantsAdmin: boolean): void => {
      for (const key of permissionsRequiredByChange(body, grantsAdmin)) {
        if (!tenantHolds(tenant, key)) throw forbidden(MISSING_PERMISSION_MESSAGES[key]);
      }
    };

    // Before anything is read: a caller without the permission learns nothing about the role or
    // the person, not even that the membership id is malformed.
    assertHolds(false);
    if (!uuidPattern.test(params.membershipId)) throw collaboratorNotFound();

    let row: CollaboratorRow | undefined;
    try {
      row = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
        const target = await lockActiveMembership(transaction, tenant.agencyId, params.membershipId);
        if (target === undefined) throw collaboratorNotFound();

        if (body.roleId !== undefined) {
          const role = await findAssignableRole(transaction, tenant.agencyId, body.roleId);
          if (role === undefined) throw invalidRole();
          assertHolds(role.isAdmin);
          if (target.is_owner) throw forbidden('O papel do Owner da agência não pode ser alterado.');
          if (target.user_id === auth.userId) throw forbidden('Ninguém altera o próprio papel.');
        }

        // Zero rows means a policy filtered the row, which Postgres reports as success; answering
        // 200 for it would claim a change that never happened.
        if (!await updateMembership(transaction, tenant.agencyId, params.membershipId, body)) throw forbidden();
        return getCollaborator(transaction, tenant.agencyId, params.membershipId);
      });
    } catch (error) {
      if (isInsufficientPrivilegeError(error)) throw forbidden();
      throw error;
    }
    if (row === undefined) throw new Error('The updated membership could not be read back.');
    return reply.send(routeResponse(collaboratorUpdateDocs, request, await collaboratorFromRow(dependencies, row, request.log)));
  });
};
