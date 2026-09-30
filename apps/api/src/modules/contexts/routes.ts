import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  ClientPathParamsSchema,
  ContextResolveQuerySchema,
  ContextResolveResponseSchema,
  MeContextsResponseSchema,
  PutLastContextRequestSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { raw, withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';

import type { AuthInstance } from '../auth/better-auth.js';
import { applyAuthCookies, toAuthHeaders } from '../auth/bridge.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';
import { findPreferredContext, isValidAgencyContext, isValidClientContext, listValidContexts } from './service.js';

export type ContextPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface ContextModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Injected by the tenancy module so this module never duplicates client-access guard SQL. */
  readonly requireClientAccess: ContextPreHandler;
}

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });

const contextNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Context not found.' });

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

/**
 * Ends the current request's session (issue #68) by calling the same Better Auth `signOut`
 * `/auth/logout` uses, forwarding the request's own cookie so it revokes exactly that session.
 * Never throws: a failure here must not turn an otherwise-normal `decision: 'none'` response into
 * an unrelated 500, and the cleared cookie (when it succeeds) is applied to the reply either way.
 */
const endSessionForNoContext = async (auth: AuthInstance, request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  try {
    const { headers } = await auth.api.signOut({ headers: toAuthHeaders(request), returnHeaders: true });
    applyAuthCookies(reply, headers);
  } catch (error) {
    request.log.error({
      operation: 'contexts.resolve_no_context_end_session',
      status: 'failed',
      error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'RESOLVE_NO_CONTEXT_SESSION_END_FAILED' }
    }, 'Failed to end the session for a resolve that found zero contexts');
  }
};

/** Registers `/me/contexts*` and the client onboarding-seen route (issue #33). */
export const registerContextModule = (app: FastifyInstance, dependencies: ContextModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  // Declared once per route: the same object is the documentation metadata and the source of the
  // schemas the handler validates with.
  const listDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { response: MeContextsResponseSchema }
  } satisfies DocumentedRouteConfig;
  const resolveDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { query: ContextResolveQuerySchema, response: ContextResolveResponseSchema }
  } satisfies DocumentedRouteConfig;
  const lastContextDocs = {
    permission: null,
    responseStatus: 204,
    schemas: { body: PutLastContextRequestSchema }
  } satisfies DocumentedRouteConfig;
  const onboardingDocs = {
    permission: null,
    responseStatus: 204,
    schemas: { params: ClientPathParamsSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/me/contexts', { preHandler: requireSession, config: listDocs }, async (request, reply) => {
    const auth = requireAuth(request);
    const { contexts } = await withAuthenticatedUserTransaction(
      dependencies.database,
      auth.claims,
      (transaction) => listValidContexts(transaction)
    );
    return reply.send(parseResponse(listDocs.schemas.response, { contexts }));
  });

  app.get('/me/contexts/resolve', { preHandler: requireSession, config: resolveDocs }, async (request, reply) => {
    const auth = requireAuth(request);
    const query = parseRequest(resolveDocs.schemas.query, request.query);
    const { contexts, lastUsedContext } = await withAuthenticatedUserTransaction(
      dependencies.database,
      auth.claims,
      (transaction) => listValidContexts(transaction)
    );

    // Step 2: no valid context. Per the 2026-09-24 decision, this ends the session instead of
    // leaving the caller authenticated inside an app with nothing to do — the person who lost
    // their last context mid-use is signed out on the very next pass through `resolve`.
    if (contexts.length === 0) {
      await endSessionForNoContext(dependencies.auth, request, reply);
      return reply.send(parseResponse(resolveDocs.schemas.response, { decision: 'none' }));
    }
    // Step 3: exactly one valid context.
    if (contexts.length === 1) {
      return reply.send(parseResponse(resolveDocs.schemas.response, { decision: 'enter', context: contexts[0]! }));
    }
    // Step 4: an explicit, valid `preferred` context wins over the last-used preference. An
    // invalid/inaccessible `preferred` is ignored in silence and the algorithm falls through.
    const preferred = query.preferred === undefined ? undefined : findPreferredContext(contexts, query.preferred);
    if (preferred !== undefined) {
      return reply.send(parseResponse(resolveDocs.schemas.response, { decision: 'select', contexts, highlighted: preferred }));
    }
    // Step 5: the last-used context, if still valid.
    if (lastUsedContext !== null) {
      return reply.send(parseResponse(resolveDocs.schemas.response, { decision: 'enter', context: lastUsedContext }));
    }
    // Step 6: no signal to prefer any one context.
    return reply.send(parseResponse(resolveDocs.schemas.response, { decision: 'select', contexts, highlighted: null }));
  });

  app.put('/me/last-context', { preHandler: requireSession, config: lastContextDocs }, async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseRequest(lastContextDocs.schemas.body, request.body);

    await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const valid = body.type === 'agency'
        ? await isValidAgencyContext(transaction, body.agencyId)
        : await isValidClientContext(transaction, body.clientId);
      if (!valid) throw contextNotFound();

      await raw(transaction, `
        insert into public.user_context_preferences (user_id, context_type, agency_id, client_id, updated_at)
        values (app_private.current_user_id(), ?, ?::uuid, ?::uuid, now())
        on conflict (user_id) do update set
          context_type = excluded.context_type,
          agency_id = excluded.agency_id,
          client_id = excluded.client_id,
          updated_at = now()
      `, [
        body.type,
        body.type === 'agency' ? body.agencyId : null,
        body.type === 'client' ? body.clientId : null
      ]);
    });

    return reply.status(204).send();
  });

  app.post('/clients/:clientId/onboarding/seen', {
    preHandler: [requireSession, dependencies.requireClientAccess],
    config: onboardingDocs
  }, async (request, reply) => {
    const auth = requireAuth(request);
    const clientContext = request.clientContext;
    if (clientContext === undefined) throw contextNotFound();

    await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      // Idempotent by construction: only the first call (onboarding_seen_at is null) writes.
      await raw(transaction, `
        update public.client_memberships
        set onboarding_seen_at = now(), updated_at = now()
        where id = ?::uuid and onboarding_seen_at is null
      `, [clientContext.clientMembershipId]);
    });

    return reply.status(204).send();
  });
};
