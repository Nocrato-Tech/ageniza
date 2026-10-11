import {
  AgencyClientContentPathParamsSchema,
  AgencyClientPathParamsSchema,
  CONTENT_PERIOD_MAX_ITEMS,
  ContentDetailSchema,
  ContentPeriodQuerySchema,
  ContentPeriodResponseSchema,
  CreateContentRequestSchema,
  UpdateContentRequestSchema,
  contentPeriodIssue
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import { isInsufficientPrivilegeError, tenantHolds } from '../tenancy/guards.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import {
  clientArchived,
  clientNotFound,
  contentNotFound,
  forbidden,
  ownerInvalid,
  periodTooLarge,
  translateDatabaseError,
  unauthenticated,
  type WriteContext
} from './errors.js';
import { CONTENT_OWNER_CHANGE_PERMISSION, CONTENT_READ_PERMISSION } from './policy.js';
import {
  changesColumns,
  insertContent,
  listPeriod,
  loadClientStatus,
  loadContent,
  loadContentDetail,
  replaceContentMedia,
  resolveCollaboratorLink,
  updateContent,
  type ContentChanges,
  type ContentTransaction
} from './service.js';
import { idFromRoute } from './route-support.js';
import { registerContentTaskRoutes } from './task-routes.js';
import { registerContentTransitionRoutes } from './transition-routes.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface ContentModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Injected by the tenancy module so this module never duplicates the agency-access guard. */
  readonly requireAgencyAccess: PreHandler;
  /** Injected by the tenancy module; same named-permission rule the RLS policy enforces. */
  readonly requirePermission: (key: string) => PreHandler;
  /** The instant "today" is read from when a publication carries no day; only a test sets it, and without it the day is the database's own. */
  readonly now?: () => Date;
}

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

const requireTenant = (request: FastifyRequest): { readonly agencyId: string; readonly isOwner: boolean; readonly permissions: ReadonlySet<string> } => {
  const tenant = request.tenant;
  if (tenant === undefined) throw clientNotFound();
  return tenant;
};

export const registerContentModule = (app: FastifyInstance, dependencies: ContentModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  const readable = (docs: DocumentedRouteConfig & { permission: string }) => ({
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(docs.permission)],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  // A write also needs to read: the policy asks for both, and a person who only operates would fail it late and in the database.
  const writable = (docs: DocumentedRouteConfig & { permission: string }) => ({
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requirePermission(docs.permission),
      dependencies.requirePermission(CONTENT_READ_PERMISSION)
    ],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  // Declared once per route: the same object is the documentation metadata and the source of the schemas the
  // handler validates with, so a handler cannot drift from what is documented.
  const periodDocs = {
    permission: CONTENT_READ_PERMISSION,
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, query: ContentPeriodQuerySchema, response: ContentPeriodResponseSchema }
  } satisfies DocumentedRouteConfig;
  const createDocs = {
    permission: 'conteudo.operar',
    responseStatus: 201,
    schemas: { params: AgencyClientPathParamsSchema, body: CreateContentRequestSchema, response: ContentDetailSchema }
  } satisfies DocumentedRouteConfig;
  const detailDocs = {
    permission: CONTENT_READ_PERMISSION,
    responseStatus: 200,
    schemas: { params: AgencyClientContentPathParamsSchema, response: ContentDetailSchema }
  } satisfies DocumentedRouteConfig;
  const updateDocs = {
    permission: 'conteudo.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientContentPathParamsSchema, body: UpdateContentRequestSchema, response: ContentDetailSchema }
  } satisfies DocumentedRouteConfig;

  /** The client the route is about, read in the agency of the path: absent, foreign and unreadable are one 404. */
  const requireActiveClient = async (
    transaction: ContentTransaction,
    scope: { readonly agencyId: string; readonly clientId: string }
  ): Promise<void> => {
    const status = await loadClientStatus(transaction, scope);
    if (status === undefined) throw clientNotFound();
    if (status === 'archived') throw clientArchived();
  };

  /**
   * Why a write the checks before it let through was refused by the row-level policy: the client was archived in
   * the meantime (409), or this person lost the permission (403). Runs in a fresh transaction, because the one
   * that was refused is aborted, and so it reads the state the archive left after its locks.
   */
  const diagnoseRefusal = async (request: FastifyRequest, scope: { readonly agencyId: string; readonly clientId: string }): Promise<HttpError> => {
    const status = await withAuthenticatedUserTransaction(dependencies.database, requireAuth(request).claims, (transaction) =>
      loadClientStatus(transaction, scope));
    if (status === undefined) return clientNotFound();
    return status === 'archived' ? clientArchived() : forbidden();
  };

  const write = async <TResult>(
    request: FastifyRequest,
    scope: { readonly agencyId: string; readonly clientId: string },
    work: (transaction: ContentTransaction, context: WriteContext) => Promise<TResult>
  ): Promise<TResult> => {
    const context: WriteContext = { folderMoveKeepsCover: false };
    try {
      return await withAuthenticatedUserTransaction(dependencies.database, requireAuth(request).claims, (transaction) => work(transaction, context));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const translated = translateDatabaseError(error, context);
      if (translated !== undefined) throw translated;
      if (isInsufficientPrivilegeError(error)) throw await diagnoseRefusal(request, scope);
      throw error;
    }
  };

  app.get('/agencies/:agencyId/clients/:clientId/contents', readable(periodDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', clientNotFound);
    const query = routeQuery(periodDocs, request);
    const issue = contentPeriodIssue(query);
    if (issue !== undefined) {
      throw new HttpError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { issues: [{ path: issue.path, code: 'custom', message: issue.message }] }
      });
    }

    const items = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      if (await loadClientStatus(transaction, { agencyId: tenant.agencyId, clientId }) === undefined) throw clientNotFound();
      return listPeriod(transaction, { clientId, from: query.from, to: query.to, limit: CONTENT_PERIOD_MAX_ITEMS + 1 });
    });

    const count = items.contents.length + items.storyScripts.length;
    if (count > CONTENT_PERIOD_MAX_ITEMS) throw periodTooLarge();
    return reply.send(routeResponse(periodDocs, request, {
      data: { contents: items.contents, storyScripts: items.storyScripts },
      meta: { from: query.from, to: query.to, count }
    }));
  });

  app.post('/agencies/:agencyId/clients/:clientId/contents', writable(createDocs), async (request, reply) => {
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', clientNotFound);
    const body = routeBody(createDocs, request);
    const scope = { agencyId: tenant.agencyId, clientId };

    const detail = await write(request, scope, async (transaction) => {
      await requireActiveClient(transaction, scope);
      const { ownerMembershipId, ...fields } = body;
      const ownerUserId = ownerMembershipId === undefined
        ? undefined
        : await resolveCollaboratorLink(transaction, { agencyId: tenant.agencyId, membershipId: ownerMembershipId });
      if (ownerMembershipId !== undefined && ownerUserId === undefined) throw ownerInvalid();
      const contentId = await insertContent(transaction, { clientId, body: fields, ownerUserId });
      const row = await loadContent(transaction, { clientId, contentId });
      if (row === undefined) throw new Error('The content just inserted could not be read back.');
      return loadContentDetail(transaction, row);
    });
    return reply.status(201).send(routeResponse(createDocs, request, detail));
  });

  app.get('/agencies/:agencyId/clients/:clientId/contents/:contentId', readable(detailDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', clientNotFound);
    const contentId = idFromRoute(request, 'contentId', contentNotFound);

    const detail = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      if (await loadClientStatus(transaction, { agencyId: tenant.agencyId, clientId }) === undefined) throw clientNotFound();
      const row = await loadContent(transaction, { clientId, contentId });
      if (row === undefined) throw contentNotFound();
      return loadContentDetail(transaction, row);
    });
    return reply.send(routeResponse(detailDocs, request, detail));
  });

  app.patch('/agencies/:agencyId/clients/:clientId/contents/:contentId', writable(updateDocs), async (request, reply) => {
    const tenant = requireTenant(request);
    const clientId = idFromRoute(request, 'clientId', clientNotFound);
    const contentId = idFromRoute(request, 'contentId', contentNotFound);
    const body = routeBody(updateDocs, request);
    const scope = { agencyId: tenant.agencyId, clientId };

    const detail = await write(request, scope, async (transaction, context) => {
      const status = await loadClientStatus(transaction, scope);
      if (status === undefined) throw clientNotFound();
      const current = await loadContent(transaction, { clientId, contentId });
      if (current === undefined) throw contentNotFound();

      // The person is named by a link of the agency, never by an id: the link is read here, and the column gets the user it names.
      const { ownerMembershipId, ...fields } = body;
      const ownerUserId = ownerMembershipId === undefined
        ? undefined
        : await resolveCollaboratorLink(transaction, { agencyId: tenant.agencyId, membershipId: ownerMembershipId });

      // Who is in charge decides who approves a subtask, so changing it is the permission to approve for the agency. Without it the
      // answer is 403 whatever the link is, so the answer never says whether a link is an active one.
      if (ownerMembershipId !== undefined && ownerUserId !== current.owner_user_id && !tenantHolds(tenant, CONTENT_OWNER_CHANGE_PERMISSION)) {
        throw forbidden();
      }
      if (status === 'archived') throw clientArchived();
      if (ownerMembershipId !== undefined && ownerUserId === undefined) throw ownerInvalid();
      const changes: ContentChanges = ownerUserId === undefined ? fields : { ...fields, ownerUserId };

      context.folderMoveKeepsCover = body.folderId !== undefined && body.folderId !== current.folder_id
        && current.cover_asset_id !== null && body.coverAssetId === undefined;

      // The format first: the list that follows is checked against the format the content is moving to.
      if (changesColumns(changes) && !await updateContent(transaction, { clientId, contentId, changes })) throw contentNotFound();
      if (body.mediaAssetIds !== undefined) await replaceContentMedia(transaction, { contentId, assetIds: body.mediaAssetIds });

      const row = await loadContent(transaction, { clientId, contentId });
      if (row === undefined) throw contentNotFound();
      return loadContentDetail(transaction, row);
    });
    return reply.send(routeResponse(updateDocs, request, detail));
  });

  registerContentTransitionRoutes(app, dependencies);
  registerContentTaskRoutes(app, dependencies);
};

