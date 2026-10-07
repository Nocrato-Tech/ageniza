import {
  ClientPathParamsSchema,
  PortalBrandStudyResponseSchema,
  PortalClientQuerySchema,
  PortalClientResponseSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { IdentityStorageClient } from '../identity-storage/storage-client.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import { createPhotoUrlSigner } from './photo-url.js';
import { loadPortalBrandStudy, loadPortalClient, loadPortalHome } from './portal-service.js';
import { clientFromRow } from './service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface PortalReadRouteDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly identityStorage?: IdentityStorageClient;
  readonly photoUrlExpirySeconds: number;
  /** Injected by the tenancy module: the active client link is the only authorization of the portal. */
  readonly requireClientAccess: PreHandler;
}

const clientNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Client not found.' });

/**
 * The portal's reads of its own client (#129): the registration and the Início summary, and the brand
 * study. Guarded by the client link alone, with no catalog permission, like every route under
 * `/clients/:clientId`; the client is always the one the guard proved and never a request value.
 */
export const registerPortalReadRoutes = (app: FastifyInstance, dependencies: PortalReadRouteDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const signPhotoUrl = createPhotoUrlSigner(dependencies, {
    code: 'PORTAL_CLIENT_PHOTO_URL_FAILED',
    message: 'Could not sign the client photo URL for the portal; returning null'
  });

  // Declared once per route: the same object is the documentation metadata and the source of the
  // schemas the handler validates with.
  const clientDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: ClientPathParamsSchema, query: PortalClientQuerySchema, response: PortalClientResponseSchema }
  } satisfies DocumentedRouteConfig;
  const brandStudyDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: ClientPathParamsSchema, query: PortalClientQuerySchema, response: PortalBrandStudyResponseSchema }
  } satisfies DocumentedRouteConfig;

  const portalGuards = (docs: DocumentedRouteConfig) => ({
    preHandler: [requireSession, dependencies.requireClientAccess],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  const portalContext = (request: FastifyRequest): NonNullable<FastifyRequest['clientContext']> => {
    const clientContext = request.clientContext;
    if (clientContext === undefined) throw clientNotFound();
    return clientContext;
  };

  app.get('/clients/:clientId', portalGuards(clientDocs), async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
    const clientContext = portalContext(request);
    routeQuery(clientDocs, request);

    const result = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const row = await loadPortalClient(transaction, { clientId: clientContext.clientId, clientMembershipId: clientContext.clientMembershipId });
      if (row === undefined) return undefined;
      return { row, home: await loadPortalHome(transaction, clientContext.clientId) };
    });
    if (result === undefined) throw clientNotFound();

    const photoUrl = await signPhotoUrl(request, result.row.photo_key);
    return reply.send(routeResponse(clientDocs, request, {
      ...clientFromRow(result.row, photoUrl),
      agencyName: result.row.agency_name,
      onboardingSeenAt: result.row.onboarding_seen_at === null ? null : new Date(result.row.onboarding_seen_at).toISOString(),
      home: result.home
    }));
  });

  app.get('/clients/:clientId/brand-study', portalGuards(brandStudyDocs), async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
    const clientContext = portalContext(request);
    routeQuery(brandStudyDocs, request);

    const study = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      loadPortalBrandStudy(transaction, clientContext.clientId));
    return reply.send(routeResponse(brandStudyDocs, request, study));
  });
};
