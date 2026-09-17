import { APIError } from 'better-auth';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { HttpError } from '@ageniza/core';

import { applyAuthCookies, toAuthHeaders, toPublicAuthError } from './bridge.js';

describe('Fastify -> Better Auth bridge', () => {
  it('forwards only cookie/origin/user-agent and always sets the client IP from request.ip', async () => {
    const app = Fastify();
    let captured: Headers | undefined;
    app.post('/probe', async (request) => {
      captured = toAuthHeaders(request);
      return { ok: true };
    });

    await app.inject({
      method: 'POST',
      url: '/probe',
      remoteAddress: '198.51.100.7',
      headers: {
        cookie: 'ageniza.session=abc',
        origin: 'https://app.example.test',
        'user-agent': 'vitest',
        // Attacker-controlled headers below must never reach Better Auth.
        'x-ageniza-client-ip': '203.0.113.99',
        'x-forwarded-for': '203.0.113.100',
        authorization: 'Bearer should-not-forward',
        'x-custom-header': 'should-not-forward'
      }
    });

    expect(captured).toBeDefined();
    const headers = captured as Headers;
    expect(headers.get('cookie')).toBe('ageniza.session=abc');
    expect(headers.get('origin')).toBe('https://app.example.test');
    expect(headers.get('user-agent')).toBe('vitest');
    // Fastify's inject without an explicit trustProxy resolves request.ip to the connection address,
    // never the client-supplied x-ageniza-client-ip or x-forwarded-for.
    expect(headers.get('x-ageniza-client-ip')).toBe('198.51.100.7');
    expect(headers.get('x-ageniza-client-ip')).not.toBe('203.0.113.99');
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-custom-header')).toBeNull();
    expect([...headers.keys()].sort()).toEqual(['cookie', 'origin', 'user-agent', 'x-ageniza-client-ip']);

    await app.close();
  });

  it('copies every set-cookie from a returnHeaders result onto the Fastify reply', async () => {
    const app = Fastify();
    app.get('/probe', async (_request, reply) => {
      const headers = new Headers();
      headers.append('set-cookie', 'a=1; Path=/');
      headers.append('set-cookie', 'b=2; Path=/');
      applyAuthCookies(reply, headers);
      return { ok: true };
    });

    const response = await app.inject('/probe');
    expect(response.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    await app.close();
  });

  it('sets no set-cookie header when there is nothing to copy', async () => {
    const app = Fastify();
    app.get('/probe', async (_request, reply) => {
      applyAuthCookies(reply, new Headers());
      return { ok: true };
    });

    const response = await app.inject('/probe');
    expect(response.headers['set-cookie']).toBeUndefined();
    await app.close();
  });

  describe('toPublicAuthError', () => {
    it('converts a Better Auth APIError into the fallback shape without leaking its own message or code', () => {
      const secretMessage = 'Better Auth internal detail: user record mismatch #4471';
      const original = new APIError('UNAUTHORIZED', { message: secretMessage, code: 'INVALID_EMAIL_OR_PASSWORD' });

      const result = toPublicAuthError(original, { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas.' });

      expect(result).toBeInstanceOf(HttpError);
      expect(result.statusCode).toBe(401);
      expect(result.code).toBe('INVALID_CREDENTIALS');
      expect(result.message).toBe('Credenciais inválidas.');
      expect(result.message).not.toContain(secretMessage);
      expect(JSON.stringify(result)).not.toContain(secretMessage);
      expect(JSON.stringify(result)).not.toContain('INVALID_EMAIL_OR_PASSWORD');
    });

    it('rethrows anything that is not a Better Auth APIError', () => {
      const unexpected = new Error('database is down');
      expect(() => toPublicAuthError(unexpected, { statusCode: 401, code: 'INVALID_CREDENTIALS', message: 'x' })).toThrow(unexpected);
    });
  });
});
