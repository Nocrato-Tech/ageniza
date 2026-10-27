import type { DocumentedRouteConfig } from '../../plugins/infra/route-metadata.js';

/** No informative headers on any auth 429 (B6): a client must not be able to tell, from the
 * response shape alone, whether a per-IP limit or an in-memory dimension tripped. */
const noRateLimitHeaders = {
  addHeaders: {
    'x-ratelimit-limit': false,
    'x-ratelimit-remaining': false,
    'x-ratelimit-reset': false,
    'retry-after': false
  },
  addHeadersOnExceeding: {
    'x-ratelimit-limit': false,
    'x-ratelimit-remaining': false,
    'x-ratelimit-reset': false
  }
} as const;

export const perIpRateLimit = (limit: { readonly max: number; readonly windowMs: number }, docs: DocumentedRouteConfig) => ({
  config: {
    rateLimit: { max: limit.max, timeWindow: limit.windowMs, ...noRateLimitHeaders },
    permission: docs.permission,
    responseStatus: docs.responseStatus,
    schemas: docs.schemas
  }
});
