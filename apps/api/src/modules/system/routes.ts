import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { HealthResponseSchema } from '@ageniza/contracts';
import { checkHealth, HttpError, type HealthCheck, type Readiness } from '@ageniza/core';

import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { parseRequest, parseResponse } from '../../plugins/infra/zod.js';

const EmptyQuerySchema = z.object({}).strict();

// Declared once: the same object is the route's documentation metadata and the schema the handler
// validates the response with.
const healthDocs = {
  permission: null,
  responseStatus: 200,
  schemas: { response: HealthResponseSchema }
} satisfies DocumentedRouteConfig;

export interface SystemModuleOptions {
  readiness: Readiness;
  dependencyChecks: readonly HealthCheck[];
}

/** Process-level endpoints only. Domain modules belong beside this module, never under plugins. */
export const registerSystemModule = (app: FastifyInstance, options: SystemModuleOptions): void => {
  app.get('/health', {
    config: healthDocs,
    preValidation: async (request) => { parseRequest(EmptyQuerySchema, request.query); }
  }, async () => parseResponse(healthDocs.schemas.response, { status: 'ok' }));

  app.get('/ready', {
    config: healthDocs,
    preValidation: async (request) => { parseRequest(EmptyQuerySchema, request.query); }
  }, async (request) => {
    if (!options.readiness.isReady()) {
      throw new HttpError({ statusCode: 503, code: 'NOT_READY', message: 'Service is not ready' });
    }
    const report = await checkHealth(options.dependencyChecks);
    if (report.status !== 'ok') {
      request.log.warn({ requestId: request.id, failedChecks: report.checks.filter((check) => check.status === 'error').map((check) => check.name) }, 'Readiness dependency check failed');
      throw new HttpError({ statusCode: 503, code: 'NOT_READY', message: 'Service is not ready' });
    }
    return parseResponse(healthDocs.schemas.response, { status: 'ok' });
  });
};
