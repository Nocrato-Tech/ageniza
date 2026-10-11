import {
  AgencyClientPathParamsSchema,
  AgencyClientStoryScriptPathParamsSchema,
  ClientPathParamsSchema,
  ClientStoryScriptPathParamsSchema,
  CreateStoryScriptRequestSchema,
  PortalStoryScriptPeriodResponseSchema,
  PortalStoryScriptSchema,
  STORY_SCRIPT_PERIOD_MAX_ITEMS,
  StoryScriptPeriodQuerySchema,
  StoryScriptSchema,
  UpdateStoryScriptRequestSchema,
  storyScriptPeriodIssues,
  type PortalStoryScript,
  type StoryScript,
  type UpdateStoryScriptRequest
} from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';
import { withAuthenticatedUserTransaction, type DatabaseClient, type VerifiedUserClaims } from '@ageniza/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthInstance } from '../auth/better-auth.js';
import { createRequireSession } from '../auth/session-guard.js';
import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { routeBody, routeParams, routeQuery, routeResponse } from '../../plugins/infra/zod.js';
import { isInsufficientPrivilegeError } from '../tenancy/guards.js';
import {
  clientArchived,
  clientNotFound,
  forbidden,
  scenesMismatch,
  scriptNotFound,
  scriptState,
  translateDatabaseError,
  type Operation
} from './errors.js';
import {
  clientScopeOf,
  insertScenes,
  insertScript,
  listPortalScripts,
  loadAgencyScript,
  loadPortalScript,
  loadSceneIds,
  lockScript,
  portalAccessHolds,
  recordScript,
  sendScript,
  updateScenes,
  updateScriptDay,
  type SceneRow,
  type ScriptRow
} from './service.js';

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => void | Promise<void>;
type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

export interface StoryScriptModuleDependencies {
  readonly database: DatabaseClient;
  readonly auth: AuthInstance;
  readonly requireAgencyAccess: PreHandler;
  readonly requirePermission: (key: string) => PreHandler;
  /** Injected by the tenancy module: the active client link is the only authorization of the portal. */
  readonly requireClientAccess: PreHandler;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const unauthenticated = (): HttpError => new HttpError({ statusCode: 401, code: 'UNAUTHENTICATED', message: 'Authentication is required.' });

const requireAuth = (request: FastifyRequest): NonNullable<FastifyRequest['auth']> => {
  const auth = request.auth;
  if (auth === undefined) throw unauthenticated();
  return auth;
};

/** A malformed id is the same 404 as an absent one, never a 400 that confirms the route exists. */
const uuidFromRoute = (request: FastifyRequest, name: string, notFound: () => HttpError): string => {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw notFound();
  return value;
};

const sceneFrom = (row: SceneRow): StoryScript['scenes'][number] => ({ id: row.id, position: row.position, text: row.text, guidance: row.guidance });

const recordedByFrom = (row: ScriptRow): { readonly name: string | null } | null => (row.has_recorder ? { name: row.recorded_by_name } : null);

const recordedAtFrom = (row: ScriptRow): string | null => (row.recorded_at === null ? null : new Date(row.recorded_at).toISOString());

const agencyScriptFrom = (row: ScriptRow): StoryScript => ({
  id: row.id,
  scriptOn: row.script_on,
  status: row.status,
  scenes: row.scenes.map(sceneFrom),
  recordedBy: recordedByFrom(row),
  recordedAt: recordedAtFrom(row),
  createdAt: new Date(row.created_at).toISOString()
});

/** The portal never receives a draft: one that reaches this point is a bug of the query, not something to show. */
const portalScriptFrom = (row: ScriptRow): PortalStoryScript => {
  if (row.status === 'draft') throw new Error('A draft story script reached the portal response.');
  return {
    id: row.id,
    scriptOn: row.script_on,
    status: row.status,
    scenes: row.scenes.map((scene) => ({ position: scene.position, text: scene.text, guidance: scene.guidance })),
    recordedBy: recordedByFrom(row),
    recordedAt: recordedAtFrom(row)
  };
};

const periodTooLarge = (): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path: 'to', code: 'custom', message: `the period has more than ${STORY_SCRIPT_PERIOD_MAX_ITEMS} items` }] }
});

/**
 * The story scripts of a client (#258, specs/conteudo.md section 6). The agency writes and sends them under
 * `conteudo.operar` and `conteudo.visualizar`, both needed because a write that cannot read its own row is a blind
 * one; the portal reads what was sent for a period and marks it recorded, guarded by the client link alone. The
 * transitions are the database's (`send_story_script`, `record_story_script`); the routes decide what each side
 * is told, and the client is always the one of the URL, proved by the guard on the portal side.
 */
export const registerStoryScriptModule = (app: FastifyInstance, dependencies: StoryScriptModuleDependencies): void => {
  const requireSession = createRequireSession({ auth: dependencies.auth });

  // Declared once per route: the same object is the documentation metadata and the source of the schemas the handler validates with.
  const createDocs = {
    permission: 'conteudo.operar',
    responseStatus: 201,
    schemas: { params: AgencyClientPathParamsSchema, body: CreateStoryScriptRequestSchema, response: StoryScriptSchema }
  } satisfies DocumentedRouteConfig;
  const updateDocs = {
    permission: 'conteudo.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientStoryScriptPathParamsSchema, body: UpdateStoryScriptRequestSchema, response: StoryScriptSchema }
  } satisfies DocumentedRouteConfig;
  const sendDocs = {
    permission: 'conteudo.operar',
    responseStatus: 200,
    schemas: { params: AgencyClientStoryScriptPathParamsSchema, response: StoryScriptSchema }
  } satisfies DocumentedRouteConfig;
  const listDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: ClientPathParamsSchema, query: StoryScriptPeriodQuerySchema, response: PortalStoryScriptPeriodResponseSchema }
  } satisfies DocumentedRouteConfig;
  const recordedDocs = {
    permission: null,
    responseStatus: 200,
    schemas: { params: ClientStoryScriptPathParamsSchema, response: PortalStoryScriptSchema }
  } satisfies DocumentedRouteConfig;

  /** A write of the agency needs both keys: with `conteudo.operar` alone the role would write what it cannot read. */
  const agencyGuards = (docs: DocumentedRouteConfig & { permission: string }) => ({
    preHandler: [
      requireSession,
      dependencies.requireAgencyAccess,
      dependencies.requirePermission(docs.permission),
      dependencies.requirePermission('conteudo.visualizar')
    ],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });
  const portalGuards = (docs: DocumentedRouteConfig) => ({
    preHandler: [requireSession, dependencies.requireClientAccess],
    config: { permission: docs.permission, responseStatus: docs.responseStatus, schemas: docs.schemas }
  });

  const agencyIdOf = (request: FastifyRequest): string => {
    const tenant = request.tenant;
    if (tenant === undefined) throw clientNotFound();
    return tenant.agencyId;
  };

  const portalClientIdOf = (request: FastifyRequest): string => {
    const clientContext = request.clientContext;
    if (clientContext === undefined) throw clientNotFound();
    return clientContext.clientId;
  };

  const inTransaction = <TResult>(claims: VerifiedUserClaims, work: (transaction: Transaction) => Promise<TResult>): Promise<TResult> =>
    withAuthenticatedUserTransaction(dependencies.database, claims, work);

  /**
   * A refusal by the row-level security after the route read the client as open means the archive of the client
   * committed between that read and the statement. The failed transaction is aborted, so the client is read again
   * in a new one: archived is the 409 the archive earned, and only an open client means the caller lacks the right.
   */
  const explainAgencyRefusal = async (claims: VerifiedUserClaims, agencyId: string, clientId: string): Promise<HttpError> => {
    const scope = await inTransaction(claims, (transaction) => clientScopeOf(transaction, agencyId, clientId));
    if (scope === 'archived') return clientArchived();
    if (scope === 'not-found') return clientNotFound();
    return forbidden();
  };

  /** The portal never learns that a client is archived: a person who lost the link is "not found", anyone else is refused. */
  const explainPortalRefusal = async (claims: VerifiedUserClaims, clientId: string): Promise<HttpError> =>
    (await inTransaction(claims, (transaction) => portalAccessHolds(transaction, clientId))) ? forbidden() : clientNotFound();

  const agencyWrite = async <TResult>(
    request: FastifyRequest,
    operation: Operation,
    scope: { readonly agencyId: string; readonly clientId: string },
    work: (transaction: Transaction) => Promise<TResult>
  ): Promise<TResult> => {
    const { claims } = requireAuth(request);
    try {
      return await inTransaction(claims, work);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const translated = translateDatabaseError(error, 'agency', operation);
      if (translated !== undefined) throw translated;
      if (isInsufficientPrivilegeError(error)) throw await explainAgencyRefusal(claims, scope.agencyId, scope.clientId);
      throw error;
    }
  };

  const portalWrite = async <TResult>(
    request: FastifyRequest,
    clientId: string,
    work: (transaction: Transaction) => Promise<TResult>
  ): Promise<TResult> => {
    const { claims } = requireAuth(request);
    try {
      return await inTransaction(claims, work);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const translated = translateDatabaseError(error, 'portal', 'record');
      if (translated !== undefined) throw translated;
      if (isInsufficientPrivilegeError(error)) throw await explainPortalRefusal(claims, clientId);
      throw error;
    }
  };

  /**
   * The scenes of an edit are the whole script in its new order. A scene is never removed, so the ids given must be
   * exactly the ones the script has; a scene without an id is a new one. A stale list (another operator added a
   * scene meanwhile) is a 409, and so is an id of another script, which must not say that it exists.
   */
  const rewriteScenes = async (
    transaction: Transaction,
    script: { readonly id: string; readonly clientId: string },
    scenes: NonNullable<UpdateStoryScriptRequest['scenes']>
  ): Promise<void> => {
    const existing = await loadSceneIds(transaction, script.id);
    const given = scenes.flatMap((scene) => (scene.id === undefined ? [] : [scene.id]));
    const known = new Set(existing);
    if (given.some((id) => !known.has(id)) || existing.some((id) => !given.includes(id))) throw scenesMismatch();

    const placed = scenes.map((scene, index) => ({ id: scene.id, position: index + 1, text: scene.text, guidance: scene.guidance }));
    await updateScenes(transaction, script.id, placed.flatMap((scene) => (scene.id === undefined ? [] : [{ ...scene, id: scene.id }])));
    await insertScenes(transaction, script, placed.filter((scene) => scene.id === undefined));
  };

  const reload = async (transaction: Transaction, clientId: string, scriptId: string): Promise<ScriptRow> => {
    const row = await loadAgencyScript(transaction, clientId, scriptId);
    if (row === undefined) throw new Error('The story script that was just written could not be read back.');
    return row;
  };

  // --- The agency ------------------------------------------------------------------------------

  app.post('/agencies/:agencyId/clients/:clientId/story-scripts', agencyGuards(createDocs), async (request, reply) => {
    const agencyId = agencyIdOf(request);
    const clientId = uuidFromRoute(request, 'clientId', clientNotFound);
    routeParams(createDocs, request);
    const body = routeBody(createDocs, request);

    const row = await agencyWrite(request, 'edit', { agencyId, clientId }, async (transaction) => {
      const scope = await clientScopeOf(transaction, agencyId, clientId);
      if (scope === 'not-found') throw clientNotFound();
      if (scope === 'archived') throw clientArchived();
      const scriptId = await insertScript(transaction, { clientId, scriptOn: body.scriptOn });
      await insertScenes(transaction, { id: scriptId, clientId }, body.scenes.map((scene, index) => ({ position: index + 1, text: scene.text, guidance: scene.guidance })));
      return reload(transaction, clientId, scriptId);
    });

    return reply.status(201).send(routeResponse(createDocs, request, agencyScriptFrom(row)));
  });

  app.patch('/agencies/:agencyId/clients/:clientId/story-scripts/:scriptId', agencyGuards(updateDocs), async (request, reply) => {
    const agencyId = agencyIdOf(request);
    const clientId = uuidFromRoute(request, 'clientId', clientNotFound);
    const scriptId = uuidFromRoute(request, 'scriptId', scriptNotFound);
    routeParams(updateDocs, request);
    const body = routeBody(updateDocs, request);

    const row = await agencyWrite(request, 'edit', { agencyId, clientId }, async (transaction) => {
      // The script is locked BEFORE the client is read: an archive that commits while this request waits for the
      // lock is then seen by the read, as the 409 it is, and not by the statement as a refusal of the policy.
      const locked = await lockScript(transaction, clientId, scriptId);
      const scope = await clientScopeOf(transaction, agencyId, clientId);
      if (scope === 'not-found') throw clientNotFound();
      if (locked === undefined) throw scriptNotFound();
      if (scope === 'archived') throw clientArchived();
      if (locked.status !== 'draft') throw scriptState('edit');

      if (body.scenes !== undefined) await rewriteScenes(transaction, { id: scriptId, clientId }, body.scenes);
      if (body.scriptOn !== undefined) await updateScriptDay(transaction, scriptId, body.scriptOn);
      return reload(transaction, clientId, scriptId);
    });

    return reply.send(routeResponse(updateDocs, request, agencyScriptFrom(row)));
  });

  app.post('/agencies/:agencyId/clients/:clientId/story-scripts/:scriptId/send', agencyGuards(sendDocs), async (request, reply) => {
    const agencyId = agencyIdOf(request);
    const clientId = uuidFromRoute(request, 'clientId', clientNotFound);
    const scriptId = uuidFromRoute(request, 'scriptId', scriptNotFound);
    routeParams(sendDocs, request);

    const row = await agencyWrite(request, 'send', { agencyId, clientId }, async (transaction) => {
      // The script of this client, as the agency reads it; whether the caller may send it, and the state of the
      // client, are judged by the function after its own lock.
      if (await loadAgencyScript(transaction, clientId, scriptId) === undefined) {
        throw (await clientScopeOf(transaction, agencyId, clientId)) === 'not-found' ? clientNotFound() : scriptNotFound();
      }
      await sendScript(transaction, scriptId);
      return reload(transaction, clientId, scriptId);
    });

    return reply.send(routeResponse(sendDocs, request, agencyScriptFrom(row)));
  });

  // --- The portal --------------------------------------------------------------------------------

  app.get('/clients/:clientId/story-scripts', portalGuards(listDocs), async (request, reply) => {
    const { claims } = requireAuth(request);
    const clientId = portalClientIdOf(request);
    routeParams(listDocs, request);
    const query = routeQuery(listDocs, request);
    const issues = storyScriptPeriodIssues(query);
    if (issues.length > 0) {
      throw new HttpError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { issues: issues.map((issue) => ({ path: issue.path, code: 'custom', message: issue.message })) }
      });
    }

    const rows = await inTransaction(claims, (transaction) => listPortalScripts(transaction, clientId, query, STORY_SCRIPT_PERIOD_MAX_ITEMS + 1));
    if (rows.length > STORY_SCRIPT_PERIOD_MAX_ITEMS) throw periodTooLarge();

    return reply.send(routeResponse(listDocs, request, {
      data: rows.map(portalScriptFrom),
      meta: { from: query.from, to: query.to, count: rows.length }
    }));
  });

  app.post('/clients/:clientId/story-scripts/:scriptId/recorded', portalGuards(recordedDocs), async (request, reply) => {
    const clientId = portalClientIdOf(request);
    const scriptId = uuidFromRoute(request, 'scriptId', scriptNotFound);
    routeParams(recordedDocs, request);

    const row = await portalWrite(request, clientId, async (transaction) => {
      // What the portal may record is what it may read: a sent or recorded script of THIS client, by the portal's
      // own SQL. A draft, another client's script and an absent one are the same 404, even for a collaborator
      // whose agency role reads drafts, and the function never sees an id the portal could not read.
      if (await loadPortalScript(transaction, clientId, scriptId) === undefined) throw scriptNotFound();
      await recordScript(transaction, scriptId);
      const recorded = await loadPortalScript(transaction, clientId, scriptId);
      if (recorded === undefined) throw scriptNotFound();
      return recorded;
    });

    return reply.send(routeResponse(recordedDocs, request, portalScriptFrom(row)));
  });
};
