import type { FastifyRequest } from 'fastify';
import { ZodError, z, type ZodType, type ZodTypeAny, type ZodTypeDef } from 'zod';

import { HttpError } from '@ageniza/core';

import type { DocumentedRouteConfig } from './route-metadata.js';

/**
 * Parses untrusted transport values and exposes only safe issue metadata to clients.
 *
 * `TIn` is separate from `TOut` so a schema that normalizes rather than merely validates still
 * infers its parsed type. Query schemas need this: a value that must be treated as absent instead
 * of rejected (issue #33's `preferred`) transforms `unknown` into `string | undefined`.
 */
const parseRequest = <TOut, TIn = TOut>(schema: ZodType<TOut, ZodTypeDef, TIn>, value: unknown): TOut => {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: { issues: error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })) }
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
