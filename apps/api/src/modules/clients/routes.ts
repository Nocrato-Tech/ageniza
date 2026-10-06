import {
  AgencyClientPathParamsSchema,
  AgencyClientThreadPathParamsSchema,
  AgencyPathParamsSchema,
  ClientDetailResponseSchema,
  ClientSchema,
  CreateClientRequestSchema,
  CreateThreadCommentRequestSchema,
  CreateThreadRequestSchema,
  CreateThreadResponseSchema,
  PaginationInputSchema,
  ThreadCommentListResponseSchema,
  ThreadCommentSchema,
  ThreadListItemSchema,
  ThreadListQuerySchema,
  ThreadListResponseSchema,
  UpdateClientRequestSchema,
  buildPaginationMetadata,
  resolvePagination,
  type ConversationSectionKey,
  type ThreadSubject
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { IdentityStorageClient } from '../identity-storage/storage-client.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';
import {
  createThreadComment,
  createThreadWithFirstComment,
  loadPersonaSubject,
  loadThreadComment,
  loadThreadComments,
  loadThreadItem,
  loadThreads,
  resolveThread,
  threadCommentFromRow,
  threadListItemFromRow
} from './conversation.js';
import {
  clientFromRow,
  createClient,
  isActiveClientNameConflict,
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

const threadNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Thread not found.' });

const personaNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Persona not found.' });

const personaArchived = (): HttpError => new HttpError({
  statusCode: 409,
  code: 'PERSONA_ARCHIVED',
  message: 'Persona arquivada não aceita escrita.'
});

const threadSubjectRequired = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path: 'sectionKey', code: 'custom', message: 'Exactly one of sectionKey or personaId is required.' }] }
});

const routeQuery = <T>(schema: z.ZodType<T>, request: FastifyRequest): T => parseRequest(schema, request.query);

/** A malformed `:threadId` is the same 404 as an absent one, never a 400. */
const threadIdFromRoute = (request: FastifyRequest): string => {
  const value = (request.params as { readonly threadId?: unknown }).threadId;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw threadNotFound();
  return value;
};

/** The list requires exactly one subject; both or neither is a 400, never a silent default. */
const subjectFromQuery = (query: { readonly sectionKey?: ConversationSectionKey; readonly personaId?: string }): ThreadSubject => {
  if ((query.sectionKey === undefined) === (query.personaId === undefined)) throw threadSubjectRequired();
  return query.sectionKey !== undefined ? { sectionKey: query.sectionKey } : { personaId: query.personaId as string };
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

  app.post('/agencies/:agencyId/clients', authenticated(createDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const body = parseRequest(createDocs.schemas.body, request.body);

    let row;
    try {
      row = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
        createClient(transaction, { agencyId: tenant.agencyId, name: body.name }));
    } catch (error) {
      if (isActiveClientNameConflict(error)) throw clientNameInUse();
      throw error;
    }
    return reply.status(201).send(parseResponse(createDocs.schemas.response, clientFromRow(row, null)));
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
    return reply.send(parseResponse(detailDocs.schemas.response, {
      ...clientFromRow(result.row, photoUrl),
      summary: result.summary
    }));
  });

  app.patch('/agencies/:agencyId/clients/:clientId', authenticated(updateDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const body = parseRequest(updateDocs.schemas.body, request.body);

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
    return reply.send(parseResponse(updateDocs.schemas.response, clientFromRow(outcome.row, photoUrl)));
  });

  // --- Conversation (issue #128): agency side of the product's thread model -------------------

  const THREADS_PAGE_SIZE = 20;
  const COMMENTS_PAGE_SIZE = 50;

  const threadListDocs = {
    permission: 'cliente.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, query: ThreadListQuerySchema, response: ThreadListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const createThreadDocs = {
    permission: 'cliente.operar',
    responseStatus: 201,
    schemas: { params: AgencyClientPathParamsSchema, body: CreateThreadRequestSchema, response: CreateThreadResponseSchema }
  } satisfies DocumentedRouteConfig;
  const commentListDocs = {
    permission: 'cliente.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyClientThreadPathParamsSchema, query: PaginationInputSchema, response: ThreadCommentListResponseSchema }
  } satisfies DocumentedRouteConfig;
  const createCommentDocs = {
    permission: 'cliente.operar',
    responseStatus: 201,
    schemas: { params: AgencyClientThreadPathParamsSchema, body: CreateThreadCommentRequestSchema, response: ThreadCommentSchema }
  } satisfies DocumentedRouteConfig;
  const resolveThreadDocs = {
    permission: 'cliente.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientThreadPathParamsSchema, response: ThreadListItemSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/agencies/:agencyId/clients/:clientId/threads', authenticated(threadListDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const query = routeQuery(threadListDocs.schemas.query, request);
    const subject = subjectFromQuery(query);
    const pagination = resolvePagination(query, THREADS_PAGE_SIZE);

    const outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const client = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (client === undefined) return { kind: 'not-found' } as const;
      if ('personaId' in subject) {
        const persona = await loadPersonaSubject(transaction, { agencyId: tenant.agencyId, clientId, personaId: subject.personaId });
        if (persona === undefined) return { kind: 'subject-not-found' } as const;
      }
      const page = await loadThreads(transaction, {
        agencyId: tenant.agencyId, clientId, subject, state: query.state,
        pageSize: pagination.pageSize, offset: pagination.offset
      });
      return { kind: 'ok', page } as const;
    });
    if (outcome.kind === 'not-found') throw clientNotFound();
    if (outcome.kind === 'subject-not-found') throw personaNotFound();
    return reply.send(parseResponse(threadListDocs.schemas.response, {
      data: outcome.page.items.map(threadListItemFromRow),
      meta: buildPaginationMetadata(pagination, outcome.page.totalItems)
    }));
  });

  app.post('/agencies/:agencyId/clients/:clientId/threads', authenticated(createThreadDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const body = parseRequest(createThreadDocs.schemas.body, request.body);

    const outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const client = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (client === undefined) return { kind: 'not-found' } as const;
      if (client.status === 'archived') return { kind: 'archived' } as const;
      if ('personaId' in body.subject) {
        const persona = await loadPersonaSubject(transaction, { agencyId: tenant.agencyId, clientId, personaId: body.subject.personaId });
        if (persona === undefined) return { kind: 'subject-not-found' } as const;
        if (persona.status === 'archived') return { kind: 'persona-archived' } as const;
      }
      // The side is this route being the agency route, never the body (specs/clientes.md §5, rule 10).
      const created = await createThreadWithFirstComment(transaction, {
        clientId, actorUserId: auth.userId, side: 'agency', subject: body.subject, body: body.body
      });
      if (created === undefined) return { kind: 'not-found' } as const;
      const thread = await loadThreadItem(transaction, { agencyId: tenant.agencyId, clientId, threadId: created.threadId });
      const comment = await loadThreadComment(transaction, { agencyId: tenant.agencyId, clientId, commentId: created.commentId });
      if (thread === undefined || comment === undefined) return { kind: 'not-found' } as const;
      return { kind: 'ok', thread, comment } as const;
    });
    if (outcome.kind === 'not-found') throw clientNotFound();
    if (outcome.kind === 'archived') throw clientArchived();
    if (outcome.kind === 'subject-not-found') throw personaNotFound();
    if (outcome.kind === 'persona-archived') throw personaArchived();

    const photoUrl = await signPhotoUrl(request, outcome.comment.author_image);
    return reply.status(201).send(parseResponse(createThreadDocs.schemas.response, {
      thread: threadListItemFromRow(outcome.thread),
      comment: threadCommentFromRow(outcome.comment, photoUrl)
    }));
  });

  app.get('/agencies/:agencyId/clients/:clientId/threads/:threadId/comments', authenticated(commentListDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const threadId = threadIdFromRoute(request);
    const query = routeQuery(commentListDocs.schemas.query, request);
    const pagination = resolvePagination(query, COMMENTS_PAGE_SIZE);

    const result = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const client = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (client === undefined) return undefined;
      const thread = await loadThreadItem(transaction, { agencyId: tenant.agencyId, clientId, threadId });
      if (thread === undefined) return undefined;
      return loadThreadComments(transaction, {
        agencyId: tenant.agencyId, clientId, threadId, pageSize: pagination.pageSize, offset: pagination.offset
      });
    });
    if (result === undefined) throw threadNotFound();

    const data = await Promise.all(result.items.map(async (row) => threadCommentFromRow(row, await signPhotoUrl(request, row.author_image))));
    return reply.send(parseResponse(commentListDocs.schemas.response, {
      data,
      meta: buildPaginationMetadata(pagination, result.totalItems)
    }));
  });

  app.post('/agencies/:agencyId/clients/:clientId/threads/:threadId/comments', authenticated(createCommentDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const threadId = threadIdFromRoute(request);
    const body = parseRequest(createCommentDocs.schemas.body, request.body);

    const outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const client = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (client === undefined) return { kind: 'not-found' } as const;
      if (client.status === 'archived') return { kind: 'archived' } as const;
      const thread = await loadThreadItem(transaction, { agencyId: tenant.agencyId, clientId, threadId });
      if (thread === undefined) return { kind: 'thread-not-found' } as const;
      if (thread.persona_id !== null) {
        const persona = await loadPersonaSubject(transaction, { agencyId: tenant.agencyId, clientId, personaId: thread.persona_id });
        if (persona?.status === 'archived') return { kind: 'persona-archived' } as const;
      }
      const commentId = await createThreadComment(transaction, {
        clientId, threadId, actorUserId: auth.userId, side: 'agency', body: body.body
      });
      if (commentId === undefined) return { kind: 'thread-not-found' } as const;
      const comment = await loadThreadComment(transaction, { agencyId: tenant.agencyId, clientId, commentId });
      if (comment === undefined) return { kind: 'thread-not-found' } as const;
      return { kind: 'ok', comment } as const;
    });
    if (outcome.kind === 'not-found') throw clientNotFound();
    if (outcome.kind === 'archived') throw clientArchived();
    if (outcome.kind === 'thread-not-found') throw threadNotFound();
    if (outcome.kind === 'persona-archived') throw personaArchived();

    const photoUrl = await signPhotoUrl(request, outcome.comment.author_image);
    return reply.status(201).send(parseResponse(createCommentDocs.schemas.response, threadCommentFromRow(outcome.comment, photoUrl)));
  });

  app.post('/agencies/:agencyId/clients/:clientId/threads/:threadId/resolve', authenticated(resolveThreadDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const threadId = threadIdFromRoute(request);

    const outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const client = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (client === undefined) return { kind: 'not-found' } as const;
      if (client.status === 'archived') return { kind: 'archived' } as const;
      const thread = await loadThreadItem(transaction, { agencyId: tenant.agencyId, clientId, threadId });
      if (thread === undefined) return { kind: 'thread-not-found' } as const;
      if (thread.persona_id !== null) {
        const persona = await loadPersonaSubject(transaction, { agencyId: tenant.agencyId, clientId, personaId: thread.persona_id });
        if (persona?.status === 'archived') return { kind: 'persona-archived' } as const;
      }
      // False means it was already resolved: idempotent, the thread is returned unchanged.
      await resolveThread(transaction, { clientId, threadId, actorUserId: auth.userId });
      const resolved = await loadThreadItem(transaction, { agencyId: tenant.agencyId, clientId, threadId });
      if (resolved === undefined) return { kind: 'thread-not-found' } as const;
      return { kind: 'ok', thread: resolved } as const;
    });
    if (outcome.kind === 'not-found') throw clientNotFound();
    if (outcome.kind === 'archived') throw clientArchived();
    if (outcome.kind === 'thread-not-found') throw threadNotFound();
    if (outcome.kind === 'persona-archived') throw personaArchived();
    return reply.send(parseResponse(resolveThreadDocs.schemas.response, threadListItemFromRow(outcome.thread)));
  });
};
