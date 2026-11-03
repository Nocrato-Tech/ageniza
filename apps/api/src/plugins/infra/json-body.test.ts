import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CompleteMediaUploadRequestSchema } from '@ageniza/contracts';

import { registerErrorHandling } from './errors.js';
import { findJsonOverreach, MAX_JSON_CONTAINERS, MAX_JSON_NESTING, MAX_JSON_SEPARATORS, registerBoundedJsonParser } from './json-body.js';
import { routeBody } from './zod.js';

const json = { 'content-type': 'application/json' };

const nested = (levels: number): string => '['.repeat(levels) + ']'.repeat(levels);
const flatObjects = (count: number): string => `[${new Array<string>(count).fill('{}').join(',')}]`;

describe('findJsonOverreach: the scan of the text of a body', () => {
  it('takes the deepest nesting, and refuses one level more', () => {
    expect(findJsonOverreach(nested(64))).toBeUndefined();
    expect(findJsonOverreach(nested(65))?.details).toEqual({
      issues: [{ path: '', code: 'too_big', message: 'Nesting must be at most 64 levels' }]
    });
  });

  it('takes the most lists and objects, and refuses one more', () => {
    expect(findJsonOverreach(flatObjects(10_099))).toBeUndefined();
    expect(findJsonOverreach(flatObjects(10_100))?.details).toEqual({
      issues: [{ path: '', code: 'too_big', message: 'The body must have at most 10100 lists and objects' }]
    });
  });

  it('takes the most commas, and refuses one more (a list of scalars is one container)', () => {
    const scalars = (count: number): string => `[${new Array<number>(count).fill(1).join(',')}]`;
    expect(findJsonOverreach(scalars(40_101))).toBeUndefined();
    expect(findJsonOverreach(scalars(40_102))?.details).toEqual({
      issues: [{ path: '', code: 'too_big', message: 'The body must have at most 40100 values and keys' }]
    });
  });

  it('counts the colons as well: an object of a single container with a key for every value', () => {
    const keyed = (count: number): string => `{${Array.from({ length: count }, (_, index) => `"${index}":1.5`).join(',')}}`;
    expect(findJsonOverreach(keyed(20_050))).toBeUndefined();
    expect(findJsonOverreach(keyed(20_051))).not.toBeUndefined();
  });

  it('does not count commas and colons inside a string', () => {
    expect(findJsonOverreach(`{"note":"${',:'.repeat(50_000)}","x":1}`)).toBeUndefined();
    expect(findJsonOverreach(`{"note":"\\"${',:'.repeat(50_000)}","x":1}`)).toBeUndefined();
  });

  it('counts a list that closes: siblings are not depth', () => {
    expect(findJsonOverreach(`[${new Array<string>(200).fill('[]').join(',')}]`)).toBeUndefined();
  });

  it('does not count brackets inside a string', () => {
    expect(findJsonOverreach(`{"note":"${'['.repeat(100)}"}`)).toBeUndefined();
    expect(findJsonOverreach(`{"note":"${'{}'.repeat(20_000)}"}`)).toBeUndefined();
  });

  it('does not end a string at an escaped quote', () => {
    expect(findJsonOverreach(`{"note":"\\"${'['.repeat(100)}"}`)).toBeUndefined();
  });

  it('does end a string at a quote that follows an escaped backslash', () => {
    expect(findJsonOverreach(`{"note":"\\\\","list":${nested(70)}}`)).not.toBeUndefined();
  });

  it('leaves text that is not JSON to the parser', () => {
    expect(findJsonOverreach('')).toBeUndefined();
    expect(findJsonOverreach('}}]]{{')).toBeUndefined();
  });

  it('keeps the limits above the largest legitimate body (10 000 parts of a multipart completion)', () => {
    const body = JSON.stringify({ parts: Array.from({ length: 10_000 }, (_, index) => ({ partNumber: index + 1, eTag: `"${'a'.repeat(32)}"` })) });
    expect(findJsonOverreach(body)).toBeUndefined();
    expect(MAX_JSON_CONTAINERS).toBeGreaterThan(10_002);
    // 4 separators per part (two colons, one comma inside, one after, but the last) and the colon of "parts": the arithmetic of MAX_JSON_SEPARATORS.
    expect(body.match(/[,:]/g)).toHaveLength(40_000);
    expect(MAX_JSON_SEPARATORS).toBeGreaterThan(40_000);
    expect(MAX_JSON_NESTING).toBeGreaterThan(4);
  });
});

describe('the JSON parser of the application', () => {
  let bounded: FastifyInstance;
  let stock: FastifyInstance;

  const build = async (withBoundedParser: boolean): Promise<FastifyInstance> => {
    const app = Fastify({ bodyLimit: 1_048_576 });
    if (withBoundedParser) registerBoundedJsonParser(app);
    registerErrorHandling(app);
    const schema = z.unknown();
    const docs = { schemas: { body: schema } };
    app.post('/any', { config: { schemas: { body: schema } } }, async (request) => ({ received: routeBody(docs, request) }));
    app.post('/small', { bodyLimit: 64, config: { schemas: { body: schema } } }, async (request) => ({ received: routeBody(docs, request) }));
    const completeDocs = { schemas: { body: CompleteMediaUploadRequestSchema } };
    app.post('/complete', { config: { schemas: { body: CompleteMediaUploadRequestSchema } } }, async (request) => ({ parts: routeBody(completeDocs, request).parts?.length }));
    await app.ready();
    return app;
  };

  beforeAll(async () => {
    bounded = await build(true);
    stock = await build(false);
  });
  afterAll(async () => {
    await bounded.close();
    await stock.close();
  });

  const post = async (app: FastifyInstance, url: string, payload: string | undefined) =>
    app.inject({ method: 'POST', url, headers: json, ...(payload === undefined ? {} : { payload }) });

  const answer = async (app: FastifyInstance, url: string, payload: string | undefined) => {
    const response = await post(app, url, payload);
    return { status: response.statusCode, code: (response.json() as { error?: { code?: string } }).error?.code };
  };

  it('refuses a body nested past the limit before parsing it, in the envelope of a validation error', async () => {
    const response = await post(bounded, '/any', nested(65));

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: { issues: [{ path: '', code: 'too_big', message: 'Nesting must be at most 64 levels' }] }
    });
  });

  it('takes a body at the nesting limit', async () => {
    expect((await post(bounded, '/any', nested(64))).statusCode).toBe(200);
  });

  it('refuses a list of lists past the limit of lists and objects', async () => {
    expect((await post(bounded, '/any', flatObjects(10_100))).statusCode).toBe(400);
  });

  it('takes the completion of a multipart upload with 10 000 parts of the contract', async () => {
    const body = JSON.stringify({ parts: Array.from({ length: 10_000 }, (_, index) => ({ partNumber: index + 1, eTag: `"${'a'.repeat(32)}"` })) });

    const response = await post(bounded, '/complete', body);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ parts: 10_000 });
  });

  it.each([
    ['an empty body', ''],
    ['text that is not JSON', '{"a":'],
    ['__proto__ in an object', '{"__proto__":{"admin":true}}'],
    ['__proto__ nested', '{"a":{"__proto__":{"admin":true}}}'],
    ['constructor with a prototype', '{"constructor":{"prototype":{"admin":true}}}']
  ])('answers %s as Fastify\'s own parser does', async (_label, payload) => {
    const stockAnswer = await answer(stock, '/any', payload);

    expect(stockAnswer.status).toBe(400);
    expect(await answer(bounded, '/any', payload)).toEqual(stockAnswer);
  });

  it('refuses __proto__ and constructor poisoning (not parsed into the object)', async () => {
    expect((await post(bounded, '/any', '{"__proto__":{"admin":true}}')).statusCode).toBe(400);
    expect((await post(bounded, '/any', '{"constructor":{"prototype":{"admin":true}}}')).statusCode).toBe(400);
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });

  it('answers a body over the limit of the route as Fastify does', async () => {
    const payload = JSON.stringify({ text: 'x'.repeat(200) });

    const stockAnswer = await answer(stock, '/small', payload);

    expect(stockAnswer.status).toBe(413);
    expect(await answer(bounded, '/small', payload)).toEqual(stockAnswer);
  });

  it('still takes an ordinary body, and a charset in the content type', async () => {
    const response = await bounded.inject({ method: 'POST', url: '/any', headers: { 'content-type': 'application/json; charset=utf-8' }, payload: '{"a":[1,2,{"b":"c"}]}' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: { a: [1, 2, { b: 'c' }] } });
  });
});
