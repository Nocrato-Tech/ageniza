/** The part of OpenAPI 3.1 that `docs/api/openapi.json` uses; what the reference does not show is left out of the types. */
export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema?: { type?: string; format?: string; enum?: readonly unknown[]; minimum?: number; maximum?: number; default?: unknown };
  description?: string;
  example?: unknown;
}

interface OpenApiMedia {
  example?: unknown;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  /** One permission, or a list when any of them opens the route; `null` when the route asks for none. */
  'x-permission'?: string | string[] | null;
  parameters?: OpenApiParameter[];
  requestBody?: { required?: boolean; content?: Record<string, OpenApiMedia> };
  responses?: Record<string, { description?: string; content?: Record<string, OpenApiMedia> }>;
}

export interface OpenApiDocument {
  info: { title: string; version: string; description?: string };
  tags?: { name: string; description?: string }[];
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ResponseView {
  status: string;
  description: string;
  example?: unknown;
}

export interface OperationView {
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description: string;
  tag: string;
  /** The permissions the route asks for (any one of them opens it); empty when it asks for none (public, or any session). */
  permissions: string[];
  parameters: OpenApiParameter[];
  requestExample?: unknown;
  hasRequestBody: boolean;
  responses: ResponseView[];
  fetchExample: string;
  /** Lower case, without accents: what the search looks into. */
  searchText: string;
}

export interface TagGroup {
  name: string;
  description: string;
  operations: OperationView[];
}

export interface ApiReferenceModel {
  title: string;
  version: string;
  description: string;
  groups: TagGroup[];
  operationCount: number;
}

/** The address the examples call; the guide says which one the team is on. */
export const EXAMPLE_API_URL = 'https://dev.ageniza.com.br';

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';

const normalize = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

type Scalar = string | number | boolean;

const placeholder = (parameter: OpenApiParameter): Scalar => {
  if (parameter.example !== undefined) return parameter.example as Scalar;
  const { schema } = parameter;
  if (schema?.enum?.length) return schema.enum[0] as Scalar;
  if (schema?.default !== undefined) return schema.default as Scalar;
  if (schema?.format === 'uuid') return ZERO_UUID;
  if (schema?.format === 'date') return '2026-10-29';
  if (schema?.format === 'date-time') return '2026-10-29T12:00:00.000Z';
  if (schema?.type === 'integer' || schema?.type === 'number') return schema.minimum ?? 1;
  if (schema?.type === 'boolean') return true;
  return `<${parameter.name}>`;
};

const literal = (value: unknown, indent: string): string => JSON.stringify(value, null, 2).split('\n').join(`\n${indent}`);

type FetchExampleInput = Pick<OperationView, 'method' | 'path' | 'parameters' | 'requestExample' | 'hasRequestBody' | 'responses'>;

/** A `fetch` call that works against the route, with the session cookie and the body of the documented example. */
export function buildFetchExample(operation: FetchExampleInput, baseUrl = EXAMPLE_API_URL): string {
  const required = (place: OpenApiParameter['in']) => operation.parameters.filter((parameter) => parameter.in === place && (place === 'path' || parameter.required === true));
  const pathParameters = required('path');
  const queryParameters = required('query');
  const headerParameters = required('header');

  const lines = [`const API_URL = '${baseUrl}';`];
  for (const parameter of pathParameters) lines.push(`const ${parameter.name} = ${JSON.stringify(placeholder(parameter))};`);

  const target = '`${API_URL}' + operation.path.replace(/\{([^}]+)\}/g, '${$1}') + '`';
  const query = Object.fromEntries(queryParameters.map((parameter) => [parameter.name, String(placeholder(parameter))]));
  const url = queryParameters.length === 0 ? target : `${target} + '?' + new URLSearchParams(${literal(query, '')})`;

  const headers: Record<string, string> = {};
  if (operation.hasRequestBody) headers['Content-Type'] = 'application/json';
  for (const parameter of headerParameters) headers[parameter.name] = String(placeholder(parameter));

  const options = [`  method: '${operation.method.toUpperCase()}',`, "  credentials: 'include',"];
  if (Object.keys(headers).length > 0) options.push(`  headers: ${literal(headers, '  ')},`);
  if (operation.hasRequestBody) options.push(`  body: JSON.stringify(${operation.requestExample === undefined ? '{}' : literal(operation.requestExample, '  ')}),`);

  lines.push('', `const response = await fetch(${url}, {`, ...options, '});');
  lines.push('if (!response.ok) {', '  const { error } = await response.json();', '  throw new Error(`${response.status} ${error.code}: ${error.message}`);', '}');
  const returnsBody = operation.responses.some((response) => /^2\d\d$/.test(response.status) && response.status !== '204' && response.example !== undefined);
  if (returnsBody) lines.push('const data = await response.json();');
  return lines.join('\n');
}

const jsonExample = (media?: Record<string, OpenApiMedia>): unknown => media?.['application/json']?.example;

export function buildReference(spec: OpenApiDocument): ApiReferenceModel {
  const tagOrder = spec.tags?.map((tag) => tag.name) ?? [];
  const byTag = new Map<string, OperationView[]>();

  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const source = item[method];
      if (source === undefined) continue;
      const tag = source.tags?.[0] ?? 'outras';
      const parameters = source.parameters ?? [];
      const responses = Object.entries(source.responses ?? {})
        .map(([status, response]) => ({ status, description: response.description ?? '', example: jsonExample(response.content) }))
        .sort((a, b) => a.status.localeCompare(b.status));
      const view: Omit<OperationView, 'fetchExample' | 'searchText'> = {
        id: source.operationId ?? `${method}-${path}`,
        method,
        path,
        summary: source.summary ?? '',
        description: source.description ?? '',
        tag,
        permissions: [source['x-permission'] ?? []].flat(),
        parameters,
        requestExample: jsonExample(source.requestBody?.content),
        hasRequestBody: source.requestBody !== undefined,
        responses
      };
      const words = [view.id, method, path, view.summary, view.description, tag, ...view.permissions, ...parameters.map((parameter) => parameter.name), ...responses.map((response) => `${response.status} ${response.description}`)];
      byTag.set(tag, [...(byTag.get(tag) ?? []), { ...view, fetchExample: buildFetchExample(view), searchText: normalize(words.join(' ')) }]);
    }
  }

  const names = [...tagOrder.filter((name) => byTag.has(name)), ...[...byTag.keys()].filter((name) => !tagOrder.includes(name)).sort()];
  const groups = names.map((name) => ({ name, description: spec.tags?.find((tag) => tag.name === name)?.description ?? '', operations: byTag.get(name) ?? [] }));
  return {
    title: spec.info.title,
    version: spec.info.version,
    description: spec.info.description ?? '',
    groups,
    operationCount: groups.reduce((total, group) => total + group.operations.length, 0)
  };
}

/** Every word of the query has to appear in the route (path, summary, description, permission, parameter, error code). */
export function searchOperations(groups: readonly TagGroup[], query: string): TagGroup[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...groups];
  return groups
    .map((group) => ({ ...group, operations: group.operations.filter((operation) => words.every((word) => operation.searchText.includes(word))) }))
    .filter((group) => group.operations.length > 0);
}
