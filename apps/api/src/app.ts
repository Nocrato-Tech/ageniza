import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { ZodType } from 'zod';

import type { ApiConfig } from '@ageniza/config/server';
import { CORRELATION_ID_HEADER, createLogger, createReadiness, REQUEST_ID_HEADER, resolveRequestId, withLogContext, type CoreLogger, type HealthCheck, type Readiness } from '@ageniza/core';

import { registerAgencyModule, type AgencyModuleDependencies } from './modules/agencies/routes.js';
import { registerAuthModule, type AuthModuleDependencies } from './modules/auth/routes.js';
import { registerClientModule, type ClientModuleDependencies } from './modules/clients/routes.js';
import { registerCollaboratorModule, type CollaboratorModuleDependencies } from './modules/collaborators/routes.js';
import { registerContextModule, type ContextModuleDependencies } from './modules/contexts/routes.js';
import { createInvitationTokenLookup, registerInvitationModule, type InvitationModuleDependencies } from './modules/invitations/routes.js';
import { registerMediaModule, type MediaModuleDependencies } from './modules/media/routes.js';
import { registerProfileModule, type ProfileModuleDependencies } from './modules/profile/routes.js';
import { registerCors } from './plugins/infra/cors.js';
import { registerErrorHandling, sendErrorEnvelope } from './plugins/infra/errors.js';
import { registerOriginProtection } from './plugins/infra/origin.js';
import { registerRouteRateLimit } from './plugins/infra/rate-limit.js';
import { loggableRoute } from './plugins/infra/route.js';
import type { DocumentedRouteConfig } from './plugins/infra/route-metadata.js';
import { registerSecurityHeaders } from './plugins/infra/security.js';
import { registerSystemModule } from './modules/system/routes.js';

export interface ApiAppOptions {
  config: ApiConfig;
  logger?: CoreLogger;
  readiness?: Readiness;
  dependencyChecks?: readonly HealthCheck[];
  /** Test-only override; production always derives proxy trust from explicit configured networks. */
  trustProxy?: FastifyServerOptions['trustProxy'];
  /** Omitted in tests that never touch an auth route; `server.ts` always supplies it. */
  auth?: AuthModuleDependencies;
  /** Invitation dependencies are optional for lightweight health/app tests. */
  invitations?: InvitationModuleDependencies;
  /** Context dependencies are optional for lightweight health/app tests. */
  contexts?: ContextModuleDependencies;
  /** Agency dependencies are optional for lightweight health/app tests. */
  agencies?: AgencyModuleDependencies;
  /** Client dependencies are optional; undefined for tests that never touch the clients module. */
  clients?: ClientModuleDependencies;
  /** Collaborator dependencies need identity storage; optional for lightweight health/app tests. */
  collaborators?: CollaboratorModuleDependencies;
  /** Media dependencies are optional; undefined for tests that never touch object storage. */
  media?: MediaModuleDependencies;
  /** Profile dependencies are optional; undefined where identity storage is not configured. */
  profile?: ProfileModuleDependencies;
  /**
   * Test-only observer for every registered route, fired by Fastify's `onRoute` hook before
   * `app.ready()`. The API documentation test uses it to prove the OpenAPI document covers the
   * real surface, including the documented permission, status and schema objects; production
   * never passes it.
   */
  onRoute?: (route: {
    readonly method: string;
    readonly url: string;
    readonly config: Readonly<Record<string, unknown>>;
  }) => void;
  /**
   * Test-only enforcement of the documented success contract: when a route declares
   * `config.responseStatus`, a non-error reply with any other status fails the request; when it
   * declares `config.schemas.response`, the serialized success payload is parsed with that exact
   * schema, so a handler that sends a different shape fails too. The test harness turns it on;
   * production never passes it.
   */
  enforceDocumentedStatus?: boolean;
}

/** Builds the HTTP application without binding a port, enabling deterministic Fastify inject tests. */
export const buildApp = async (options: ApiAppOptions): Promise<FastifyInstance> => {
  const logger = withLogContext(options.logger ?? createLogger(), {
    environment: options.config.environment,
    service: options.config.service,
    deployVersion: options.config.deployVersion
  });
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: options.config.bodyLimitBytes,
    trustProxy: options.trustProxy ?? (options.config.trustedProxyCidrs.length === 0 ? false : [...options.config.trustedProxyCidrs]),
    // Disable Fastify's unvalidated header shortcut; core validates before preserving client correlation IDs.
    requestIdHeader: false,
    genReqId: (request) => resolveRequestId(request.headers[REQUEST_ID_HEADER]),
    // Fastify answers a router framework error (over-long path parameter, malformed URL) with a raw
    // body that echoes the path and skips `setErrorHandler`. The synthetic reply has no route error
    // handler to fall back on, so the envelope is written directly, by exact code.
    frameworkErrors: (error, request, reply) => {
      sendErrorEnvelope(error, request, reply);
    }
  });

  if (options.onRoute !== undefined) {
    const observeRoute = options.onRoute;
    app.addHook('onRoute', (routeOptions) => {
      const methods = Array.isArray(routeOptions.method) ? routeOptions.method : [routeOptions.method];
      const config = (routeOptions.config ?? {}) as Readonly<Record<string, unknown>>;
      for (const method of methods) observeRoute({ method: method.toLowerCase(), url: routeOptions.url, config });
    });
  }
  if (options.enforceDocumentedStatus === true) {
    app.addHook('onSend', async (request, reply, payload) => {
      const config = request.routeOptions?.config as DocumentedRouteConfig | undefined;
      const declared = config?.responseStatus;
      if (declared !== undefined && reply.statusCode < 400 && reply.statusCode !== declared) {
        // Fail the request instead of returning a status the route itself did not declare: the
        // documentation coverage test is what turns this into a red suite.
        throw new Error(`Route ${request.routeOptions?.url ?? request.url} replied ${reply.statusCode} but declares ${declared}.`);
      }
      // The serialized success payload is parsed with the exact schema the route declared. A handler
      // that sends a different shape (a bypassed `routeResponse`, an extra field) fails here even
      // when no behavior test inspects that field, closing issue #192's escape hatch.
      const responseSchema = config?.schemas?.response as ZodType | undefined;
      if (responseSchema !== undefined && reply.statusCode < 400 && payload !== undefined && payload !== null) {
        const body = typeof payload === 'string'
          ? (payload.length === 0 ? undefined : JSON.parse(payload))
          : Buffer.isBuffer(payload)
            ? JSON.parse(payload.toString('utf8'))
            : payload;
        if (body !== undefined) responseSchema.parse(body);
      }
      return payload;
    });
  }
  app.addHook('onRequest', (request, reply, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    reply.header(CORRELATION_ID_HEADER, resolveRequestId(request.headers[CORRELATION_ID_HEADER] ?? request.id));
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const route = loggableRoute(request);
    request.log.info({
      requestId: request.id,
      correlationId: reply.getHeader(CORRELATION_ID_HEADER),
      route,
      operation: `${request.method} ${route}`,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime * 100) / 100
    }, 'Request completed');
    done();
  });

  await registerCors(app, { allowedOrigins: options.config.corsOrigins });
  await registerSecurityHeaders(app);
  await registerRouteRateLimit(app);
  registerErrorHandling(app);
  // Global CSRF/origin check, registered before any domain module so every current and future
  // route is covered; no route implements this check on its own (issue #31 section 5.1).
  registerOriginProtection(app, { appPublicUrl: options.config.appPublicUrl });
  registerSystemModule(app, {
    readiness: options.readiness ?? createReadiness(true),
    dependencyChecks: options.dependencyChecks ?? []
  });
  if (options.auth !== undefined) {
    const invitationTokenLookup = options.invitations === undefined
      ? options.auth.invitationTokenLookup
      : options.invitations.invitationTokenLookup ?? createInvitationTokenLookup(options.invitations.database);
    registerAuthModule(app, {
      ...options.auth,
      invitationTokenLookup
    });
  }
  if (options.invitations !== undefined) {
    registerInvitationModule(app, options.invitations);
  }
  if (options.contexts !== undefined) {
    registerContextModule(app, options.contexts);
  }
  if (options.agencies !== undefined) {
    registerAgencyModule(app, options.agencies);
  }
  if (options.clients !== undefined) {
    registerClientModule(app, options.clients);
  }
  if (options.collaborators !== undefined) {
    registerCollaboratorModule(app, options.collaborators);
  }
  if (options.media !== undefined) {
    registerMediaModule(app, options.media);
  }
  if (options.profile !== undefined) {
    registerProfileModule(app, options.profile);
  }
  // Development-only API reference (issue #182). The dynamic import keeps the viewer and the
  // OpenAPI generator out of the production image, which prunes devDependencies. `containerLocal`
  // is the Docker Compose stack running that pruned image with `APP_ENV=local`: the viewer cannot
  // work there, so the route is not registered. The try/catch is the second barrier for any other
  // pruned runtime (a manual `--prod deploy` without the flag): `/docs` is optional tooling, so a
  // missing viewer logs a warning instead of taking the API down.
  if (options.config.environment === 'local' && !options.config.containerLocal) {
    try {
      const { registerApiDocsModule } = await import('./modules/api-docs/routes.js');
      await registerApiDocsModule(app);
    } catch (error) {
      app.log.warn({
        error: { name: error instanceof Error ? error.name : 'UnknownError', code: 'API_DOCS_UNAVAILABLE' }
      }, 'The interactive API documentation is not available in this runtime; continuing without /docs');
    }
  }
  return app;
};
