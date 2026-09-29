import { describe, expect, it } from 'vitest';

import { DOCUMENTED_ROUTES } from './catalog.js';
import { buildOpenApiDocument } from './document.js';

interface OperationDocument {
  readonly paths: Record<string, Record<string, { readonly 'x-permission'?: string | null; readonly responses: Record<string, { readonly description?: string }> }>>;
  readonly components?: { readonly schemas?: Record<string, unknown> };
}

const openApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

const asDocument = (): OperationDocument => buildOpenApiDocument() as unknown as OperationDocument;

const collectSecretLikeExamples = (value: unknown, path: string, findings: string[]): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSecretLikeExamples(item, `${path}[${index}]`, findings));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(password|newpassword|token|invitetoken|secret|authorization)$/i.test(key) && typeof child === 'string' && !child.startsWith('<')) {
      findings.push(`${path}.${key}`);
    }
    collectSecretLikeExamples(child, `${path}.${key}`, findings);
  }
};

describe('OpenAPI document (issue #182)', () => {
  it('documents exactly the catalog routes, with the permission as an extension', () => {
    const document = asDocument();
    const documented = new Set<string>();
    for (const route of DOCUMENTED_ROUTES) {
      const operation = document.paths[openApiPath(route.path)]?.[route.method];
      expect(operation, `${route.method} ${route.path}`).toBeDefined();
      expect(operation!['x-permission']).toBe(route.permission);
      documented.add(`${route.method} ${openApiPath(route.path)}`);
    }
    const inDocument = Object.entries(document.paths).flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method} ${path}`));
    expect([...inDocument].sort()).toEqual([...documented].sort());
  });

  it('documents error responses with status and code', () => {
    const document = asDocument();
    const login = document.paths['/auth/login']!.post!;
    const codes = Object.values(login.responses).map((response) => response.description ?? '').join(' | ');
    expect(codes).toContain('INVALID_CREDENTIALS');
    expect(codes).toContain('NO_CONTEXT_ACCESS');
    expect(codes).toContain('RATE_LIMITED');
    expect(login.responses['401']).toBeDefined();

    const agencyMe = document.paths['/agencies/{agencyId}/me']!.get!;
    expect(agencyMe.responses['404']?.description).toContain('NOT_FOUND');
  });

  it('reuses contract schemas as components instead of restating them', () => {
    const document = asDocument();
    const schemas = Object.keys(document.components?.schemas ?? {});
    expect(schemas).toContain('ApiErrorResponse');
    expect(schemas).toContain('getAgencyMeResponse');
    expect(schemas).toContain('postAuthLoginRequest');
    const agencyMe = JSON.stringify(document.paths['/agencies/{agencyId}/me']);
    expect(agencyMe).toContain('#/components/schemas/getAgencyMeResponse');
  });

  it('keeps password- and token-shaped examples as placeholders, never values', () => {
    const findings: string[] = [];
    collectSecretLikeExamples(buildOpenApiDocument(), 'openapi', findings);
    expect(findings).toEqual([]);
  });

  it('is deterministic, so the CI diff check is stable', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });
});
