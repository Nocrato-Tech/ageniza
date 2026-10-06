import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseStrictEmptyQuery, routeBody, routeResponse } from './zod.js';

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
