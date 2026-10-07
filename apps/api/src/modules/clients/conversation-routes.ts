import {
  AgencyClientPathParamsSchema,
  AgencyClientThreadPathParamsSchema,
  ClientPathParamsSchema,
  ClientThreadPathParamsSchema,
  CommentListQuerySchema,
  CommentListResponseSchema,
  CommentSchema,
  CreateCommentRequestSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  ThreadListQuerySchema,
  ThreadListResponseSchema,
  ThreadSchema,
  buildPaginationMetadata,
  resolvePagination,
  threadSubjectOfQuery,
  type ThreadComment,
  type ThreadListQuery,
  type ThreadSubject
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { IdentityStorageClient } from '../identity-storage/storage-client.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import {
  ConversationWriteRefused,
  addComment,
  authorOf,
  diagnoseConversationRefusal,
  listComments,
  listThreads,
  loadAuthors,
  loadComment,
  loadThreadRow,
  openThread,
  resolveThread,
  threadFromRow,
  type CommentRow,
  type ConversationAuthors,
  type ConversationRefusal,
  type ConversationScope
} from './conversation-service.js';
import { createPhotoUrlSigner } from './photo-url.js';
import { COMMENT_DEFAULT_PAGE_SIZE, THREAD_DEFAULT_PAGE_SIZE } from './policy.js';
import { isClientNoLongerActive, isRowLevelSecurityViolation, type ClientTransaction } from './service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface ConversationRouteDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly identityStorage?: IdentityStorageClient;
  readonly photoUrlExpirySeconds: number;
  readonly requireAgencyAccess: PreHandler;
  readonly requirePermission: (key: string) => PreHandler;
  /** Injected by the tenancy module: the active client link is the only authorization of the portal. */
  readonly requireClientAccess: PreHandler;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
const notFound = (message: string): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message });
const forbidden = (): HttpError => new HttpError({ statusCode: 403, code: 'FORBIDDEN', message: 'You do not have permission to perform this action.' });

/** One error per refusal: another client's, another agency's and a missing id are the same 404. */
const refusalError = (refusal: ConversationRefusal): HttpError => {
  switch (refusal) {
    case 'client-not-found': return notFound('Client not found.');
    case 'thread-not-found': return notFound('Thread not found.');
    case 'subject-not-found': return notFound('Subject not found.');
    case 'client-archived':
      return new HttpError({ statusCode: 409, code: 'CLIENT_ARCHIVED', message: 'Cliente arquivado não pode ser editado.' });
    case 'persona-archived':
      return new HttpError({ statusCode: 409, code: 'PERSONA_ARCHIVED', message: 'Persona arquivada: a conversa é somente leitura.' });
    case 'section-not-filled':
      return new HttpError({ statusCode: 409, code: 'SECTION_NOT_FILLED', message: 'Esta seção ainda não foi preenchida pela agência.' });
  }
};

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

/** A malformed id is the same 404 as an absent one, never a 400 that confirms the route exists. */
const uuidFromRoute = (request: FastifyRequest, name: string, message: string): string => {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw notFound(message);
  return value;
};

/** A listing names exactly one subject; naming none or both is a validation error, like any other bad query. */
const subjectOfQuery = (query: ThreadListQuery): ThreadSubject => {
  const subject = threadSubjectOfQuery(query);
  if (subject === undefined) {
    throw new HttpError({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: { issues: [{ path: 'sectionKey', code: 'custom', message: 'exactly one of sectionKey and personaId is required' }] }
    });
  }
  return subject;
};

const isoOf = (value: Date): string => new Date(value).toISOString();

/**
 * Registers the conversation routes of both sides over the one service (#128 agency, #130 portal).
 * The agency routes are guarded by `cliente.visualizar` / `cliente.operar`; the portal routes by the
 * active client link alone. The side a write is stamped with comes from which of the two sets the
 * request came through, never from the body.
 */
export const registerConversationRoutes = (app: FastifyInstance, dependencies: ConversationRouteDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const signAuthorPhoto = createPhotoUrlSigner(dependencies, {
    code: 'CONVERSATION_AUTHOR_PHOTO_URL_FAILED',
    message: 'Could not sign a comment author photo URL; returning null'
  });

  const commentFrom = async (request: FastifyRequest, row: CommentRow, threadId: string, authors: ConversationAuthors): Promise<ThreadComment> => {
    const author = authorOf(authors, threadId, row.author_side, row.author_user_id);
    return {
      id: row.id,
      body: row.body,
      side: row.author_side,
      author: author === undefined ? null : { name: author.name, photoUrl: await signAuthorPhoto(request, author.photoKey) },
      createdAt: isoOf(row.created_at)
    };
  };

  /**
   * Runs a write. A refusal by row-level security after the service's own checks passed means the
   * client or persona changed under the request; it is read back in a fresh transaction (the failed
   * one is aborted) and answered as the same 409 or 404 the checks would have given.
   */
  const write = async <TResult>(
    request: FastifyRequest,
    scope: ConversationScope,
    target: { readonly personaId?: string; readonly threadId?: string },
    work: (transaction: ClientTransaction) => Promise<TResult>
  ): Promise<TResult> => {
    const auth = requireAuth(request);
    try {
      return await withAuthenticatedUserTransaction(dependencies.database, auth.claims, work);
    } catch (error) {
      // The archive won the race for the client; the portal never learns that, an archived client is "not found" there.
      if (isClientNoLongerActive(error)) throw refusalError(scope.side === 'agency' ? 'client-archived' : 'client-not-found');
      if (!isRowLevelSecurityViolation(error) && !(error instanceof ConversationWriteRefused)) throw error;
      const refusal = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
        diagnoseConversationRefusal(transaction, scope, target));
      throw refusal === undefined ? forbidden() : refusalError(refusal);
    }
  };

  const read = <TResult>(request: FastifyRequest, work: (transaction: ClientTransaction) => Promise<TResult>): Promise<TResult> =>
    withAuthenticatedUserTransaction(dependencies.database, requireAuth(request).claims, work);

  const agencyScope = (request: FastifyRequest): ConversationScope => {
    const tenant = request.tenant;
    if (tenant === undefined) throw notFound('Client not found.');
    return {
      side: 'agency',
      agencyId: tenant.agencyId,
      clientId: uuidFromRoute(request, 'clientId', 'Client not found.'),
      userId: requireAuth(request).userId
    };
  };

  const portalScope = (request: FastifyRequest): ConversationScope => {
    const clientContext = request.clientContext;
    if (clientContext === undefined) throw notFound('Client not found.');
    return { side: 'client', clientId: clientContext.clientId, userId: requireAuth(request).userId };
  };

  // The same objects are the documentation and the schemas each handler validates with.
  const agencyParams = AgencyClientPathParamsSchema;
  const agencyThreadParams = AgencyClientThreadPathParamsSchema;
  const agencyGuards = (docs: DocumentedRouteConfig & { permission: string }) => ({
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(docs.permission)],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });
  const portalGuards = (docs: DocumentedRouteConfig) => ({
    preHandler: [requireSession, dependencies.requireClientAccess],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  // --- Handlers, one per operation, parameterised by how the side builds its scope ----------

  const listThreadsHandler = (
    scopeOf: (request: FastifyRequest) => ConversationScope,
    docs: { readonly schemas: { readonly query: typeof ThreadListQuerySchema; readonly response: typeof ThreadListResponseSchema } }
  ) => async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = scopeOf(request);
    const query = routeQuery(docs, request);
    const pagination = resolvePagination(query, THREAD_DEFAULT_PAGE_SIZE);
    const subject = subjectOfQuery(query);

    const outcome = await read(request, async (transaction) => {
      const result = await listThreads(transaction, scope, { subject, state: query.state }, pagination);
      if (result.kind !== 'ok') return result;
      const authors = await loadAuthors(transaction, result.page.items.map((row) => row.id));
      return { kind: 'ok' as const, page: result.page, authors };
    });
    if (outcome.kind !== 'ok') throw refusalError(outcome.kind);

    return reply.send(routeResponse(docs, request, {
      data: outcome.page.items.map((row) => threadFromRow(row, outcome.authors)),
      meta: buildPaginationMetadata(pagination, outcome.page.totalItems)
    }));
  };

  const openThreadHandler = (
    scopeOf: (request: FastifyRequest) => ConversationScope,
    docs: { readonly schemas: { readonly body: typeof CreateThreadRequestSchema; readonly response: typeof CreateThreadResponseSchema } }
  ) => async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = scopeOf(request);
    const body = routeBody(docs, request);

    const outcome = await write(request, scope, { personaId: 'personaId' in body.subject ? body.subject.personaId : undefined }, async (transaction) => {
      const opened = await openThread(transaction, scope, body);
      if (opened.kind !== 'ok') return opened;
      const thread = await loadThreadRow(transaction, { clientId: scope.clientId, threadId: opened.threadId });
      const comment = await loadComment(transaction, { clientId: scope.clientId, threadId: opened.threadId, commentId: opened.commentId });
      const authors = await loadAuthors(transaction, [opened.threadId]);
      if (thread === undefined || comment === undefined) throw new Error('The thread that was just opened could not be read back.');
      return { kind: 'ok' as const, thread, comment, authors };
    });
    if (outcome.kind !== 'ok') throw refusalError(outcome.kind);

    return reply.status(201).send(routeResponse(docs, request, {
      thread: threadFromRow(outcome.thread, outcome.authors),
      comment: await commentFrom(request, outcome.comment, outcome.thread.id, outcome.authors)
    }));
  };

  const listCommentsHandler = (
    scopeOf: (request: FastifyRequest) => ConversationScope,
    docs: { readonly schemas: { readonly query: typeof CommentListQuerySchema; readonly response: typeof CommentListResponseSchema } }
  ) => async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = scopeOf(request);
    const threadId = uuidFromRoute(request, 'threadId', 'Thread not found.');
    const query = routeQuery(docs, request);
    const pagination = resolvePagination(query, COMMENT_DEFAULT_PAGE_SIZE);

    const outcome = await read(request, async (transaction) => {
      const result = await listComments(transaction, scope, threadId, pagination);
      if (result.kind !== 'ok') return result;
      return { kind: 'ok' as const, page: result.page, authors: await loadAuthors(transaction, [threadId]) };
    });
    if (outcome.kind !== 'ok') throw refusalError(outcome.kind);

    return reply.send(routeResponse(docs, request, {
      data: await Promise.all(outcome.page.items.map((row) => commentFrom(request, row, threadId, outcome.authors))),
      meta: buildPaginationMetadata(pagination, outcome.page.totalItems)
    }));
  };

  const addCommentHandler = (
    scopeOf: (request: FastifyRequest) => ConversationScope,
    docs: { readonly schemas: { readonly body: typeof CreateCommentRequestSchema; readonly response: typeof CommentSchema } }
  ) => async (request: FastifyRequest, reply: FastifyReply) => {
    const scope = scopeOf(request);
    const threadId = uuidFromRoute(request, 'threadId', 'Thread not found.');
    const body = routeBody(docs, request);

    const outcome = await write(request, scope, { threadId }, async (transaction) => {
      const added = await addComment(transaction, scope, { threadId, body: body.body });
      if (added.kind !== 'ok') return added;
      const comment = await loadComment(transaction, { clientId: scope.clientId, threadId, commentId: added.commentId });
      const authors = await loadAuthors(transaction, [threadId]);
      if (comment === undefined) throw new Error('The comment that was just written could not be read back.');
      return { kind: 'ok' as const, comment, authors };
    });
    if (outcome.kind !== 'ok') throw refusalError(outcome.kind);

    return reply.status(201).send(routeResponse(docs, request, await commentFrom(request, outcome.comment, threadId, outcome.authors)));
  };

  // --- The agency side (#128) ----------------------------------------------------------------

  const agencyListThreadsDocs = {
    permission: 'cliente.visualizar',
    responseStatus: 200,
    schemas: { params: agencyParams, query: ThreadListQuerySchema, response: ThreadListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const agencyOpenThreadDocs = {
    permission: 'cliente.operar',
    responseStatus: 201,
    schemas: { params: agencyParams, body: CreateThreadRequestSchema, response: CreateThreadResponseSchema }
  } satisfies DocumentedRouteConfig;
  const agencyListCommentsDocs = {
    permission: 'cliente.visualizar',
    responseStatus: 200,
    schemas: { params: agencyThreadParams, query: CommentListQuerySchema, response: CommentListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const agencyAddCommentDocs = {
    permission: 'cliente.operar',
    responseStatus: 201,
    schemas: { params: agencyThreadParams, body: CreateCommentRequestSchema, response: CommentSchema }
  } satisfies DocumentedRouteConfig;
  const agencyResolveDocs = {
    permission: 'cliente.operar',
    responseStatus: 200,
    schemas: { params: agencyThreadParams, response: ThreadSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/agencies/:agencyId/clients/:clientId/threads', agencyGuards(agencyListThreadsDocs), listThreadsHandler(agencyScope, agencyListThreadsDocs));
  app.post('/agencies/:agencyId/clients/:clientId/threads', agencyGuards(agencyOpenThreadDocs), openThreadHandler(agencyScope, agencyOpenThreadDocs));
  app.get('/agencies/:agencyId/clients/:clientId/threads/:threadId/comments', agencyGuards(agencyListCommentsDocs), listCommentsHandler(agencyScope, agencyListCommentsDocs));
  app.post('/agencies/:agencyId/clients/:clientId/threads/:threadId/comments', agencyGuards(agencyAddCommentDocs), addCommentHandler(agencyScope, agencyAddCommentDocs));

  app.post('/agencies/:agencyId/clients/:clientId/threads/:threadId/resolve', agencyGuards(agencyResolveDocs), async (request, reply) => {
    const scope = agencyScope(request);
    if (scope.side !== 'agency') throw notFound('Client not found.');
    const threadId = uuidFromRoute(request, 'threadId', 'Thread not found.');

    const outcome = await write(request, scope, { threadId }, async (transaction) => {
      const resolved = await resolveThread(transaction, scope, threadId);
      if (resolved.kind !== 'ok') return resolved;
      const thread = await loadThreadRow(transaction, { clientId: scope.clientId, threadId });
      const authors = await loadAuthors(transaction, [threadId]);
      if (thread === undefined) throw new Error('The thread that was just resolved could not be read back.');
      return { kind: 'ok' as const, thread, authors };
    });
    if (outcome.kind !== 'ok') throw refusalError(outcome.kind);

    return reply.send(routeResponse(agencyResolveDocs, request, threadFromRow(outcome.thread, outcome.authors)));
  });

  // --- The portal side (#130): the same service, the side fixed to `client`, and no resolve -----

  const portalListThreadsDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: ClientPathParamsSchema, query: ThreadListQuerySchema, response: ThreadListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const portalOpenThreadDocs = {
    permission: null,
    responseStatus: 201,
    schemas: { params: ClientPathParamsSchema, body: CreateThreadRequestSchema, response: CreateThreadResponseSchema }
  } satisfies DocumentedRouteConfig;
  const portalListCommentsDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: ClientThreadPathParamsSchema, query: CommentListQuerySchema, response: CommentListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const portalAddCommentDocs = {
    permission: null,
    responseStatus: 201,
    schemas: { params: ClientThreadPathParamsSchema, body: CreateCommentRequestSchema, response: CommentSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/clients/:clientId/threads', portalGuards(portalListThreadsDocs), listThreadsHandler(portalScope, portalListThreadsDocs));
  app.post('/clients/:clientId/threads', portalGuards(portalOpenThreadDocs), openThreadHandler(portalScope, portalOpenThreadDocs));
  app.get('/clients/:clientId/threads/:threadId/comments', portalGuards(portalListCommentsDocs), listCommentsHandler(portalScope, portalListCommentsDocs));
  app.post('/clients/:clientId/threads/:threadId/comments', portalGuards(portalAddCommentDocs), addCommentHandler(portalScope, portalAddCommentDocs));
};
