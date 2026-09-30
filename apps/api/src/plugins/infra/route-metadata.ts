/**
 * Route metadata shared by every module and checked against the generated API documentation
 * (issue #182). It lives in `plugins/infra` because it is a declaration about the HTTP surface,
 * not domain logic.
 *
 * `permission` is the key `requirePermission` demands (or null), `responseStatus` is the success
 * status the handler replies with, and `schemas` are the exact contract objects the route
 * validates with -- identity, not a copy. `api-docs.integration.test.ts` compares all of them with
 * the catalog on `onRoute`, and the test harness fails any reply whose status differs from
 * `responseStatus` or whose body does not parse with the declared `schemas.response`, so the
 * catalog cannot drift from the route it documents.
 */
export interface DocumentedRouteConfig {
  readonly permission: string | null;
  readonly responseStatus: number;
  readonly schemas: {
    readonly params?: unknown;
    readonly query?: unknown;
    readonly body?: unknown;
    readonly response?: unknown;
  };
}

declare module 'fastify' {
  interface FastifyContextConfig {
    permission?: string | null;
    responseStatus?: number;
    schemas?: DocumentedRouteConfig['schemas'];
  }
}

/** Reads the documentation metadata Fastify exposes on `routeOptions.config`. */
export const documentedRouteConfig = (config: unknown): DocumentedRouteConfig | undefined => {
  if (typeof config !== 'object' || config === null) return undefined;
  const candidate = config as Partial<DocumentedRouteConfig>;
  return typeof candidate.responseStatus === 'number' ? candidate as DocumentedRouteConfig : undefined;
};
