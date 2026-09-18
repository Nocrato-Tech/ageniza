import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { ApiConfig } from '@ageniza/config/server';
import { CORRELATION_ID_HEADER, createLogger, createReadiness, REQUEST_ID_HEADER, resolveRequestId, withLogContext, type CoreLogger, type HealthCheck, type Readiness } from '@ageniza/core';

import { registerAuthModule, type AuthModuleDependencies } from './modules/auth/routes.js';
import { registerContextModule, type ContextModuleDependencies } from './modules/contexts/routes.js';
import { createInvitationTokenLookup, registerInvitationModule, type InvitationModuleDependencies } from './modules/invitations/routes.js';
import { registerMediaModule, type MediaModuleDependencies } from './modules/media/routes.js';
import { registerCors } from './plugins/infra/cors.js';
import { registerErrorHandling } from './plugins/infra/errors.js';
import { registerOriginProtection } from './plugins/infra/origin.js';
import { registerRouteRateLimit } from './plugins/infra/rate-limit.js';
import { loggableRoute } from './plugins/infra/route.js';
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
  /** Media dependencies are optional; undefined for tests that never touch object storage. */
  media?: MediaModuleDependencies;
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
    genReqId: (request) => resolveRequestId(request.headers[REQUEST_ID_HEADER])
  });

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
  if (options.media !== undefined) {
    registerMediaModule(app, options.media);
  }
  return app;
};
