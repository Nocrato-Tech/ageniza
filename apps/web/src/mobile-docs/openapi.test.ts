import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildFetchExample, buildReference, searchOperations, HTTP_METHODS, type OpenApiDocument } from './openapi.js';

const spec = JSON.parse(readFileSync(join(__dirname, '../../../../docs/api/openapi.json'), 'utf8')) as OpenApiDocument;
const model = buildReference(spec);
const operations = model.groups.flatMap((group) => group.operations);
const find = (method: string, path: string) => operations.find((operation) => operation.method === method && operation.path === path)!;

describe('the reference built from docs/api/openapi.json', () => {
  it('has one entry per route of the file, none lost and none repeated', () => {
    const inFile = Object.values(spec.paths).reduce((total, item) => total + HTTP_METHODS.filter((method) => item[method] !== undefined).length, 0);
    expect(inFile).toBeGreaterThan(100);
    expect(model.operationCount).toBe(inFile);
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(inFile);
  });

  it('groups by tag, in the order the file declares them', () => {
    expect(model.groups.map((group) => group.name)).toEqual((spec.tags ?? []).map((tag) => tag.name).filter((name) => operations.some((operation) => operation.tag === name)));
    expect(model.groups.every((group) => group.operations.every((operation) => operation.tag === group.name))).toBe(true);
  });

  it('carries method, summary, permission, parameters, request example and responses of a route', () => {
    const operation = find('post', '/auth/sign-up');
    expect(operation.summary).toBe('Cria uma conta com e-mail e senha');
    expect(operation.permissions).toEqual([]);
    expect(operation.requestExample).toMatchObject({ email: 'nova@exemplo.test', acceptTerms: true });
    expect(operation.responses.map((response) => response.status)).toContain('202');
    expect(operation.responses.find((response) => response.status === '400')!.example).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const declared = (source: { 'x-permission'?: string | string[] | null }) => [source['x-permission'] ?? []].flat();
    for (const candidate of operations) expect(candidate.permissions, `${candidate.method} ${candidate.path}`).toEqual(declared(spec.paths[candidate.path]![candidate.method]!));
    expect(operations.filter((candidate) => candidate.permissions.length > 1).length, 'routes that accept any of several permissions').toBeGreaterThan(0);
    expect(operations.find((candidate) => candidate.parameters.length > 0)!.parameters[0]).toHaveProperty('name');
  });
});

describe('the fetch example', () => {
  it('is valid JavaScript for every route', () => {
    for (const operation of operations) {
      expect(() => new Function(`return async () => {\n${operation.fetchExample}\n}`), `${operation.method} ${operation.path}`).not.toThrow();
    }
  });

  it('calls the method and the path of the route with the session cookie and the example body', () => {
    const example = find('post', '/auth/sign-up').fetchExample;
    expect(example).toContain("const API_URL = 'https://dev.ageniza.com.br';");
    expect(example).toContain('fetch(`${API_URL}/auth/sign-up`');
    expect(example).toContain("method: 'POST'");
    expect(example).toContain("credentials: 'include'");
    expect(example).toContain('"Content-Type": "application/json"');
    expect(example).toContain('"acceptTerms": true');
  });

  it('declares the path parameters and puts them in the address', () => {
    const operation = operations.find((candidate) => candidate.method === 'get' && candidate.path.includes('{clientId}') && candidate.path.includes('{agencyId}'))!;
    expect(operation.fetchExample).toMatch(/const agencyId = "[0-9a-f-]{36}";/);
    expect(operation.fetchExample).toContain('${agencyId}');
    expect(operation.fetchExample).not.toContain('{agencyId}`');
    expect(operation.fetchExample).not.toContain("method: 'POST'");
  });

  it('puts a required query parameter in the address and reads the body only when the route answers with one', () => {
    const example = buildFetchExample({
      method: 'get',
      path: '/things',
      parameters: [{ name: 'month', in: 'query', required: true, schema: { type: 'string', format: 'date' } }, { name: 'page', in: 'query' }],
      hasRequestBody: false,
      responses: [{ status: '204', description: '' }]
    });
    expect(example).toContain('new URLSearchParams({\n  "month": "2026-10-29"\n})');
    expect(example).not.toContain('page');
    expect(example).not.toContain('Content-Type');
    expect(example).not.toContain('const data');
    expect(buildFetchExample({ method: 'get', path: '/x', parameters: [], hasRequestBody: false, responses: [{ status: '200', description: '', example: { a: 1 } }] })).toContain('const data = await response.json();');
  });

  it('does not read a body from a 204 answer', () => {
    expect(buildFetchExample({ method: 'post', path: '/x', parameters: [], hasRequestBody: false, responses: [{ status: '204', description: '', example: {} }] })).not.toContain('const data');
  });
});

describe('searchOperations', () => {
  const found = (query: string) => searchOperations(model.groups, query).flatMap((group) => group.operations);

  it('returns everything for an empty query', () => {
    expect(found('')).toHaveLength(model.operationCount);
    expect(found('   ')).toHaveLength(model.operationCount);
  });

  it('finds by path, by permission, by summary text and by error code', () => {
    expect(found('/portal-approval/batch').map((operation) => operation.path)).toContain('/portal-approval/batch');
    expect(found('/portal-approval').length).toBeGreaterThan(3);
    expect(found('conteudo.aprovar_pela_agencia').every((operation) => operation.permissions.includes('conteudo.aprovar_pela_agencia') || operation.searchText.includes('conteudo.aprovar_pela_agencia'))).toBe(true);
    expect(found('conteudo.aprovar_pela_agencia').length).toBeGreaterThan(0);
    expect(found('AGENCY_READ_ONLY').length).toBeGreaterThan(0);
  });

  it('ignores accents and case, and wants every word', () => {
    expect(found('CONFIRMACAO').length).toBe(found('confirmação').length);
    expect(found('confirmação').length).toBeGreaterThan(0);
    expect(found('sign-up cadastro-que-nao-existe-xyz')).toEqual([]);
  });

  it('drops the groups left empty', () => {
    const groups = searchOperations(model.groups, '/portal-approval');
    expect(groups.length).toBeLessThan(model.groups.length);
    expect(groups.every((group) => group.operations.length > 0)).toBe(true);
  });
});
