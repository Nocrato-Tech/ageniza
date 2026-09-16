import { HealthResponseSchema } from '@ageniza/contracts';
import { describe, expect, it } from 'vitest';

import { HttpClient } from './http.js';
import type { HttpClientError } from './http.js';

const clientWith = (implementation: typeof fetch): HttpClient => new HttpClient('http://127.0.0.1:3001', implementation);

describe('HttpClient', () => {
  it('parses stable API errors and preserves the server correlation id', async () => {
    let requestId: string | null = null;
    const client = clientWith(async (_input, init) => {
      requestId = new Headers(init?.headers).get('x-request-id');
      return new Response(JSON.stringify({
        error: { code: 'VALIDATION_FAILED', message: 'The request is invalid.' },
        meta: { requestId: 'request-123' }
      }), { status: 422, headers: { 'content-type': 'application/json' } });
    });

    await expect(client.request({ path: '/test', response: HealthResponseSchema })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED', status: 422, requestId: 'request-123'
    } satisfies Partial<HttpClientError>);
    expect(requestId).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it('cancels an in-flight request when the caller aborts it', async () => {
    const abortController = new AbortController();
    const client = clientWith((_input, init) => new Promise<Response>((_resolve, reject) => {
      const cancel = () => reject(new DOMException('cancelled', 'AbortError'));
      if (init?.signal?.aborted) cancel();
      else init?.signal?.addEventListener('abort', cancel);
    }));
    const request = client.request({ path: '/test', response: HealthResponseSchema, signal: abortController.signal });
    abortController.abort();

    await expect(request).rejects.toMatchObject({ code: 'ABORTED' } satisfies Partial<HttpClientError>);
  });

  it('distinguishes a client timeout from a caller cancellation', async () => {
    const client = clientWith((_input, init) => new Promise<Response>((_resolve, reject) => {
      const cancel = () => reject(new DOMException('timed out', 'AbortError'));
      if (init?.signal?.aborted) cancel();
      else init?.signal?.addEventListener('abort', cancel);
    }));

    await expect(client.request({ path: '/test', response: HealthResponseSchema, timeoutMs: 1 })).rejects.toMatchObject({
      code: 'TIMEOUT'
    } satisfies Partial<HttpClientError>);
  });

  it('keeps bearer-token injection inside the transport boundary', async () => {
    let authorization: string | null = null;
    const client = new HttpClient('http://127.0.0.1:3001', async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }, async () => 'session-token');

    await expect(client.request({
      path: '/health',
      response: HealthResponseSchema,
      headers: { authorization: 'Bearer caller-controlled-token' }
    })).resolves.toEqual({ status: 'ok' });
    expect(authorization).toBe('Bearer session-token');
  });

  it('removes caller-provided authorization when there is no current session', async () => {
    let authorization: string | null = 'not-observed';
    const client = new HttpClient('http://127.0.0.1:3001', async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });

    await client.request({ path: '/health', response: HealthResponseSchema, headers: { authorization: 'Bearer untrusted' } });
    expect(authorization).toBeNull();
  });

  it('rejects absolute, cross-origin, and invalid timeout requests before fetch', async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });

    await expect(client.request({ path: 'https://evil.example/steal', response: HealthResponseSchema })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.request({ path: '//evil.example/steal', response: HealthResponseSchema })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.request({ path: '/health', timeoutMs: 0, response: HealthResponseSchema })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.request({ path: '/health', timeoutMs: Number.NaN, response: HealthResponseSchema })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toBe(0);
  });
});
