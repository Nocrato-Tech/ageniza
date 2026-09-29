import scalar from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';

import { buildOpenApiDocument } from './document.js';

/**
 * Serves the generated OpenAPI document and the interactive reference under `/docs`. `buildApp`
 * registers this module only when the runtime is local (`APP_ENV=local`, the `pnpm dev` default),
 * so in production the route does not exist (issue #182, OWASP API9: no API inventory published
 * without need). The dependency is a development dependency on purpose: the production image
 * prunes it and never loads this module.
 */
export const registerApiDocsModule = async (app: FastifyInstance): Promise<void> => {
  const document = buildOpenApiDocument();
  app.get('/docs/openapi.json', async (_request, reply) => reply.type('application/json').send(document));
  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: { url: '/docs/openapi.json' }
  });
};
