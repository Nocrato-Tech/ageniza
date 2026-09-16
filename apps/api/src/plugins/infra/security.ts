import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

/** Conservative headers for a JSON API; individual asset routes can opt out deliberately if needed. */
export const registerSecurityHeaders = async (app: FastifyInstance): Promise<void> => {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' }
  });
};
