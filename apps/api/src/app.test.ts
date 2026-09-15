import { describe, expect, it } from 'vitest';

import { loadApiConfig } from '@ageniza/config/server';
import { createReadiness, type HealthCheck } from '@ageniza/core';

import { buildApp } from './app.js';

const config = loadApiConfig({
  APP_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  API_CORS_ORIGINS: 'http://127.0.0.1:5173',
  API_BODY_LIMIT_BYTES: '1024'
});

describe('API application bootstrap', () => {
  it('serves liveness independently of readiness and reports dependency failures as 503', async () => {
    const readiness = createReadiness(false);
    const failingCheck: HealthCheck = { name: 'database', check: () => { throw new Error('database password must not leak'); } };
    const app = await buildApp({ config, readiness, dependencyChecks: [failingCheck] });

    const liveness = await app.inject('/health');
    expect(liveness.statusCode).toBe(200);
    expect(liveness.json()).toEqual({ status: 'ok' });

    const starting = await app.inject('/ready');
    expect(starting.statusCode).toBe(503);
    expect(starting.json()).toMatchObject({ error: { code: 'NOT_READY' }, meta: { requestId: expect.any(String) } });

    readiness.setReady(true);
    const dependencyFailure = await app.inject('/ready');
    expect(dependencyFailure.statusCode).toBe(503);
    expect(dependencyFailure.body).not.toContain('database password');
    await app.close();
  });

  it('uses a valid inbound correlation ID, generates an invalid or absent one, and includes it in errors', async () => {
    const app = await buildApp({ config });
    const inbound = await app.inject({ url: '/health', headers: { 'x-request-id': 'trace-42' } });
    expect(inbound.headers['x-request-id']).toBe('trace-42');
    expect(inbound.headers['x-correlation-id']).toBe('trace-42');

    const correlated = await app.inject({ url: '/health', headers: { 'x-correlation-id': 'flow-42' } });
    expect(correlated.headers['x-correlation-id']).toBe('flow-42');

    const generated = await app.inject({ url: '/missing', headers: { 'x-request-id': 'invalid id!' } });
    expect(generated.statusCode).toBe(404);
    expect(generated.headers['x-request-id']).toMatch(/^[A-Za-z0-9._:-]+$/);
    expect(generated.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' }, meta: { requestId: generated.headers['x-request-id'] } });
    await app.close();
  });

  it('sanitizes unexpected failures and returns contract-shaped validation errors', async () => {
    const app = await buildApp({ config });
    app.get('/throws', async () => { throw new Error('secret=do-not-expose'); });

    const unexpected = await app.inject('/throws');
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    expect(unexpected.body).not.toContain('secret=do-not-expose');
    expect(unexpected.body).not.toContain('stack');

    const validation = await app.inject('/health?unsupported=value');
    expect(validation.statusCode).toBe(400);
    expect(validation.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' } });
    await app.close();
  });

  it('enforces CORS, security headers, and the global payload size limit', async () => {
    const app = await buildApp({ config });
    app.post('/echo', async () => ({ ok: true }));

    const allowed = await app.inject({ url: '/health', headers: { origin: 'http://127.0.0.1:5173' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    expect(allowed.headers['x-content-type-options']).toBe('nosniff');
    expect(allowed.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(allowed.headers['content-security-policy']).toContain("default-src 'none'");

    const denied = await app.inject({ url: '/health', headers: { origin: 'https://not-allowed.example' } });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const tooLarge = await app.inject({ method: 'POST', url: '/echo', payload: 'a'.repeat(1_025), headers: { 'content-type': 'text/plain' } });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toMatchObject({ error: { code: 'PAYLOAD_TOO_LARGE' } });
    await app.close();
  });

  it('applies rate limiting only to routes that opt in', async () => {
    const app = await buildApp({ config });
    app.get('/limited', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
    app.get('/unlimited', async () => ({ ok: true }));

    expect((await app.inject('/limited')).statusCode).toBe(200);
    const limited = await app.inject('/limited');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED' }, meta: { requestId: expect.any(String) } });
    expect((await app.inject('/unlimited')).statusCode).toBe(200);
    await app.close();
  });

  it('does not trust X-Forwarded-For until an explicit proxy configuration is supplied', async () => {
    const untrusted = await buildApp({ config });
    untrusted.get('/ip', async (request) => ({ ip: request.ip }));
    const forwarded = await untrusted.inject({ url: '/ip', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.10' } });
    expect(forwarded.json()).toEqual({ ip: '127.0.0.1' });
    await untrusted.close();

    const trusted = await buildApp({ config: { ...config, trustedProxyCidrs: ['127.0.0.1'] } });
    trusted.get('/ip', async (request) => ({ ip: request.ip }));
    const trustedForwarded = await trusted.inject({ url: '/ip', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.10' } });
    expect(trustedForwarded.json()).toEqual({ ip: '203.0.113.10' });
    await trusted.close();
  });
});
