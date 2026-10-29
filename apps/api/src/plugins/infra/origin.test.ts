import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';

import { registerOriginProtection } from './origin.js';

// The first Fastify() and inject of the process pay their cold start here, not in the first test (#496).
beforeAll(async () => {
  const warmup = Fastify();
  warmup.get('/warmup', async () => ({ ok: true }));
  await warmup.inject('/warmup');
  await warmup.close();
}, 60_000);

describe('global origin protection', () => {
  it('rejects every state-changing method without the exact configured origin', async () => {
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const anticipated = error as { statusCode?: number; code?: string };
      return reply.status(anticipated.statusCode ?? 500).send({ code: anticipated.code ?? 'INTERNAL_ERROR' });
    });
    registerOriginProtection(app, { appPublicUrl: 'https://app.example.test/path' });
    app.post('/resource', async () => ({ ok: true }));
    app.put('/resource', async () => ({ ok: true }));
    app.patch('/resource', async () => ({ ok: true }));
    app.delete('/resource', async () => ({ ok: true }));

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const missing = await app.inject({ method, url: '/resource' });
      expect(missing.statusCode).toBe(403);
      expect(missing.json()).toMatchObject({ code: 'CSRF_REJECTED' });

      const wrong = await app.inject({ method, url: '/resource', headers: { origin: 'https://other.example.test' } });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toMatchObject({ code: 'CSRF_REJECTED' });
    }

    await app.close();
  });

  it('allows safe methods and the exact URL origin, ignoring path components', async () => {
    const app = Fastify();
    registerOriginProtection(app, { appPublicUrl: 'https://app.example.test/path' });
    app.get('/resource', { exposeHeadRoute: false }, async () => ({ ok: true }));
    app.head('/resource', async () => undefined);
    app.options('/resource', async () => ({ ok: true }));
    app.post('/resource', async () => ({ ok: true }));

    expect((await app.inject({ method: 'GET', url: '/resource' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'HEAD', url: '/resource' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'OPTIONS', url: '/resource' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/resource', headers: { origin: 'https://app.example.test' } })).statusCode).toBe(200);

    await app.close();
  });
});

describe('origin protection for the native app', () => {
  const build = async (mobileAppOrigins?: readonly string[]) => {
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.status((error as { statusCode?: number }).statusCode ?? 500).send({ code: (error as { code?: string }).code ?? 'INTERNAL_ERROR' }));
    registerOriginProtection(app, { appPublicUrl: 'https://app.example.test', ...(mobileAppOrigins === undefined ? {} : { mobileAppOrigins }) });
    app.post('/resource', async () => ({ ok: true }));
    return app;
  };

  it('refuses the app\'s origin while no scheme is listed, however it is sent', async () => {
    for (const mobileAppOrigins of [undefined, []]) {
      const app = await build(mobileAppOrigins);
      for (const headers of [{ 'expo-origin': 'ageniza://' }, { origin: 'ageniza://' }, { 'expo-origin': 'https://app.example.test' }]) {
        const response = await app.inject({ method: 'POST', url: '/resource', headers });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: 'CSRF_REJECTED' });
      }
      await app.close();
    }
  });

  it('accepts a listed scheme as expo-origin or as Origin', async () => {
    const app = await build(['ageniza://']);
    const viaExpo = await app.inject({ method: 'POST', url: '/resource', headers: { 'expo-origin': 'ageniza:///' } });
    expect(viaExpo.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/resource', headers: { origin: 'ageniza://' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/resource', headers: { origin: 'https://app.example.test' } })).statusCode).toBe(200);
    await app.close();
  });

  it('refuses a scheme that is not listed, and a missing origin', async () => {
    const app = await build(['ageniza://']);
    for (const headers of [{ 'expo-origin': 'evil://' }, { origin: 'evil://' }, { 'expo-origin': 'https://evil.test' }, {}]) {
      const response = await app.inject({ method: 'POST', url: '/resource', headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(403);
    }
    await app.close();
  });

  it('never lets expo-origin outvote an Origin that was sent', async () => {
    const app = await build(['ageniza://']);
    const response = await app.inject({ method: 'POST', url: '/resource', headers: { origin: 'https://evil.test', 'expo-origin': 'ageniza://' } });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
