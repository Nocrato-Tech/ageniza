import {
  AcceptLegalDocumentRequestSchema,
  LegalAcceptancesResponseSchema
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeResponse } from '../../plugins/infra/zod.js';
import { acceptLegalDocument, loadLegalStatus, type CurrentLegalVersions } from './service.js';

export interface LegalModuleConfig {
  readonly authTermsVersion: string;
  readonly authPrivacyVersion: string;
}

export interface LegalModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly config: LegalModuleConfig;
}

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
  return auth;
};

/**
 * Registers the legal acceptance routes (issue #81): `GET /me/legal-acceptances` and
 * `POST /me/legal-acceptances`. Like the profile routes they are unscoped by agency and need no
 * module permission: the Terms and the Privacy Policy bind the account, not a tenant.
 *
 * The acceptance never takes a version from the request. The body names only the document, and the
 * version recorded is the one in force on this server, so a client cannot accept a version that is
 * not current. Acceptance is per document: accepting one never marks the other.
 */
export const registerLegalModule = (app: FastifyInstance, dependencies: LegalModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  const current: CurrentLegalVersions = {
    terms: dependencies.config.authTermsVersion,
    privacy: dependencies.config.authPrivacyVersion
  };

  const readDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { response: LegalAcceptancesResponseSchema }
  } satisfies DocumentedRouteConfig;
  const acceptDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { body: AcceptLegalDocumentRequestSchema, response: LegalAcceptancesResponseSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/me/legal-acceptances', { preHandler: requireSession, config: readDocs }, async (request, reply) => {
    const auth = requireAuth(request);
    const status = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      loadLegalStatus(transaction, auth.userId, current)
    );
    return reply.send(routeResponse(readDocs, request, status));
  });

  app.post('/me/legal-acceptances', { preHandler: requireSession, config: acceptDocs }, async (request, reply) => {
    const auth = requireAuth(request);
    const body = routeBody(acceptDocs, request);
    const status = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      await acceptLegalDocument(transaction, body.document, current);
      return loadLegalStatus(transaction, auth.userId, current);
    });
    return reply.send(routeResponse(acceptDocs, request, status));
  });
};
