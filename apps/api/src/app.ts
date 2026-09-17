import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { ApiConfig } from '@ageniza/config/server';
import { CORRELATION_ID_HEADER, createLogger, createReadiness, REQUEST_ID_HEADER, resolveRequestId, withLogContext, type CoreLogger, type HealthCheck, type Readiness } from '@ageniza/core';

import { registerAuthModule, type AuthModuleDependencies } from './modules/auth/routes.js';
import { registerCors } from './plugins/infra/cors.js';
import { registerErrorHandling } from './plugins/infra/errors.js';
import { registerOriginProtection } from './plugins/infra/origin.js';
import { registerRouteRateLimit } from './plugins/infra/rate-limit.js';
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
    const route = request.routeOptions.url ?? request.url.split('?')[0];
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
    registerAuthModule(app, options.auth);
  }
  return app;
};
