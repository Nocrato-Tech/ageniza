import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

/** Add this route config to sensitive endpoints such as login, reset, invite, or upload.
 * `config: { rateLimit: { max: 5, timeWindow: '1 minute' } }`
 */
export const registerRouteRateLimit = async (app: FastifyInstance): Promise<void> => {
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      code: 'RATE_LIMITED'
    })
  });
};
