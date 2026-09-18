import type { FastifyRequest } from 'fastify';

export const UNMATCHED_ROUTE = 'unmatched';

/** The route pattern, or a constant when nothing matched: a raw path can carry a token (issue #37). */
export const loggableRoute = (request: FastifyRequest): string => request.routeOptions.url ?? UNMATCHED_ROUTE;
