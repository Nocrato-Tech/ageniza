import { randomUUID } from 'node:crypto';

import {
  AgencyClientPathParamsSchema,
  AgencyClientPersonaPathParamsSchema,
  AgencyClientSectionPathParamsSchema,
  AgencyPathParamsSchema,
  BrandStudyResponseSchema,
  BrandStudySectionSchema,
  BrandStudySectionUpdateRequestSchema,
  ClientDetailResponseSchema,
  ClientListQuerySchema,
  ClientListResponseSchema,
  ClientSchema,
  CreateClientRequestSchema,
  CreatePersonaRequestSchema,
  PersonaSchema,
  UpdateClientRequestSchema,
  UpdatePersonaRequestSchema,
  UploadClientPhotoRequestSchema,
  UploadClientPhotoResponseSchema,
  buildPaginationMetadata,
  resolvePagination,
  type BrandStudySectionUpdate,
  type ClientListItem,
  type WritableBrandSectionKey
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import { registerAccessRoutes } from './access-routes.js';
import { registerConversationRoutes } from './conversation-routes.js';
import { registerLifecycleRoutes } from './lifecycle-routes.js';
import { registerPortalReadRoutes } from './portal-routes.js';
import { buildClientAvatarKeyPrefix, isClientAvatarKey } from '../identity-storage/policy.js';
import {
  IdentityImageTooLargeError,
  IdentityImageTypeRejectedError,
  type IdentityStorageClient,
  type UploadedIdentityImage
} from '../identity-storage/storage-client.js';
import { createClientPhotoUrlSigner } from './photo-url.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import { CLIENT_PHOTO_RATE_LIMIT, clientPhotoBodyLimitBytes } from './policy.js';
import {
  brandSectionFromRow,
  brandStudyFromRows,
  clientFromRow,
  createClient,
  createPersona,
  isActiveClientNameConflict,
  isClientNoLongerActive,
  isRowLevelSecurityViolation,
  listClients,
  loadBrandSection,
  loadBrandSections,
  loadClient,
  loadClientSummary,
  loadPersona,
  loadPersonas,
  lockActiveClientPhoto,
  personaFromRow,
  setClientPhotoKey,
  setPersonaStatus,
  updateClient,
  updatePersona,
  upsertBrandSection,
  type ClientTransaction
} from './service.js';

export type ClientPreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;

export interface ClientModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  /** Absent when identity storage is not configured; then every photoUrl is null. */
  readonly identityStorage?: IdentityStorageClient;
  readonly photoUrlExpirySeconds: number;
  /** The identity storage size cap; the photo routes are registered only with storage configured. */
  readonly photoMaxImageBytes?: number;
  /** Injected by the tenancy module so this module never duplicates the agency-access guard. */
  readonly requireAgencyAccess: ClientPreHandler;
  /** Injected by the tenancy module; same named-permission rule the RLS policy enforces. */
  readonly requirePermission: (key: string) => ClientPreHandler;
  /** Injected by the tenancy module; the portal conversation routes are authorized by the client link alone. */
  readonly requireClientAccess: ClientPreHandler;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// specs/clientes.md §6: 20 per page. The route declares only the default; `resolvePagination`
// owns the global ceiling (100) and the offset.
const CLIENT_DEFAULT_PAGE_SIZE = 20;

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

const imageTooLarge = (): HttpError => new HttpError({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'The image exceeds the size limit.' });
const imageTypeRejected = (): HttpError => new HttpError({ statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'This image type is not accepted.' });

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

const personaNotFound = (): HttpError => new HttpError({ statusCode: 404, code: 'NOT_FOUND', message: 'Persona not found.' });

const sectionNotWritable = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path: 'sectionKey', code: 'invalid_enum_value', message: 'sectionKey must be one of the six writable sections.' }] }
});

const sectionShapeMismatch = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path: 'body', code: 'invalid_union', message: 'The body must match the section key.' }] }
});

const WRITABLE_SECTION_KEYS: ReadonlySet<string> = new Set(['branding', 'tone_of_voice', 'colors', 'positioning', 'archetype', 'observations']);
const TEXT_SECTION_KEYS: ReadonlySet<string> = new Set(['branding', 'tone_of_voice', 'positioning', 'observations']);

/** `personas` is a fixed section but not writable as one; anything else is not a section. Both are 400. */
const sectionKeyFromRoute = (request: FastifyRequest): WritableBrandSectionKey => {
  const value = (request.params as { readonly sectionKey?: unknown }).sectionKey;
  if (typeof value !== 'string' || !WRITABLE_SECTION_KEYS.has(value)) throw sectionNotWritable();
  return value as WritableBrandSectionKey;
};

/** A malformed `:personaId` is the same 404 as an absent one, never a 400. */
const personaIdFromRoute = (request: FastifyRequest): string => {
  const value = (request.params as { readonly personaId?: unknown }).personaId;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw personaNotFound();
  return value;
};

/** The body shape must match the section key: text, colors or archetype, never another's. */
const assertSectionShape = (sectionKey: WritableBrandSectionKey, body: BrandStudySectionUpdate): void => {
  const matches = TEXT_SECTION_KEYS.has(sectionKey)
    ? 'body' in body
    : sectionKey === 'colors' ? 'colors' in body : 'archetype' in body;
  if (!matches) throw sectionShapeMismatch();
};

export const registerClientModule = (app: FastifyInstance, dependencies: ClientModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  const signPhotoUrl = createClientPhotoUrlSigner(dependencies, {
    code: 'CLIENT_PHOTO_URL_FAILED',
    message: 'Could not sign the client photo URL; returning null'
  });

  const authenticated = (docs: DocumentedRouteConfig & { permission: string }) => ({
    preHandler: [requireSession, dependencies.requireAgencyAccess, dependencies.requirePermission(docs.permission)],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  // Declared once per route: the same object is the documentation metadata and the source of the
  // schemas the handler validates with, so a handler cannot drift from what is documented.
  const listDocs = {
    permission: 'cliente.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyPathParamsSchema, query: ClientListQuerySchema, response: ClientListResponseSchema }
  } satisfies DocumentedRouteConfig;
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
  const photoDocs = {
    permission: 'cliente.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, body: UploadClientPhotoRequestSchema, response: UploadClientPhotoResponseSchema }
  } satisfies DocumentedRouteConfig;
  const photoDeleteDocs = {
    permission: 'cliente.operar',
    responseStatus: 204,
    schemas: { params: AgencyClientPathParamsSchema }
  } satisfies DocumentedRouteConfig;
  const updateDocs = {
    permission: 'cliente.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, body: UpdateClientRequestSchema, response: ClientSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/agencies/:agencyId/clients', authenticated(listDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = request.tenant;
    if (tenant === undefined) throw clientNotFound();
    const query = routeQuery(listDocs, request);
    const pagination = resolvePagination(query, CLIENT_DEFAULT_PAGE_SIZE);

    const page = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
      listClients(transaction, tenant.agencyId, {
        status: query.status ?? 'active',
        search: query.search,
        sort: query.sort ?? 'attention',
        includePendingInvitations: tenant.isOwner || tenant.permissions.has('cliente.convidar_usuario')
      }, pagination));

    const data = await Promise.all(page.items.map(async (row): Promise<ClientListItem> => {
      const item: ClientListItem = {
        id: row.id,
        name: row.name,
        photoUrl: await signPhotoUrl(request, { agencyId: row.agency_id, clientId: row.id }, row.photo_key),
        instagramHandle: row.instagram_handle,
        status: row.status,
        closingDate: row.closing_date,
        threadsAwaitingAgency: Number(row.threads_awaiting_agency)
      };
      // Omitted, not zeroed, for a caller without `cliente.convidar_usuario` (issue #125).
      return row.pending_invitations === null ? item : { ...item, pendingInvitations: Number(row.pending_invitations) };
    }));

    return reply.send(routeResponse(listDocs, request, {
      data,
      meta: buildPaginationMetadata(pagination, page.totalItems)
    }));
  });

  app.post('/agencies/:agencyId/clients', authenticated(createDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const body = routeBody(createDocs, request);

    let row;
    try {
      row = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) =>
        createClient(transaction, { agencyId: tenant.agencyId, name: body.name }));
    } catch (error) {
      if (isActiveClientNameConflict(error)) throw clientNameInUse();
      throw error;
    }
    return reply.status(201).send(routeResponse(createDocs, request, clientFromRow(row, null)));
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

    const photoUrl = await signPhotoUrl(request, { agencyId: result.row.agency_id, clientId: result.row.id }, result.row.photo_key);
    return reply.send(routeResponse(detailDocs, request, {
      ...clientFromRow(result.row, photoUrl),
      summary: result.summary
    }));
  });

  app.patch('/agencies/:agencyId/clients/:clientId', authenticated(updateDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const body = routeBody(updateDocs, request);

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
    const photoUrl = await signPhotoUrl(request, { agencyId: outcome.row.agency_id, clientId: outcome.row.id }, outcome.row.photo_key);
    return reply.send(routeResponse(updateDocs, request, clientFromRow(outcome.row, photoUrl)));
  });

  const brandStudyDocs = {
    permission: 'cliente.visualizar',
    responseStatus: 200,
    schemas: { params: AgencyClientPathParamsSchema, response: BrandStudyResponseSchema }
  } satisfies DocumentedRouteConfig;
  const sectionDocs = {
    permission: 'cliente.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientSectionPathParamsSchema, body: BrandStudySectionUpdateRequestSchema, response: BrandStudySectionSchema }
  } satisfies DocumentedRouteConfig;
  const createPersonaDocs = {
    permission: 'cliente.operar',
    responseStatus: 201,
    schemas: { params: AgencyClientPathParamsSchema, body: CreatePersonaRequestSchema, response: PersonaSchema }
  } satisfies DocumentedRouteConfig;
  const updatePersonaDocs = {
    permission: 'cliente.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientPersonaPathParamsSchema, body: UpdatePersonaRequestSchema, response: PersonaSchema }
  } satisfies DocumentedRouteConfig;
  const personaStatusDocs = {
    permission: 'cliente.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientPersonaPathParamsSchema, response: PersonaSchema }
  } satisfies DocumentedRouteConfig;

  app.get('/agencies/:agencyId/clients/:clientId/brand-study', authenticated(brandStudyDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);

    const result = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const client = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (client === undefined) return undefined;
      // The detail summary already computes `filled`; reusing it keeps the two from diverging.
      const summary = await loadClientSummary(transaction, clientId);
      const sections = await loadBrandSections(transaction, { agencyId: tenant.agencyId, clientId });
      const personas = await loadPersonas(transaction, { agencyId: tenant.agencyId, clientId });
      return brandStudyFromRows(summary.brandStudyFilled, sections, personas);
    });
    if (result === undefined) throw clientNotFound();
    return reply.send(routeResponse(brandStudyDocs, request, result));
  });

  app.put('/agencies/:agencyId/clients/:clientId/brand-study/sections/:sectionKey', authenticated(sectionDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const sectionKey = sectionKeyFromRoute(request);
    const body = routeBody(sectionDocs, request);
    assertSectionShape(sectionKey, body);

    const outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const client = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (client === undefined) return { kind: 'not-found' } as const;
      if (client.status === 'archived') return { kind: 'archived' } as const;
      let written: boolean;
      try {
        written = await upsertBrandSection(transaction, { clientId, sectionKey, actorUserId: auth.userId, value: body });
      } catch (error) {
        if (isRowLevelSecurityViolation(error) || isClientNoLongerActive(error)) return { kind: 'archived' } as const;
        throw error;
      }
      if (!written) return { kind: 'archived' } as const;
      const row = await loadBrandSection(transaction, { agencyId: tenant.agencyId, clientId, sectionKey });
      if (row === undefined) return { kind: 'not-found' } as const;
      return { kind: 'ok', section: brandSectionFromRow(row, sectionKey) } as const;
    });
    if (outcome.kind === 'not-found') throw clientNotFound();
    if (outcome.kind === 'archived') throw clientArchived();
    return reply.send(routeResponse(sectionDocs, request, outcome.section));
  });

  app.post('/agencies/:agencyId/clients/:clientId/personas', authenticated(createPersonaDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const body = routeBody(createPersonaDocs, request);

    const outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const client = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (client === undefined) return { kind: 'not-found' } as const;
      if (client.status === 'archived') return { kind: 'archived' } as const;
      let personaId: string | undefined;
      try {
        personaId = await createPersona(transaction, { clientId, actorUserId: auth.userId, body });
      } catch (error) {
        if (isRowLevelSecurityViolation(error) || isClientNoLongerActive(error)) return { kind: 'archived' } as const;
        throw error;
      }
      if (personaId === undefined) return { kind: 'not-found' } as const;
      const persona = await loadPersona(transaction, { agencyId: tenant.agencyId, clientId, personaId });
      if (persona === undefined) return { kind: 'not-found' } as const;
      return { kind: 'ok', persona: personaFromRow(persona) } as const;
    });
    if (outcome.kind === 'not-found') throw clientNotFound();
    if (outcome.kind === 'archived') throw clientArchived();
    return reply.status(201).send(routeResponse(createPersonaDocs, request, outcome.persona));
  });

  app.patch('/agencies/:agencyId/clients/:clientId/personas/:personaId', authenticated(updatePersonaDocs), async (request, reply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const personaId = personaIdFromRoute(request);
    const body = routeBody(updatePersonaDocs, request);

    const outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const client = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (client === undefined) return { kind: 'not-found' } as const;
      if (client.status === 'archived') return { kind: 'archived' } as const;
      let updated: boolean;
      try {
        updated = await updatePersona(transaction, { clientId, personaId, actorUserId: auth.userId, changes: body });
      } catch (error) {
        if (isRowLevelSecurityViolation(error)) return { kind: 'archived' } as const;
        throw error;
      }
      if (!updated) return { kind: 'persona-not-found' } as const;
      const persona = await loadPersona(transaction, { agencyId: tenant.agencyId, clientId, personaId });
      if (persona === undefined) return { kind: 'persona-not-found' } as const;
      return { kind: 'ok', persona: personaFromRow(persona) } as const;
    });
    if (outcome.kind === 'not-found') throw clientNotFound();
    if (outcome.kind === 'archived') throw clientArchived();
    if (outcome.kind === 'persona-not-found') throw personaNotFound();
    return reply.send(routeResponse(updatePersonaDocs, request, outcome.persona));
  });

  const personaStatusHandler = (status: 'active' | 'archived') => async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = requireAuth(request);
    const tenant = requireTenant(request);
    const clientId = clientIdFromRoute(request);
    const personaId = personaIdFromRoute(request);

    const outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
      const client = await loadClient(transaction, { agencyId: tenant.agencyId, clientId });
      if (client === undefined) return { kind: 'not-found' } as const;
      if (client.status === 'archived') return { kind: 'archived' } as const;
      let updated: boolean;
      try {
        updated = await setPersonaStatus(transaction, { clientId, personaId, actorUserId: auth.userId, status });
      } catch (error) {
        if (isRowLevelSecurityViolation(error)) return { kind: 'archived' } as const;
        throw error;
      }
      if (!updated) return { kind: 'persona-not-found' } as const;
      const persona = await loadPersona(transaction, { agencyId: tenant.agencyId, clientId, personaId });
      if (persona === undefined) return { kind: 'persona-not-found' } as const;
      return { kind: 'ok', persona: personaFromRow(persona) } as const;
    });
    if (outcome.kind === 'not-found') throw clientNotFound();
    if (outcome.kind === 'archived') throw clientArchived();
    if (outcome.kind === 'persona-not-found') throw personaNotFound();
    return reply.send(routeResponse(personaStatusDocs, request, outcome.persona));
  };

  app.post('/agencies/:agencyId/clients/:clientId/personas/:personaId/archive', authenticated(personaStatusDocs), personaStatusHandler('archived'));
  app.post('/agencies/:agencyId/clients/:clientId/personas/:personaId/unarchive', authenticated(personaStatusDocs), personaStatusHandler('active'));

  registerConversationRoutes(app, dependencies);
  registerPortalReadRoutes(app, dependencies);
  registerAccessRoutes(app, dependencies);
  registerLifecycleRoutes(app, dependencies);

  const identityStorage = dependencies.identityStorage;
  if (identityStorage !== undefined) {
    const maxImageBytes = dependencies.photoMaxImageBytes;
    if (maxImageBytes === undefined) throw new Error('photoMaxImageBytes is required when identity storage is configured.');

    /** Why a photo write found no active client to lock: the one 404 for absent/other-agency, or the archived 409. */
    const photoTargetRefused = async (transaction: ClientTransaction, agencyId: string, clientId: string): Promise<HttpError> =>
      await loadClient(transaction, { agencyId, clientId }) === undefined ? clientNotFound() : clientArchived();

    // An object is only ever deleted when its key still lies inside this client's own directory: the
    // reference is data in a table, and a key naming someone else's object must not become a delete
    // primitive.
    const deleteOwnObject = async (
      request: FastifyRequest,
      key: string | null,
      scope: { readonly agencyId: string; readonly clientId: string },
      code: string
    ): Promise<void> => {
      if (key === null) return;
      if (!isClientAvatarKey(key, scope.agencyId, scope.clientId)) {
        request.log.warn({ error: { name: 'ForeignPhotoKey', code } }, 'Refused to delete a client photo key outside the client directory');
        return;
      }
      await identityStorage.deleteObject({ key }).catch((cleanupError: unknown) => {
        request.log.warn({
          error: { name: cleanupError instanceof Error ? cleanupError.name : 'UnknownError', code }
        }, 'Failed to remove a client photo object that is no longer referenced');
      });
    };

    // Keyed by the session user, not the IP: identity storage has no quota, so the ceiling follows
    // the account. `hook: 'preHandler'` runs after the guards, so `request.auth` is populated.
    const photoRateLimit = {
      rateLimit: {
        max: CLIENT_PHOTO_RATE_LIMIT.max,
        timeWindow: CLIENT_PHOTO_RATE_LIMIT.windowMs,
        hook: 'preHandler' as const,
        keyGenerator: (request: FastifyRequest) => request.auth?.userId ?? request.ip
      }
    };

    const photoRoute = authenticated(photoDocs);
    app.put('/agencies/:agencyId/clients/:clientId/photo', {
      ...photoRoute,
      // Own limit, sized for base64/JSON overhead; the global body limit is not raised for this route.
      bodyLimit: clientPhotoBodyLimitBytes(maxImageBytes),
      config: { ...photoRoute.config, ...photoRateLimit }
    }, async (request, reply) => {
      const auth = requireAuth(request);
      const tenant = requireTenant(request);
      const clientId = clientIdFromRoute(request);
      const body = routeBody(photoDocs, request);
      const scope = { agencyId: tenant.agencyId, clientId };

      // Refuse an absent or archived client before anything is written to the bucket.
      const target = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, (transaction) => loadClient(transaction, scope));
      if (target === undefined) throw clientNotFound();
      if (target.status === 'archived') throw clientArchived();

      let uploaded: UploadedIdentityImage;
      try {
        uploaded = await identityStorage.uploadIdentityImage({
          keyPrefix: buildClientAvatarKeyPrefix(tenant.agencyId, clientId, randomUUID()),
          body: Buffer.from(body.imageBase64, 'base64')
        });
      } catch (error) {
        if (error instanceof IdentityImageTooLargeError) throw imageTooLarge();
        if (error instanceof IdentityImageTypeRejectedError) throw imageTypeRejected();
        throw error;
      }

      // Commit the new key first, reading the previous one under the row lock (issue #100's protocol).
      let outcome: { readonly previousKey: string | null } | { readonly refused: HttpError };
      try {
        outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
          const locked = await lockActiveClientPhoto(transaction, scope);
          if (locked === undefined) return { refused: await photoTargetRefused(transaction, tenant.agencyId, clientId) };
          await setClientPhotoKey(transaction, { ...scope, actorUserId: auth.userId, photoKey: uploaded.key });
          return { previousKey: locked.photoKey };
        });
      } catch (error) {
        await deleteOwnObject(request, uploaded.key, scope, 'CLIENT_PHOTO_CLEANUP_FAILED');
        throw error;
      }
      if ('refused' in outcome) {
        // The client was archived (or vanished) between the pre-check and the commit.
        await deleteOwnObject(request, uploaded.key, scope, 'CLIENT_PHOTO_CLEANUP_FAILED');
        throw outcome.refused;
      }

      await deleteOwnObject(request, outcome.previousKey, scope, 'CLIENT_PHOTO_PREVIOUS_CLEANUP_FAILED');
      const photoUrl = await identityStorage.presignGetObject({ key: uploaded.key, expiresInSeconds: dependencies.photoUrlExpirySeconds });
      return reply.send(routeResponse(photoDocs, request, { photoUrl }));
    });

    app.delete('/agencies/:agencyId/clients/:clientId/photo', authenticated(photoDeleteDocs), async (request, reply) => {
      const auth = requireAuth(request);
      const tenant = requireTenant(request);
      const clientId = clientIdFromRoute(request);
      const scope = { agencyId: tenant.agencyId, clientId };

      const outcome = await withAuthenticatedUserTransaction(dependencies.database, auth.claims, async (transaction) => {
        const locked = await lockActiveClientPhoto(transaction, scope);
        if (locked === undefined) throw await photoTargetRefused(transaction, tenant.agencyId, clientId);
        if (locked.photoKey !== null) await setClientPhotoKey(transaction, { ...scope, actorUserId: auth.userId, photoKey: null });
        return { previousKey: locked.photoKey };
      });

      await deleteOwnObject(request, outcome.previousKey, scope, 'CLIENT_PHOTO_PREVIOUS_CLEANUP_FAILED');
      return reply.status(204).send();
    });
  }

};
