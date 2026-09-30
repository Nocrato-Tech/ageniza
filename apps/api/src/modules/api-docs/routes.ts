import { randomBytes } from 'node:crypto';

import scalar from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';

import { buildOpenApiDocument } from './document.js';

/**
 * Narrow CSP for the viewer pages only; the API's global CSP (default-src 'none', script-src
 * 'self') stays untouched. The nonce is what lets the inline initializer run, and
 * `connect-src 'self'` is what lets the page fetch `/docs/openapi.json` -- and nothing else.
 */
const docsContentSecurityPolicy = (nonce: string): string => [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'nonce-${nonce}'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'"
].join('; ');

/**
 * Serves the generated OpenAPI document and the interactive reference under `/docs`. `buildApp`
 * registers this module only on a local host runtime, so in production the route does not exist
 * (issue #182, OWASP API9). The viewer dependencies are devDependencies on purpose: the production
 * image prunes them and never loads this module.
 */
export const registerApiDocsModule = async (app: FastifyInstance): Promise<void> => {
  const document = buildOpenApiDocument();
  const nonce = randomBytes(16).toString('base64');

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url === '/docs' || request.url.startsWith('/docs/')) {
      reply.header('content-security-policy', docsContentSecurityPolicy(nonce));
    }
    return payload;
  });

  app.get('/docs/openapi.json', async (_request, reply) => reply.type('application/json').send(document));
  await app.register(scalar, {
    routePrefix: '/docs',
    configuration: {
      url: '/docs/openapi.json',
      // The bundle is served by this plugin from the same origin (no CDN), the inline initializer
      // carries the nonce above, and the two switches below keep the page from reaching for
      // Scalar's telemetry and font hosts at all.
      nonce,
      telemetry: false,
      withDefaultFonts: false
    }
  });
};
