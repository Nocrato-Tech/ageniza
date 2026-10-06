import { describe, expect, it } from 'vitest';

import { DOCUMENTED_ROUTES, permissionLabel } from './catalog.js';
import { buildOpenApiDocument } from './document.js';

interface OperationDocument {
  readonly paths: Record<string, Record<string, { readonly 'x-permission'?: string | readonly [string, ...string[]] | null; readonly responses: Record<string, { readonly description?: string }> }>>;
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
      // Equality of value, not of reference: the extension must carry the same keys as the
      // catalog entry, even when the generator re-creates the array (review of #293, Lupa).
      expect(operation!['x-permission']).toEqual(route.permission);
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
    // The request examples are not all in the OpenAPI document (some routes have no body), so the
    // catalog itself is scanned too -- it is the source of docs/api/README.md, where those
    // examples are rendered verbatim. Without this, a real password in a `requestExample` would
    // reach the committed README with every test green (security review of PR #187).
    collectSecretLikeExamples(DOCUMENTED_ROUTES, 'catalog', findings);
    collectSecretLikeExamples(buildOpenApiDocument(), 'openapi', findings);
    expect(findings).toEqual([]);
  });

  it('is deterministic, so the CI diff check is stable', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });
});

describe('permissionLabel (review of #293, Lupa)', () => {
  it('renders a list of permissions as an OR in prose', () => {
    expect(permissionLabel(['colaborador.convidar', 'colaborador.alterar_papel']))
      .toBe('`colaborador.convidar` ou `colaborador.alterar_papel`');
  });

  it('keeps a single permission and a null permission as they were', () => {
    expect(permissionLabel('colaborador.visualizar')).toBe('`colaborador.visualizar`');
    expect(permissionLabel(null)).toBe('—');
  });
});
