import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import { normalizeRateLimitIp } from './rate-limit-ip.js';

const sharedLimiters = new WeakMap<FastifyInstance, Map<string, preHandlerAsyncHookHandler>>();

/**
 * One bucket per user for every route that asks for the same `name`. The plugin makes a store per route configuration, so the same
 * numbers declared on two routes are two buckets; this makes one handler (one store) and returns it to each. It counts when it runs,
 * so put it after the guards in `preHandler`: `request.auth` is then the session user and a refused request counts for nobody.
 */
export const sharedUserRateLimit = (
  app: FastifyInstance,
  name: string,
  limit: { readonly max: number; readonly windowMs: number }
): preHandlerAsyncHookHandler => {
  const byName = sharedLimiters.get(app) ?? new Map<string, preHandlerAsyncHookHandler>();
  sharedLimiters.set(app, byName);
  const existing = byName.get(name);
  if (existing !== undefined) return existing;
  const handler = app.rateLimit({
    max: limit.max,
    timeWindow: limit.windowMs,
    keyGenerator: (request: FastifyRequest) => request.auth?.userId ?? request.ip
  }) as preHandlerAsyncHookHandler;
  byName.set(name, handler);
  return handler;
};

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
