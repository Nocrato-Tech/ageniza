import {
  AGENCY_SEARCH_TERM_MIN_LENGTH,
  AgencyPathParamsSchema,
  AgencySearchQuerySchema,
  AgencySearchResponseSchema,
  contentDeadline,
  contentIsScheduled,
  searchedCharacters,
  type AgencySearchClient,
  type AgencySearchContent,
  type AgencySearchFile,
  type AgencySearchResponse
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { sharedUserRateLimit } from '../../plugins/infra/rate-limit.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeParams, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import { isClientAvatarKey } from '../identity-storage/policy.js';
import type { IdentityStorageClient } from '../identity-storage/storage-client.js';
import { tenantHolds } from '../tenancy/guards.js';
import { termTooShort, translateDatabaseError } from './errors.js';
import { SEARCH_PERMISSIONS, SEARCH_RATE_BUCKET, SEARCH_RATE_LIMIT } from './policy.js';
import { searchAgency, type SearchAccess, type SearchClientRow, type SearchContentRow, type SearchFileRow } from './service.js';

export type SearchPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface SearchModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Injected from `tenancy`: the link with the agency is all the route asks for; each group then asks for its own permission. */
  readonly requireAgencyAccess: SearchPreHandler;
  /** Absent when identity storage is not configured; then every client's photo is null. */
  readonly identityStorage?: IdentityStorageClient;
  readonly photoUrlExpirySeconds: number;
  /** The instant "today" is read from; only a test sets it, and without it the day is the database's own. */
  readonly now?: () => Date;
}

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });
const agencyNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Agency not found.' });

const searchDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { params: AgencyPathParamsSchema, query: AgencySearchQuerySchema, response: AgencySearchResponseSchema }
} satisfies DocumentedRouteConfig;

const contentFrom = (row: SearchContentRow): AgencySearchContent => {
  const content = { status: row.status, publishOn: row.publish_on, publishAtTime: row.publish_at_time };
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    title: row.title,
    format: row.format,
    status: row.status,
    overdue: contentDeadline(content, row.today) === 'overdue',
    scheduled: contentIsScheduled(content, { day: row.today, time: row.local_time }),
    publishOn: row.publish_on
  };
};

const fileFrom = (row: SearchFileRow): AgencySearchFile => ({
  id: row.id,
  clientId: row.client_id,
  clientName: row.client_name,
  folderId: row.folder_id,
  name: row.file_name,
  category: row.category,
  thumbnailAssetId: row.thumbnail_asset_id
});

/**
 * Registers the search of the agency's top bar (specs/busca.md section 6): one read, in three groups. The route only reads, under the
 * policies and as the person; the agency comes from the guard and is repeated in every query. A group the person may not read is not
 * queried and comes back `[]`, the shape of a group with nothing found. The term is never logged: the request line is logged by its route
 * pattern, and a failure is logged by its code.
 */
export const registerSearchModule = (app: FastifyInstance, dependencies: SearchModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });
  // After the guards, so a request the guards refuse counts for nobody; one bucket per person across every agency.
  const limiter = sharedUserRateLimit(app, SEARCH_RATE_BUCKET, SEARCH_RATE_LIMIT);

  // The stored key is data, not proof: it is signed only when it is exactly an avatar key of this agency and client, the agency being the
  // one of the row (the id in the URL may be in capitals). A key that cannot be signed is a missing photo, not a 500, and the log carries
  // the code, never the key.
  const photoUrlOf = async (request: FastifyRequest, row: SearchClientRow): Promise<string | null> => {
    const storage = dependencies.identityStorage;
    if (row.photo_key === null || storage === undefined || !isClientAvatarKey(row.photo_key, row.agency_id, row.id)) return null;
    try {
      return await storage.presignGetObject({ key: row.photo_key, expiresInSeconds: dependencies.photoUrlExpirySeconds });
    } catch (error) {
      request.log.warn({
        error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'SEARCH_CLIENT_PHOTO_UNAVAILABLE' }
      }, 'Could not sign a client photo URL; serving the search without it');
      return null;
    }
  };

  app.get('/agencies/:agencyId/search', {
    preHandler: [requireSession, dependencies.requireAgencyAccess, limiter],
    config: searchDocs
  }, async (request, reply) => {
    const auth = request.auth;
    if (auth === undefined) throw unauthenticated();
    const tenant = request.tenant;
    if (tenant === undefined) throw agencyNotFound();
    routeParams(searchDocs, request);
    const { q } = routeQuery(searchDocs, request);
    // The schema measures what was typed; the minimum counts what is searched (the accents folded, the leading `@` dropped).
    if (searchedCharacters(q).length < AGENCY_SEARCH_TERM_MIN_LENGTH) throw termTooShort();

    const access: SearchAccess = {
      clients: tenantHolds(tenant, SEARCH_PERMISSIONS.clients),
      contents: tenantHolds(tenant, SEARCH_PERMISSIONS.contents),
      files: tenantHolds(tenant, SEARCH_PERMISSIONS.files)
    };

    let rows;
    try {
      rows = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
        searchAgency(transaction, { agencyId: tenant.agencyId, term: q, access, now: dependencies.now?.() })
      );
    } catch (error) {
      throw translateDatabaseError(error) ?? error;
    }

    const clients: AgencySearchClient[] = await Promise.all(rows.clients.map(async (row) => ({
      id: row.id,
      name: row.name,
      photoUrl: await photoUrlOf(request, row),
      instagramHandle: row.instagram_handle,
      archived: row.archived
    })));
    const body: AgencySearchResponse = { data: { clients, contents: rows.contents.map(contentFrom), files: rows.files.map(fileFrom) }, meta: { q } };
    return reply.send(routeResponse(searchDocs, request, body));
  });
};
