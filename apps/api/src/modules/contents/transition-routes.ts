import {
  AgencyClientContentPathParamsSchema,
  ApproveContentByAgencyRequestSchema,
  ContentDetailSchema,
  PublishContentRequestSchema,
  RescheduleContentRequestSchema,
  type ContentDetail
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { databaseErrorCode, withAuthenticatedUserTransaction } from '@ageniza/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z, ZodTypeAny } from 'zod';

import { createRequireSession } from '../auth/session-guard.js';
import { isInsufficientPrivilegeError } from '../tenancy/guards.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeResponse } from '../../plugins/infra/zod.js';
import { clientArchived, clientNotFound, contentNotFound, forbidden, unauthenticated } from './errors.js';
import { CONTENT_READ_PERMISSION } from './policy.js';
import type { ContentModuleDependencies } from './routes.js';
import { loadClientStatus, loadContent, loadContentDetail, type ContentTransaction } from './service.js';
import { mediaNotComplete, mediaNotConfirmed, translateTransitionError, type TransitionAction } from './transition-errors.js';
import {
  approveContentByAgency,
  cancelContent,
  hasUnconfirmedMedia,
  publishContent,
  rescheduleContent,
  saoPauloDay,
  submitContent,
  unpublishContent
} from './transition-service.js';

type Scope = { readonly agencyId: string; readonly clientId: string };
type TransitionDocs = DocumentedRouteConfig & { permission: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A malformed id is the same 404 as an absent one, never a 400 that confirms the route. */
const idFromRoute = (request: FastifyRequest, name: 'clientId' | 'contentId', notFound: () => HttpError): string => {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw notFound();
  return value;
};

/** A body that was not sent is an empty one; one that was sent is validated by the schema the route declares. */
const bodyOrEmpty = <TSchema extends ZodTypeAny>(docs: { readonly schemas: { readonly body: TSchema } }, request: FastifyRequest): z.output<TSchema> => {
  if (request.body === undefined) request.body = {};
  return routeBody(docs, request);
};

/**
 * The six moves of a content the agency makes (#256, specs/conteudo.md sections 4 and 6). The state, who approved and
 * when are the database's: each route checks nothing the function it calls checks, translates what it refuses, and
 * answers the content read back. The client is the one of the URL and the content must be its own, or both are the same 404.
 */
export const registerContentTransitionRoutes = (app: FastifyInstance, dependencies: ContentModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const now = dependencies.now ?? ((): Date => new Date());

  // The same object is the documentation metadata and the source of the schemas the handler validates with.
  const submitDocs = {
    permission: 'conteudo.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientContentPathParamsSchema, response: ContentDetailSchema }
  } satisfies DocumentedRouteConfig;
  const approveDocs = {
    permission: 'conteudo.aprovar_pela_agencia',
    responseStatus: 200,
    schemas: { params: AgencyClientContentPathParamsSchema, body: ApproveContentByAgencyRequestSchema, response: ContentDetailSchema }
  } satisfies DocumentedRouteConfig;
  const publishDocs = {
    permission: 'conteudo.publicar',
    responseStatus: 200,
    schemas: { params: AgencyClientContentPathParamsSchema, body: PublishContentRequestSchema, response: ContentDetailSchema }
  } satisfies DocumentedRouteConfig;
  const unpublishDocs = {
    permission: 'conteudo.publicar',
    responseStatus: 200,
    schemas: { params: AgencyClientContentPathParamsSchema, response: ContentDetailSchema }
  } satisfies DocumentedRouteConfig;
  const cancelDocs = {
    permission: 'conteudo.cancelar',
    responseStatus: 200,
    schemas: { params: AgencyClientContentPathParamsSchema, response: ContentDetailSchema }
  } satisfies DocumentedRouteConfig;
  const rescheduleDocs = {
    permission: 'conteudo.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientContentPathParamsSchema, body: RescheduleContentRequestSchema, response: ContentDetailSchema }
  } satisfies DocumentedRouteConfig;

  // A write also needs to read: the policy asks for both, and a person who only acts would fail it late and in the database.
  const guards = (docs: TransitionDocs) => ({
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requirePermission(docs.permission),
      dependencies.requirePermission(CONTENT_READ_PERMISSION)
    ],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  const claimsOf = (request: FastifyRequest) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    return auth.claims;
  };

  /**
   * Why a function the checks before it let through was refused by the row-level policy: the client was archived in the
   * meantime (409) or this person lost the permission (403). Runs in a new transaction, because the one refused is aborted.
   */
  const diagnoseRefusal = async (request: FastifyRequest, scope: Scope): Promise<HttpError> => {
    const status = await withAuthenticatedUserTransaction(dependencies.database, claimsOf(request), (transaction) => loadClientStatus(transaction, scope));
    if (status === undefined) return clientNotFound();
    return status === 'archived' ? clientArchived() : forbidden();
  };

  /** `A0065` is a media that is missing and a media that is still uploading: only the second is told apart by its own code. */
  const diagnoseMedia = async (request: FastifyRequest, contentId: string): Promise<HttpError> => {
    const pending = await withAuthenticatedUserTransaction(dependencies.database, claimsOf(request), (transaction) => hasUnconfirmedMedia(transaction, contentId));
    return pending ? mediaNotConfirmed() : mediaNotComplete();
  };

  const write = async (
    request: FastifyRequest,
    scope: Scope,
    contentId: string,
    action: TransitionAction,
    work: (transaction: ContentTransaction) => Promise<ContentDetail>
  ): Promise<ContentDetail> => {
    try {
      return await withAuthenticatedUserTransaction(dependencies.database, claimsOf(request), work);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (databaseErrorCode(error) === 'A0065') throw await diagnoseMedia(request, contentId);
      const translated = translateTransitionError(error, action);
      if (translated !== undefined) throw translated;
      if (isInsufficientPrivilegeError(error)) throw await diagnoseRefusal(request, scope);
      throw error;
    }
  };

  const register = <TDocs extends TransitionDocs & { schemas: { response: typeof ContentDetailSchema } }, TBody>(
    segment: string,
    docs: TDocs,
    action: TransitionAction,
    handler: {
      readonly body: (request: FastifyRequest) => TBody;
      readonly run: (transaction: ContentTransaction, input: { readonly contentId: string; readonly body: TBody }) => Promise<void>;
    }
  ): void => {
    app.post(`/agencies/:agencyId/clients/:clientId/contents/:contentId/${segment}`, guards(docs), async (request, reply) => {
      const tenant = request.tenant;
      if (tenant === undefined) throw clientNotFound();
      const clientId = idFromRoute(request, 'clientId', clientNotFound);
      const contentId = idFromRoute(request, 'contentId', contentNotFound);
      const body = handler.body(request);
      const scope = { agencyId: tenant.agencyId, clientId };

      const detail = await write(request, scope, contentId, action, async (transaction) => {
        // The content of this client, as this person reads it. Whether they may move it, and the state of the client, are
        // judged by the function after its own locks, so the client is read after the last wait and never before it.
        if (await loadClientStatus(transaction, scope) === undefined) throw clientNotFound();
        if (await loadContent(transaction, { clientId, contentId }) === undefined) throw contentNotFound();
        await handler.run(transaction, { contentId, body });
        const row = await loadContent(transaction, { clientId, contentId });
        if (row === undefined) throw new Error('The content just moved could not be read back.');
        return loadContentDetail(transaction, row);
      });
      return reply.send(routeResponse(docs, request, detail));
    });
  };

  const noBody = (): undefined => undefined;

  register('submit', submitDocs, 'submit', {
    body: noBody,
    run: (transaction, { contentId }) => submitContent(transaction, contentId)
  });

  register('approve-by-agency', approveDocs, 'approve-by-agency', {
    body: (request) => routeBody(approveDocs, request),
    run: async (transaction, { contentId, body }) => {
      await approveContentByAgency(transaction, { contentId, revision: body.revision, reason: body.reason });
      // The function does not read the media: a content whose media has not finished uploading is never approved here,
      // and the whole transaction is undone by the throw.
      if (await hasUnconfirmedMedia(transaction, contentId)) throw mediaNotConfirmed();
    }
  });

  register('publish', publishDocs, 'publish', {
    body: (request) => bodyOrEmpty(publishDocs, request),
    run: async (transaction, { contentId, body }) => {
      const publishedOn = body.publishedOn ?? await saoPauloDay(transaction, now());
      await publishContent(transaction, { contentId, publishedOn });
    }
  });

  register('unpublish', unpublishDocs, 'unpublish', {
    body: noBody,
    run: (transaction, { contentId }) => unpublishContent(transaction, contentId)
  });

  register('cancel', cancelDocs, 'cancel', {
    body: noBody,
    run: (transaction, { contentId }) => cancelContent(transaction, contentId)
  });

  register('reschedule', rescheduleDocs, 'reschedule', {
    body: (request) => bodyOrEmpty(rescheduleDocs, request),
    run: (transaction, { contentId, body }) => rescheduleContent(transaction, { contentId, publishOn: body.publishOn })
  });
};
