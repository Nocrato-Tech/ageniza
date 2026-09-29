import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../auth/test-support/harness.js';
import { DOCUMENTED_ROUTES } from './catalog.js';
import { buildOpenApiDocument } from './document.js';

const openApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

interface ObservedRoute {
  readonly method: string;
  readonly url: string;
}

/**
 * Issue #182 acceptance: the list of routes the real app registers must match the document
 * exactly. The app is built by the same harness every integration suite uses, so a route added
 * without a catalog entry turns this red instead of shipping undocumented.
 */
describe('API documentation coverage (issue #182)', () => {
  it('covers every route the real app registers', async () => {
    const observed: ObservedRoute[] = [];
    const testApp = await buildTestApp({ onRoute: (route) => observed.push(route) });
    try {
      const registered = new Set(
        observed
          // Fastify derives a HEAD route from every GET, and @fastify/cors adds a wildcard
          // OPTIONS preflight route; neither is API surface the document describes.
          .filter((route) => route.method !== 'head' && !(route.method === 'options' && route.url === '*'))
          .map((route) => `${route.method} ${openApiPath(route.url)}`)
      );
      const documented = new Set(DOCUMENTED_ROUTES.map((route) => `${route.method} ${openApiPath(route.path)}`));
      expect([...registered].sort()).toEqual([...documented].sort());

      const document = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
      const inDocument = Object.entries(document.paths)
        .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method} ${path}`));
      expect([...inDocument].sort()).toEqual([...documented].sort());
    } finally {
      await testApp.close();
    }
  });
});
