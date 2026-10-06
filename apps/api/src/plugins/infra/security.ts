import fastifyHelmet from '@fastify/helmet';
import helmet from 'helmet';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Conservative headers for a JSON API; individual asset routes can opt out deliberately if needed.
 * The object is not annotated with helmet's own type: `@fastify/helmet` (CJS) and this module (ESM)
 * resolve two declaration files of `helmet`, so naming its type makes them "unrelated". The shape
 * is checked at both call sites instead.
 */
export const SECURITY_HEADER_OPTIONS = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' as const },
  referrerPolicy: { policy: 'no-referrer' as const }
};

export const registerSecurityHeaders = async (app: FastifyInstance): Promise<void> => {
  await app.register(fastifyHelmet, SECURITY_HEADER_OPTIONS);
};

/**
 * Applies the same headers to a reply the `onRequest` hook never sees. The router's framework errors
 * (over-long path parameter, malformed URL) answer through a synthetic reply that skips every hook,
 * so without this the raw response would go out without CSP, nosniff, HSTS and the rest.
 */
export const applySecurityHeaders = (request: FastifyRequest, reply: FastifyReply): void => {
  helmet(SECURITY_HEADER_OPTIONS)(request.raw, reply.raw, () => undefined);
};
