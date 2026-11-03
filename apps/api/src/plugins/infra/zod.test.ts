import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as contracts from '@ageniza/contracts';
import { CompleteMediaUploadRequestSchema } from '@ageniza/contracts';
import { HttpError } from '@ageniza/core';

import { MAX_REQUEST_ARRAY_ELEMENTS, parseStrictEmptyQuery, routeBody, routeQuery, routeResponse } from './zod.js';

interface FakeRequest {
  readonly routeOptions: { readonly url: string; readonly config: { readonly schemas: Readonly<Record<string, unknown>> } };
  readonly body?: unknown;
  readonly query?: unknown;
}

const requestWith = (schemas: Readonly<Record<string, unknown>>, values: Partial<FakeRequest> = {}): FakeRequest => ({
  routeOptions: { url: '/probe', config: { schemas } },
  ...values
});

/**
 * Issue #192: the route helpers read the schema from the route's own config and refuse one handed to
 * them by the handler. These are the unit-level counterpart of the integration mutations that the
 * documented routes must fail.
 */
describe('route schema helpers (issue #192)', () => {
  const bodySchema = z.object({ email: z.string().email() }).strict();
  const bodyDocs = { schemas: { body: bodySchema } };

  it('parses the body with the schema the route declares', () => {
    const request = requestWith({ body: bodySchema }, { body: { email: 'a@b.test' } });
    expect(routeBody(bodyDocs, request as never)).toEqual({ email: 'a@b.test' });
  });

  it('refuses a body schema that is not the one declared in the route config', () => {
    const request = requestWith({ body: bodySchema }, { body: { email: 'a@b.test' } });
    expect(() => routeBody({ schemas: { body: bodySchema.passthrough() } }, request as never))
      .toThrow(/must validate its body with the schema declared in its route config/);
  });

  it('parses a response payload with the declared schema and rejects a different shape', () => {
    const responseSchema = z.object({ value: z.string() }).strict();
    const responseDocs = { schemas: { response: responseSchema } };
    const request = requestWith({ response: responseSchema });

    expect(routeResponse(responseDocs, request as never, { value: 'x' })).toEqual({ value: 'x' });
    expect(() => routeResponse(responseDocs, request as never, { value: 'x', extra: 1 })).toThrow();
    expect(() => routeResponse({ schemas: { response: responseSchema.passthrough() } }, request as never, { value: 'x' }))
      .toThrow(/must validate its response with the schema declared in its route config/);
  });

  it('rejects any query parameter on the documented-empty routes', () => {
    expect(() => parseStrictEmptyQuery({ query: {} } as never)).not.toThrow();
    expect(() => parseStrictEmptyQuery({ query: { page: '1' } } as never)).toThrow();
  });
});

/**
 * GHSA-mrhx-c7xc-m3w5: zod 3 adds one issue per failing element of an array even when the array is already over its `.max()`, with
 * no ceiling. The ceiling is checked in the one function every request value goes through, before the schema runs.
 */
describe('arrays of a request are bounded before the schema counts them', () => {
  const refusal = (run: () => unknown): { statusCode: number; code: string; issues: Array<{ path: string; code: string; message: string }> } => {
    try {
      run();
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return { statusCode: error.statusCode, code: error.code, issues: (error.details as { issues: never[] }).issues };
    }
    throw new Error('The request was accepted.');
  };

  const zeros = (count: number): number[] => new Array<number>(count).fill(0);

  it('still takes the largest array a contract accepts (the parts of a multipart upload)', () => {
    const request = requestWith(
      { body: CompleteMediaUploadRequestSchema },
      { body: { parts: Array.from({ length: 10_000 }, (_, index) => ({ partNumber: index + 1, eTag: 'tag' })) } }
    );

    expect(routeBody({ schemas: { body: CompleteMediaUploadRequestSchema } }, request as never).parts).toHaveLength(10_000);
  });

  it('refuses one element past the ceiling with a single issue, and never runs the schema', () => {
    let schemaRuns = 0;
    const schema = z.object({ values: z.array(z.number().min(1)).superRefine(() => { schemaRuns += 1; }) }).strict();
    const request = requestWith({ body: schema }, { body: { values: zeros(10_001) } });

    expect(refusal(() => routeBody({ schemas: { body: schema } }, request as never)))
      .toEqual({ statusCode: 400, code: 'VALIDATION_ERROR', issues: [{ path: 'values', code: 'too_big', message: 'Array must have at most 10000 elements' }] });
    expect(schemaRuns).toBe(0);
  });

  it('names the path of an array nested in an object and in another array', () => {
    const schema = z.object({}).passthrough();
    const nestedInObject = requestWith({ body: schema }, { body: { outer: { inner: zeros(10_001) } } });
    const nestedInArray = requestWith({ body: schema }, { body: { list: [{ ok: true }, [zeros(10_001)]] } });

    expect(refusal(() => routeBody({ schemas: { body: schema } }, nestedInObject as never)).issues.map((issue) => issue.path)).toEqual(['outer.inner']);
    expect(refusal(() => routeBody({ schemas: { body: schema } }, nestedInArray as never)).issues.map((issue) => issue.path)).toEqual(['list.1.0']);
  });

  it('bounds the query as it bounds the body', () => {
    const schema = z.object({ id: z.array(z.string()) }).strict();
    const request = requestWith({ query: schema }, { query: { id: new Array<string>(10_001).fill('x') } });

    expect(refusal(() => routeQuery({ schemas: { query: schema } }, request as never)).issues.map((issue) => issue.code)).toEqual(['too_big']);
  });

  it('walks a body nested far deeper than the stack without overflowing', () => {
    let body: unknown = zeros(10_001);
    for (let depth = 0; depth < 100_000; depth += 1) body = [body];
    const schema = z.unknown();

    expect(refusal(() => routeBody({ schemas: { body: schema } }, requestWith({ body: schema }, { body }) as never)).code).toBe('VALIDATION_ERROR');
  });

  it('lists at most the first MAX_REPORTED_ISSUES issues of a body that fails everywhere', () => {
    const schema = z.object({ values: z.array(z.number().min(1)) }).strict();
    const request = requestWith({ body: schema }, { body: { values: zeros(5_000) } });

    const { issues } = refusal(() => routeBody({ schemas: { body: schema } }, request as never));
    expect(issues).toHaveLength(100);
    expect(issues[0]).toMatchObject({ path: 'values.0', code: 'too_small' });
  });
});

/**
 * The ceiling must not refuse a request a contract accepts. Every schema the contracts export for a request body, query or path is
 * walked, and every list in it must have a `.max()` that the ceiling covers.
 */
describe('no request contract allows more than the ceiling', () => {
  interface Def { readonly typeName?: string; readonly [key: string]: unknown }
  const maxima: Array<{ readonly where: string; readonly max: number | undefined }> = [];

  const visit = (schema: unknown, where: string, seen: Set<unknown>): void => {
    if (typeof schema !== 'object' || schema === null || seen.has(schema)) return;
    seen.add(schema);
    const def = (schema as { _def?: Def })._def;
    if (def === undefined) return;
    const next = (child: unknown, label: string): void => visit(child, `${where}.${label}`, seen);
    switch (def.typeName) {
      case 'ZodArray':
        maxima.push({ where, max: (def.maxLength as { value: number } | null)?.value });
        next(def.type, '[]');
        break;
      case 'ZodObject':
        for (const [key, child] of Object.entries((def.shape as () => Record<string, unknown>)())) next(child, key);
        break;
      case 'ZodUnion':
      case 'ZodDiscriminatedUnion':
        for (const option of [...(def.options as Iterable<unknown>)]) next(option, '|');
        break;
      case 'ZodEffects': next(def.schema, 'fx'); break;
      case 'ZodOptional': case 'ZodNullable': case 'ZodDefault': case 'ZodReadonly': next(def.innerType, '?'); break;
      case 'ZodPipeline': next(def.in, 'in'); next(def.out, 'out'); break;
      case 'ZodRecord': next(def.valueType, '{}'); break;
      case 'ZodIntersection': next(def.left, '&l'); next(def.right, '&r'); break;
      default: break;
    }
  };

  for (const [name, schema] of Object.entries(contracts)) {
    if (/(Request|Query|Params)Schema$/.test(name)) visit(schema, name, new Set());
  }

  it('finds the lists of the request contracts, the largest being the 10 000 parts of a multipart upload', () => {
    expect(maxima.length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...maxima.map((entry) => entry.max ?? 0))).toBe(10_000);
  });

  it('gives every list of a request an explicit maximum no larger than the ceiling', () => {
    expect(maxima.filter((entry) => entry.max === undefined || entry.max > MAX_REQUEST_ARRAY_ELEMENTS)).toEqual([]);
  });
});
