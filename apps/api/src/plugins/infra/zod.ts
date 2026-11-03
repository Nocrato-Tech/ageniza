import type { FastifyRequest } from 'fastify';
import { ZodError, z, type ZodType, type ZodTypeAny, type ZodTypeDef } from 'zod';

import { HttpError } from '@ageniza/core';

import type { DocumentedRouteConfig } from './route-metadata.js';

/**
 * The most elements any array of a request may have. The largest the contracts accept is the list of parts of a multipart upload
 * (`CompleteMediaUploadRequestSchema`, 10 000, as S3 allows); the test "no request contract allows more than the ceiling" in
 * `zod.test.ts` walks every request schema the contracts export and fails if one goes past it.
 *
 * Zod 3 keeps parsing every element of an array that is already over its `.max()` and adds one issue per element that fails
 * (GHSA-mrhx-c7xc-m3w5, fixed only in zod 4.6.6). A 1 MiB body of `0,` measured about 520 000 issues, a 50 MB answer and 460 MB of
 * resident memory for one request, which a 512 MiB container does not survive. The ceiling is checked before the schema runs.
 */
export const MAX_REQUEST_ARRAY_ELEMENTS = 10_000;

/** The most issues an answer lists. A form shows a handful; the rest of a long list says nothing the first ones did not. */
export const MAX_REPORTED_ISSUES = 100;

const tooManyElements = (path: string): HttpError => new HttpError({
  statusCode: 400,
  code: 'VALIDATION_ERROR',
  message: 'Request validation failed',
  details: { issues: [{ path, code: 'too_big', message: `Array must have at most ${MAX_REQUEST_ARRAY_ELEMENTS} elements` }] }
});

/** One list or object on the way down: the path is joined from these only when a refusal needs it, so the walk allocates no strings. */
interface Frame {
  readonly node: object;
  readonly parent: Frame | undefined;
  readonly key: string | number;
}

const pathOf = (frame: Frame): string => {
  const keys: Array<string | number> = [];
  for (let current: Frame | undefined = frame; current?.parent !== undefined; current = current.parent) keys.push(current.key);
  return keys.reverse().join('.');
};

/**
 * Walks the parsed JSON (iteratively: a body can nest deeper than the stack) and refuses an array over the ceiling. A body that came
 * through HTTP was already limited in depth and in lists and objects by `json-body.ts`, so the walk is bounded by that.
 */
const assertArraysWithinCeiling = (value: unknown): void => {
  if (typeof value !== 'object' || value === null) return;
  const pending: Frame[] = [{ node: value, parent: undefined, key: '' }];
  for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
    const { node } = frame;
    if (Array.isArray(node)) {
      if (node.length > MAX_REQUEST_ARRAY_ELEMENTS) throw tooManyElements(pathOf(frame));
      node.forEach((child: unknown, index) => {
        if (typeof child === 'object' && child !== null) pending.push({ node: child, parent: frame, key: index });
      });
    } else {
      for (const [key, child] of Object.entries(node)) {
        if (typeof child === 'object' && child !== null) pending.push({ node: child, parent: frame, key });
      }
    }
  }
};

/**
 * Parses untrusted transport values and exposes only safe issue metadata to clients.
 *
 * `TIn` is separate from `TOut` so a schema that normalizes rather than merely validates still
 * infers its parsed type. Query schemas need this: a value that must be treated as absent instead
 * of rejected (issue #33's `preferred`) transforms `unknown` into `string | undefined`.
 */
const parseRequest = <TOut, TIn = TOut>(schema: ZodType<TOut, ZodTypeDef, TIn>, value: unknown): TOut => {
  assertArraysWithinCeiling(value);
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: {
          issues: error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message }))
        }
      });
    }
    throw error;
  }
};

/** Validates route responses before Fastify serializes them. */
const parseResponse = <T>(schema: ZodType<T>, value: unknown): T => schema.parse(value);

type RouteSchemaSlot = keyof DocumentedRouteConfig['schemas'];

const declaredSchema = (request: FastifyRequest, slot: RouteSchemaSlot): unknown =>
  (request.routeOptions?.config as DocumentedRouteConfig | undefined)?.schemas?.[slot];

/**
 * The route validates with the exact schema object it declares in `config.schemas` -- identity, not
 * a copy. A handler that reaches for another schema (a `.passthrough()` clone, another route's
 * object, or a literal next to the config) fails here instead of documenting one contract and
 * enforcing another (issue #192). The `docs` argument only carries the declared type; the value
 * Fastify exposes on `routeOptions.config` is the authority.
 */
const assertDeclaredSchema = (request: FastifyRequest, slot: RouteSchemaSlot, schema: unknown): void => {
  if (declaredSchema(request, slot) !== schema) {
    throw new Error(`Route ${request.routeOptions?.url ?? request.url} must validate its ${slot} with the schema declared in its route config.`);
  }
};

/** Validates `request.params` with the path schema the route declares in its config. */
export const routeParams = <TSchema extends ZodTypeAny>(
  docs: { readonly schemas: { readonly params: TSchema } },
  request: FastifyRequest
): z.output<TSchema> => {
  assertDeclaredSchema(request, 'params', docs.schemas.params);
  return parseRequest(docs.schemas.params, request.params);
};

/** Validates `request.query` with the query schema the route declares in its config. */
export const routeQuery = <TSchema extends ZodTypeAny>(
  docs: { readonly schemas: { readonly query: TSchema } },
  request: FastifyRequest
): z.output<TSchema> => {
  assertDeclaredSchema(request, 'query', docs.schemas.query);
  return parseRequest(docs.schemas.query, request.query);
};

/** Validates `request.body` with the body schema the route declares in its config. */
export const routeBody = <TSchema extends ZodTypeAny>(
  docs: { readonly schemas: { readonly body: TSchema } },
  request: FastifyRequest
): z.output<TSchema> => {
  assertDeclaredSchema(request, 'body', docs.schemas.body);
  return parseRequest(docs.schemas.body, request.body);
};

/** Validates a response payload with the response schema the route declares in its config. */
export const routeResponse = <TSchema extends ZodTypeAny>(
  docs: { readonly schemas: { readonly response: TSchema } },
  request: FastifyRequest,
  value: unknown
): z.output<TSchema> => {
  assertDeclaredSchema(request, 'response', docs.schemas.response);
  return parseResponse(docs.schemas.response, value);
};

const emptyQuerySchema = z.object({}).strict();

/**
 * `/health` and `/ready` reject any query parameter and have no documented query schema, so they
 * cannot go through `routeQuery`. This is the only schema the module lets a route pass directly, and
 * it can only reject input.
 */
export const parseStrictEmptyQuery = (request: FastifyRequest): void => {
  parseRequest(emptyQuerySchema, request.query);
};
