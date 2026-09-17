import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

import { normalizeRateLimitIp } from './rate-limit-ip.js';

/** Add this route config to sensitive endpoints such as login, reset, invite, or upload.
 * `config: { rateLimit: { max: 5, timeWindow: '1 minute' } }`
 */
export const registerRouteRateLimit = async (app: FastifyInstance): Promise<void> => {
  await app.register(rateLimit, {
    global: false,
    // IPv6 clients are bucketed by /64 (B7, partial): a single client that rotates addresses
    // within its own /64 is still counted as one bucket. IPv4 is untouched. This never changes
    // any configured limit, only the key the count is stored under.
    keyGenerator: (request) => normalizeRateLimitIp(request.ip),
    errorResponseBuilder: (_request, context) => ({
      statusCode: context.statusCode,
      code: 'RATE_LIMITED'
    })
  });
};
