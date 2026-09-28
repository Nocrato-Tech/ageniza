import { HealthResponseSchema } from '@ageniza/contracts';
import { describe, expect, it, vi } from 'vitest';

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

  it('never lets a caller attach an Authorization header', async () => {
    let authorization: string | null = 'not-observed';
    const client = new HttpClient('http://127.0.0.1:3001', async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });

    await client.request({ path: '/health', response: HealthResponseSchema, headers: { authorization: 'Bearer untrusted' } });
    // The API authenticates by httpOnly cookie: a page holding a bearer token is the defect.
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

  describe('session end', () => {
    const rejection = (status: number, code: string) => new Response(JSON.stringify({
      error: { code, message: 'Rejected.' }
    }), { status, headers: { 'content-type': 'application/json' } });
    const answering = (status: number, code: string) => async () => rejection(status, code);

    it('ends a confirmed session on the first 401 UNAUTHENTICATED of any request, once', async () => {
      const onSessionEnded = vi.fn();
      const client = new HttpClient('http://127.0.0.1:3001', answering(401, 'UNAUTHENTICATED'), { onSessionEnded });
      client.confirmSession();

      await expect(client.request({ path: '/clients', method: 'POST', body: {}, response: HealthResponseSchema })).rejects.toMatchObject({ status: 401 });
      await expect(client.request({ path: '/clients', response: HealthResponseSchema })).rejects.toMatchObject({ status: 401 });
      expect(onSessionEnded).toHaveBeenCalledTimes(1);
    });

    it('treats a 401 as the ordinary answer while no session has been confirmed', async () => {
      const onSessionEnded = vi.fn();
      const client = new HttpClient('http://127.0.0.1:3001', answering(401, 'UNAUTHENTICATED'), { onSessionEnded });

      await expect(client.request({ path: '/auth/session', response: HealthResponseSchema })).rejects.toMatchObject({ status: 401 });
      expect(onSessionEnded).not.toHaveBeenCalled();
    });

    it('does not mistake a rejected login or another error for a dead session', async () => {
      const onSessionEnded = vi.fn();
      for (const [status, code] of [[401, 'INVALID_CREDENTIALS'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [500, 'INTERNAL_ERROR']] as const) {
        const client = new HttpClient('http://127.0.0.1:3001', answering(status, code), { onSessionEnded });
        client.confirmSession();
        await expect(client.request({ path: '/auth/login', method: 'POST', body: {}, response: HealthResponseSchema })).rejects.toMatchObject({ status });
      }
      expect(onSessionEnded).not.toHaveBeenCalled();
    });

    it('ignores a late 401 from an ended session once the next session is confirmed', async () => {
      const onSessionEnded = vi.fn();
      const pending: Array<(response: Response) => void> = [];
      const client = new HttpClient('http://127.0.0.1:3001', () => new Promise<Response>((resolve) => { pending.push(resolve); }), { onSessionEnded });
      client.confirmSession();

      const first = client.request({ path: '/clients', response: HealthResponseSchema }).catch(() => undefined);
      const second = client.request({ path: '/clients/1', response: HealthResponseSchema }).catch(() => undefined);
      pending[0]?.(rejection(401, 'UNAUTHENTICATED'));
      await first;
      expect(onSessionEnded).toHaveBeenCalledTimes(1);

      client.confirmSession();
      pending[1]?.(rejection(401, 'UNAUTHENTICATED'));
      await second;
      expect(onSessionEnded).toHaveBeenCalledTimes(1);
    });

    it('ignores a 401 from a request sent while signed out, after the next session is confirmed', async () => {
      const onSessionEnded = vi.fn();
      const pending: Array<(response: Response) => void> = [];
      const client = new HttpClient('http://127.0.0.1:3001', () => new Promise<Response>((resolve) => { pending.push(resolve); }), { onSessionEnded });

      const signedOut = client.request({ path: '/clients', response: HealthResponseSchema }).catch(() => undefined);
      client.confirmSession();
      pending[0]?.(rejection(401, 'UNAUTHENTICATED'));
      await signedOut;

      expect(onSessionEnded).not.toHaveBeenCalled();
    });
  });
});
