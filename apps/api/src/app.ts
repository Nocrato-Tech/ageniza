import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyServerOptions } from 'fastify';

import type { ApiConfig } from '@ageniza/config/server';
import { createLogger, createReadiness, REQUEST_ID_HEADER, resolveRequestId, type CoreLogger, type HealthCheck, type Readiness } from '@ageniza/core';

import { registerCors } from './plugins/infra/cors.js';
import { registerErrorHandling } from './plugins/infra/errors.js';
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
}

/** Builds the HTTP application without binding a port, enabling deterministic Fastify inject tests. */
export const buildApp = async (options: ApiAppOptions): Promise<FastifyInstance> => {
  const logger = options.logger ?? createLogger();
  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: options.config.bodyLimitBytes,
    trustProxy: options.trustProxy ?? (options.config.trustedProxyCidrs.length === 0 ? false : [...options.config.trustedProxyCidrs]),
    // Disable Fastify's unvalidated header shortcut; core validates before preserving client correlation IDs.
    requestIdHeader: false,
    genReqId: (request) => resolveRequestId(request.headers[REQUEST_ID_HEADER])
  });

  app.addHook('onRequest', (request, reply, done) => {
    reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });

  await registerCors(app, { allowedOrigins: options.config.corsOrigins });
  await registerSecurityHeaders(app);
  await registerRouteRateLimit(app);
  registerErrorHandling(app);
  registerSystemModule(app, {
    readiness: options.readiness ?? createReadiness(true),
    dependencyChecks: options.dependencyChecks ?? []
  });
  return app;
};
