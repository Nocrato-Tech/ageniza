import {
  AgencyClientContentPathParamsSchema,
  AgencyClientContentTaskPathParamsSchema,
  CONTENT_TASKS_MAX_PER_CONTENT,
  ContentTaskSchema,
  CreateContentTaskRequestSchema,
  ReturnContentTaskRequestSchema,
  UpdateContentTaskRequestSchema,
  type ContentTask
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction } from '@ageniza/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { createRequireSession } from '../auth/session-guard.js';
import { isInsufficientPrivilegeError } from '../tenancy/guards.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeResponse } from '../../plugins/infra/zod.js';
import { clientArchived, clientNotFound, contentNotFound, forbidden, unauthenticated } from './errors.js';
import { CONTENT_READ_PERMISSION } from './policy.js';
import { idFromRoute } from './route-support.js';
import type { ContentModuleDependencies } from './routes.js';
import { loadClientStatus, loadContent, loadContentTasks, resolveCollaboratorLink, type ContentTransaction } from './service.js';
import { taskAssigneeInvalid, taskLimitReached, taskNotFound, translateTaskError, type TaskAction } from './task-errors.js';
import {
  approveContentTask,
  countContentTasksLocked,
  deliverContentTask,
  insertContentTask,
  returnContentTask,
  updateContentTask,
  type ContentTaskChanges
} from './task-service.js';

type Scope = { readonly agencyId: string; readonly clientId: string };
type TaskDocs = DocumentedRouteConfig & { permission: string };

const TASKS = '/agencies/:agencyId/clients/:clientId/contents/:contentId/tasks';

/**
 * The subtasks of a content (#255, specs/conteudo.md sections 2, 3, 4 and 6). Creating and editing ask for `conteudo.operar`.
 * Delivering, approving and returning ask only to read: who may do each is a value of the row (the person in charge of the task,
 * the person in charge of the content or who approves for the agency), which the database function judges after its own locks,
 * so the route decides nothing it decides and translates what it refuses. The task must be the content's, and the content the
 * client's, or both are the same 404.
 */
export const registerContentTaskRoutes = (app: FastifyInstance, dependencies: ContentModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  // The same object is the documentation metadata and the source of the schemas the handler validates with.
  const createDocs = {
    permission: 'conteudo.operar',
    responseStatus: 201,
    schemas: { params: AgencyClientContentPathParamsSchema, body: CreateContentTaskRequestSchema, response: ContentTaskSchema }
  } satisfies DocumentedRouteConfig;
  const updateDocs = {
    permission: 'conteudo.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientContentTaskPathParamsSchema, body: UpdateContentTaskRequestSchema, response: ContentTaskSchema }
  } satisfies DocumentedRouteConfig;
  const deliverDocs = {
    permission: CONTENT_READ_PERMISSION,
    responseStatus: 200,
    schemas: { params: AgencyClientContentTaskPathParamsSchema, response: ContentTaskSchema }
  } satisfies DocumentedRouteConfig;
  const approveDocs = {
    permission: CONTENT_READ_PERMISSION,
    responseStatus: 200,
    schemas: { params: AgencyClientContentTaskPathParamsSchema, response: ContentTaskSchema }
  } satisfies DocumentedRouteConfig;
  const returnDocs = {
    permission: CONTENT_READ_PERMISSION,
    responseStatus: 200,
    schemas: { params: AgencyClientContentTaskPathParamsSchema, body: ReturnContentTaskRequestSchema, response: ContentTaskSchema }
  } satisfies DocumentedRouteConfig;

  // A write also needs to read: the policy asks for both, and a person who only acts would fail it late and in the database.
  const guards = (docs: TaskDocs) => ({
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requirePermission(docs.permission),
      ...(docs.permission === CONTENT_READ_PERMISSION ? [] : [dependencies.requirePermission(CONTENT_READ_PERMISSION)])
    ],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  const claimsOf = (request: FastifyRequest) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    return auth.claims;
  };

  /**
   * Why a write the checks before it let through was refused by the row-level policy: the client was archived in the meantime
   * (409) or this person lost the permission (403). Runs in a new transaction, because the one refused is aborted.
   */
  const diagnoseRefusal = async (request: FastifyRequest, scope: Scope): Promise<HttpError> => {
    const status = await withAuthenticatedUserTransaction(dependencies.database, claimsOf(request), (transaction) => loadClientStatus(transaction, scope));
    if (status === undefined) return clientNotFound();
    return status === 'archived' ? clientArchived() : forbidden();
  };

  const write = async (request: FastifyRequest, scope: Scope, action: TaskAction, work: (transaction: ContentTransaction) => Promise<ContentTask>): Promise<ContentTask> => {
    try {
      return await withAuthenticatedUserTransaction(dependencies.database, claimsOf(request), work);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const translated = translateTaskError(error, action);
      if (translated !== undefined) throw translated;
      if (isInsufficientPrivilegeError(error)) throw await diagnoseRefusal(request, scope);
      throw error;
    }
  };

  /** The content of this client, as this person reads it; the client is read first so a client that is not the agency's is the one 404. */
  const requireContent = async (transaction: ContentTransaction, scope: Scope, contentId: string): Promise<'active' | 'archived'> => {
    const status = await loadClientStatus(transaction, scope);
    if (status === undefined) throw clientNotFound();
    if (await loadContent(transaction, { clientId: scope.clientId, contentId }) === undefined) throw contentNotFound();
    return status;
  };

  const readBack = async (transaction: ContentTransaction, contentId: string, taskId: string): Promise<ContentTask> => {
    const [task] = await loadContentTasks(transaction, { contentId, taskId });
    if (task === undefined) throw taskNotFound();
    return task;
  };

  app.post(TASKS, guards(createDocs), async (request, reply) => {
    const tenant = request.tenant;
    if (tenant === undefined) throw clientNotFound();
    const clientId = idFromRoute(request, 'clientId', clientNotFound);
    const contentId = idFromRoute(request, 'contentId', contentNotFound);
    const body = routeBody(createDocs, request);
    const scope = { agencyId: tenant.agencyId, clientId };

    const task = await write(request, scope, 'create', async (transaction) => {
      if (await requireContent(transaction, scope, contentId) === 'archived') throw clientArchived();
      const { assigneeMembershipId, ...fields } = body;
      const assigneeUserId = await resolveCollaboratorLink(transaction, { agencyId: tenant.agencyId, membershipId: assigneeMembershipId });
      if (assigneeUserId === undefined) throw taskAssigneeInvalid();
      if (await countContentTasksLocked(transaction, contentId) >= CONTENT_TASKS_MAX_PER_CONTENT) throw taskLimitReached();
      const taskId = await insertContentTask(transaction, { contentId, clientId, body: fields, assigneeUserId });
      return readBack(transaction, contentId, taskId);
    });
    return reply.status(201).send(routeResponse(createDocs, request, task));
  });

  app.patch(`${TASKS}/:taskId`, guards(updateDocs), async (request, reply) => {
    const tenant = request.tenant;
    if (tenant === undefined) throw clientNotFound();
    const clientId = idFromRoute(request, 'clientId', clientNotFound);
    const contentId = idFromRoute(request, 'contentId', contentNotFound);
    const taskId = idFromRoute(request, 'taskId', taskNotFound);
    const body = routeBody(updateDocs, request);
    const scope = { agencyId: tenant.agencyId, clientId };

    const task = await write(request, scope, 'update', async (transaction) => {
      const status = await requireContent(transaction, scope, contentId);
      if ((await loadContentTasks(transaction, { contentId, taskId }))[0] === undefined) throw taskNotFound();
      // The archived client answers before the link is looked at, like the person in charge of a content.
      if (status === 'archived') throw clientArchived();
      const { assigneeMembershipId, ...fields } = body;
      const assigneeUserId = assigneeMembershipId === undefined
        ? undefined
        : await resolveCollaboratorLink(transaction, { agencyId: tenant.agencyId, membershipId: assigneeMembershipId });
      if (assigneeMembershipId !== undefined && assigneeUserId === undefined) throw taskAssigneeInvalid();
      const changes: ContentTaskChanges = assigneeUserId === undefined ? fields : { ...fields, assigneeUserId };
      if (!await updateContentTask(transaction, { contentId, clientId, taskId, changes })) throw taskNotFound();
      return readBack(transaction, contentId, taskId);
    });
    return reply.send(routeResponse(updateDocs, request, task));
  });

  const registerMove = <TBody>(
    segment: string,
    docs: TaskDocs & { schemas: { response: typeof ContentTaskSchema } },
    action: TaskAction,
    handler: {
      readonly body: (request: FastifyRequest) => TBody;
      readonly run: (transaction: ContentTransaction, input: { readonly taskId: string; readonly body: TBody }) => Promise<void>;
    }
  ): void => {
    app.post(`${TASKS}/:taskId/${segment}`, guards(docs), async (request, reply) => {
      const tenant = request.tenant;
      if (tenant === undefined) throw clientNotFound();
      const clientId = idFromRoute(request, 'clientId', clientNotFound);
      const contentId = idFromRoute(request, 'contentId', contentNotFound);
      const taskId = idFromRoute(request, 'taskId', taskNotFound);
      const body = handler.body(request);
      const scope = { agencyId: tenant.agencyId, clientId };

      const task = await write(request, scope, action, async (transaction) => {
        // Who may do this, the state of the task and the state of the client are judged by the function after its own locks, so the
        // client is read after the last wait and never before it. Here only that the task is the content's, and the content the client's.
        await requireContent(transaction, scope, contentId);
        if ((await loadContentTasks(transaction, { contentId, taskId }))[0] === undefined) throw taskNotFound();
        await handler.run(transaction, { taskId, body });
        return readBack(transaction, contentId, taskId);
      });
      return reply.send(routeResponse(docs, request, task));
    });
  };

  registerMove('deliver', deliverDocs, 'deliver', {
    body: (): undefined => undefined,
    run: (transaction, { taskId }) => deliverContentTask(transaction, taskId)
  });

  registerMove('approve', approveDocs, 'approve', {
    body: (): undefined => undefined,
    run: (transaction, { taskId }) => approveContentTask(transaction, taskId)
  });

  registerMove('return', returnDocs, 'return', {
    body: (request) => routeBody(returnDocs, request),
    run: (transaction, { taskId, body }) => returnContentTask(transaction, { taskId, comment: body.comment })
  });
};
