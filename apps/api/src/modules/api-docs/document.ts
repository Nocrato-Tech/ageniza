import { OpenAPIRegistry, OpenApiGeneratorV31, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { ApiErrorResponseSchema, InvitationCreatedResponseSchema } from '@ageniza/contracts';

// The registry labels schemas with `.openapi()`, which this call installs on the zod prototype.
// It runs only on the documentation path (the CLI and the local-only `/docs` module), never on a
// production request path.
extendZodWithOpenApi(z);

import {
  API_DOCUMENT_INFO,
  DOCUMENTED_ROUTES,
  ERROR_MESSAGES,
  MODULE_DESCRIPTIONS,
  permissionLabel,
  type ApiErrorDoc,
  type ApiModule
} from './catalog.js';

const EXAMPLE_REQUEST_ID = 'req-de-exemplo';

/** OpenAPI path syntax uses `{param}`; Fastify uses `:param`. */
const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

const errorExample = (error: ApiErrorDoc): Record<string, unknown> => ({
  error: {
    code: error.code,
    message: error.message ?? ERROR_MESSAGES[error.code] ?? 'Request failed'
  },
  meta: { requestId: EXAMPLE_REQUEST_ID }
});

const assertExample = (schema: z.ZodTypeAny, example: unknown, context: string): void => {
  const parsed = schema.safeParse(example);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`The API documentation example for ${context} does not match its schema: ${issues}`);
  }
};

const groupErrorsByStatus = (errors: readonly ApiErrorDoc[]): ReadonlyArray<readonly [number, readonly ApiErrorDoc[]]> => {
  const grouped = new Map<number, ApiErrorDoc[]>();
  for (const error of errors) {
    const list = grouped.get(error.status) ?? [];
    list.push(error);
    grouped.set(error.status, list);
  }
  return [...grouped.entries()].sort(([a], [b]) => a - b);
};

/**
 * Builds the OpenAPI 3.1 document from the route catalog. Every schema comes from
 * `@ageniza/contracts`; this module never restates one. Examples are validated against the schema
 * they illustrate, so a drifted example fails `pnpm api:docs` instead of shipping a lie.
 */
export const buildOpenApiDocument = (): Record<string, unknown> => {
  const registry = new OpenAPIRegistry();
  const refs = new Map<z.ZodTypeAny, z.ZodTypeAny>();
  const usedNames = new Set<string>();

  const register = (schema: z.ZodTypeAny, preferredName: string): z.ZodTypeAny => {
    const existing = refs.get(schema);
    if (existing !== undefined) return existing;
    let name = preferredName;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${preferredName}${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    const ref = registry.register(name, schema);
    refs.set(schema, ref);
    return ref;
  };

  const apiErrorRef = register(ApiErrorResponseSchema, 'ApiErrorResponse');
  // Shared by the client-invitation creation and the resend; a route-based name would lie about it.
  register(InvitationCreatedResponseSchema, 'invitationCreatedResponse');
  const componentError = errorExample({ status: 500, code: 'INTERNAL_ERROR' });
  assertExample(ApiErrorResponseSchema, componentError, 'ApiErrorResponse');

  for (const route of DOCUMENTED_ROUTES) {
    if (route.requestExample !== undefined) {
      const requestSchema = route.body ?? route.query;
      if (requestSchema === undefined) {
        throw new Error(`The route ${route.method.toUpperCase()} ${route.path} declares a request example without a body or query schema.`);
      }
      assertExample(requestSchema, route.requestExample, `${route.method.toUpperCase()} ${route.path} request`);
    }

    const responses: Record<string, unknown> = {};
    for (const response of route.responses) {
      if (response.schema !== undefined) {
        if (response.example === undefined) {
          throw new Error(`The route ${route.method.toUpperCase()} ${route.path} documents a ${response.status} response without an example.`);
        }
        assertExample(response.schema, response.example, `${route.method.toUpperCase()} ${route.path} ${response.status}`);
      }
      responses[String(response.status)] = {
        description: response.description,
        ...(response.schema === undefined
          ? {}
          : {
              content: {
                'application/json': {
                  schema: register(response.schema, `${route.operationId}Response`),
                  example: response.example
                }
              }
            })
      };
    }

    for (const [status, errors] of groupErrorsByStatus(route.errors)) {
      const example = errorExample(errors[0]!);
      assertExample(ApiErrorResponseSchema, example, `${route.method.toUpperCase()} ${route.path} ${status}`);
      responses[String(status)] = {
        description: errors.map((error) => `${error.code}: ${error.message ?? ERROR_MESSAGES[error.code] ?? ''}`.trim()).join(' | '),
        content: { 'application/json': { schema: apiErrorRef, example } }
      };
    }

    // A route that declares `z.undefined()` as its body accepts no body at all; OpenAPI has no way
    // to express that as a request body, so it is documented as having none. The route still
    // validates the body, which is what turns an unexpected one into a 400.
    const hasRequestBody = route.body !== undefined && !(route.body instanceof z.ZodUndefined);
    registry.registerPath({
      method: route.method,
      path: toOpenApiPath(route.path),
      operationId: route.operationId,
      summary: route.summary,
      description: `${route.description}\n\nAcesso: ${route.access}.${route.permission === null ? '' : ` Permissão exigida: ${permissionLabel(route.permission)}.`}`,
      tags: [route.module],
      'x-permission': route.permission,
      request: {
        params: route.params,
        query: route.query,
        body: !hasRequestBody
          ? undefined
          : {
              required: true,
              content: {
                'application/json': {
                  schema: register(route.body!, `${route.operationId}Request`),
                  ...(route.requestExample === undefined ? {} : { example: route.requestExample })
                }
              }
            }
      },
      responses: responses as never
    });
  }

  const tags = (Object.keys(MODULE_DESCRIPTIONS) as ApiModule[]).map((module) => ({
    name: module,
    description: MODULE_DESCRIPTIONS[module]
  }));

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const document = generator.generateDocument({
    openapi: '3.1.0',
    info: { ...API_DOCUMENT_INFO },
    tags
  });
  return document as unknown as Record<string, unknown>;
};
