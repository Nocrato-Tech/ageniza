import { describe, expect, it } from 'vitest';

import { documentedRouteConfig } from '../../plugins/infra/route-metadata.js';
import { buildTestApp } from '../auth/test-support/harness.js';
import { DOCUMENTED_ROUTES } from './catalog.js';
import { buildOpenApiDocument } from './document.js';

const openApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

interface ObservedRoute {
  readonly method: string;
  readonly url: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * Issue #182 acceptance: the list of routes the real app registers must match the document
 * exactly, including the permission, the success status and the schema objects each route
 * declares. The app is built by the same harness every integration suite uses, and the harness
 * enforces the declared status on every reply, so a route added or changed without its catalog
 * entry turns this red instead of shipping undocumented.
 *
 * Limitation, on purpose: the inventory only sees routes `buildApp` registers in the test
 * environment. A route registered only in `server.ts` (or only in production) would escape;
 * there is none today, and this comment is the reminder not to create one.
 */
describe('API documentation coverage (issue #182)', () => {
  it('covers every route the real app registers, with the documented metadata', async () => {
    const observed: ObservedRoute[] = [];
    const testApp = await buildTestApp({ onRoute: (route) => observed.push(route) });
    try {
      const getUrls = new Set(observed.filter((route) => route.method === 'get').map((route) => route.url));
      const registered = observed.filter((route) =>
        // Fastify derives a HEAD route from every GET; an explicit `app.head()` with no GET stays.
        !(route.method === 'head' && getUrls.has(route.url)) &&
        // @fastify/cors adds a wildcard OPTIONS preflight route; neither is API surface.
        !(route.method === 'options' && route.url === '*')
      );
      const documented = new Map(DOCUMENTED_ROUTES.map((route) => [`${route.method} ${openApiPath(route.path)}`, route]));

      for (const route of registered) {
        const key = `${route.method} ${openApiPath(route.url)}`;
        const catalogRoute = documented.get(key);
        expect(catalogRoute, `undocumented route: ${key}`).toBeDefined();
        const config = documentedRouteConfig(route.config);
        expect(config, `missing documentation metadata: ${key}`).toBeDefined();
        expect(config!.permission, `permission: ${key}`).toBe(catalogRoute!.permission);
        expect(config!.responseStatus, `status: ${key}`).toBe(catalogRoute!.responses[0]?.status);
        // Object identity, not a copy: the catalog must point at the same contract schema the
        // route validates with, or the document is documenting something else.
        expect(config!.schemas.params, `params schema: ${key}`).toBe(catalogRoute!.params);
        expect(config!.schemas.query, `query schema: ${key}`).toBe(catalogRoute!.query);
        expect(config!.schemas.body, `body schema: ${key}`).toBe(catalogRoute!.body);
        expect(config!.schemas.response, `response schema: ${key}`).toBe(catalogRoute!.responses[0]?.schema);
      }

      const registeredKeys = new Set(registered.map((route) => `${route.method} ${openApiPath(route.url)}`));
      for (const key of documented.keys()) {
        expect(registeredKeys.has(key), `documented route not registered: ${key}`).toBe(true);
      }

      const document = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
      const inDocument = Object.entries(document.paths)
        .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method} ${path}`));
      expect([...inDocument].sort()).toEqual([...documented.keys()].sort());
    } finally {
      await testApp.close();
    }
  });
});
