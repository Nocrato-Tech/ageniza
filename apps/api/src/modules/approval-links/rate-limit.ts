import { HttpError } from '@ageniza/core';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

import type { ApprovalRateLimitWindow } from './policy.js';

export interface WindowCounterResult {
  readonly limited: boolean;
  readonly retryAfterSeconds: number;
}

export interface WindowCounter {
  hit(key: string, window: ApprovalRateLimitWindow): WindowCounterResult;
}

const SWEEP_AT = 10_000;

/**
 * A fixed window per key, in memory. The plugin of the API runs one limiter per request (`rateLimitRan`), and the routes of the link need
 * two at once, by IP and by the digest of the token or of the session, so the second would never count. A key is a digest or an address,
 * never the value of a token. A request that is refused still counts: guessing is what the limit is for.
 */
export const createWindowCounter = (clock: () => number = Date.now): WindowCounter => {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const sweep = (now: number): void => {
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
  };
  return {
    hit(key, window) {
      const now = clock();
      if (buckets.size >= SWEEP_AT) sweep(now);
      const current = buckets.get(key);
      const bucket = current !== undefined && current.resetAt > now ? current : { count: 0, resetAt: now + window.windowMs };
      bucket.count += 1;
      buckets.set(key, bucket);
      return { limited: bucket.count > window.max, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)) };
    }
  };
};

export interface LimitRule {
  readonly window: ApprovalRateLimitWindow;
  readonly key: (request: FastifyRequest) => string;
}

/** The first rule that is over its window answers `429 RATE_LIMITED` with `Retry-After`; the answer carries nothing of the request. */
export const limitBy = (counter: WindowCounter, rules: readonly LimitRule[]): preHandlerAsyncHookHandler =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    for (const rule of rules) {
      const result = counter.hit(rule.key(request), rule.window);
      if (result.limited) {
        reply.header('retry-after', String(result.retryAfterSeconds));
        throw new HttpError({ statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests' });
      }
    }
  };
