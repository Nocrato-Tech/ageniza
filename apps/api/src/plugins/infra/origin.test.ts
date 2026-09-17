import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerOriginProtection } from './origin.js';

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
