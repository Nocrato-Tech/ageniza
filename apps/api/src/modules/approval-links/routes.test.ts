import { randomBytes } from 'node:crypto';

import type { DatabaseClient } from '@ageniza/database';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { registerErrorHandling } from '../../plugins/infra/errors.js';
import { APPROVAL_COOKIE_NAME } from './policy.js';
import { registerApprovalLinkModule } from './routes.js';

// What the routes of the approval link answer when the database refuses (issue #712), without a database: a fake that fails with the
// code the function raises. The real functions raise these codes in `packages/database/test/portal-approval-links.integration.test.ts`;
// this proves the translation of each, and that a request without a valid-looking cookie never reaches the database.
const CONTENT_ID = '00000000-0000-4000-8000-000000000001';
const sessionCookie = (): string => `${APPROVAL_COOKIE_NAME}=${randomBytes(32).toString('base64url')}`;
const origin = { origin: 'http://127.0.0.1:5173' };

const databaseError = (code: string): Error => Object.assign(new Error(`database said ${code} about ana@padaria.test`), { code });

const build = async (fail: (() => Error) | undefined) => {
  let calls = 0;
  const database = {
    transaction: async () => {
      calls += 1;
      throw fail?.() ?? new Error('unexpected');
    }
  } as unknown as DatabaseClient;
  const app = Fastify();
  registerErrorHandling(app);
  registerApprovalLinkModule(app, { database, cookie: { path: '/portal-approval', secure: false } });
  await app.ready();
  return { app, calls: () => calls };
};

const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const requests = {
  exchange: () => ({ method: 'POST' as const, url: '/portal-approval/session', headers: origin, payload: { token: randomBytes(32).toString('base64url') } }),
  batch: (cookie: string) => ({ method: 'GET' as const, url: '/portal-approval/batch', headers: { cookie } }),
  approve: (cookie: string) => ({ method: 'POST' as const, url: `/portal-approval/contents/${CONTENT_ID}/approve`, headers: { ...origin, cookie }, payload: { revision: 1 } }),
  changes: (cookie: string) => ({ method: 'POST' as const, url: `/portal-approval/contents/${CONTENT_ID}/request-changes`, headers: { ...origin, cookie }, payload: { revision: 1, comment: 'Troque.' } })
};

describe('the routes of the approval link translate what the database refuses (issue #712)', () => {
  it.each([
    ['A0100', 404, 'APPROVAL_LINK_INVALID'],
    ['A0090', 404, 'APPROVAL_LINK_INVALID'],
    ['A0060', 404, 'NOT_FOUND'],
    ['A0062', 409, 'CONTENT_NOT_AWAITING_APPROVAL'],
    ['A0063', 409, 'CONTENT_REVISION_CHANGED'],
    ['A0068', 400, 'CONTENT_COMMENT_INVALID'],
    ['40001', 409, 'TRY_AGAIN'],
    ['40P01', 409, 'TRY_AGAIN']
  ])('answers %s as %i %s on the two decisions, and never shows the text of the database', async (code, status, apiCode) => {
    const { app } = await build(() => databaseError(code));
    apps.push(app);
    const cookie = sessionCookie();
    for (const request of [requests.approve(cookie), requests.changes(cookie)]) {
      const reply = await app.inject(request);
      expect(reply.statusCode, `${request.url} ${code}`).toBe(status);
      expect(reply.json().error.code).toBe(apiCode);
      expect(reply.body).not.toContain('ana@padaria.test');
      expect(reply.headers['cache-control']).toBe('no-store');
    }
  });

  it.each([
    ['A0100', 404, 'APPROVAL_LINK_INVALID'],
    ['A0090', 404, 'APPROVAL_LINK_INVALID'],
    ['40001', 409, 'TRY_AGAIN'],
    ['40P01', 409, 'TRY_AGAIN']
  ])('answers %s as %i %s when it reads the batch or exchanges the token', async (code, status, apiCode) => {
    const { app } = await build(() => databaseError(code));
    apps.push(app);
    for (const request of [requests.batch(sessionCookie()), requests.exchange()]) {
      const reply = await app.inject(request);
      expect(reply.statusCode, request.url).toBe(status);
      expect(reply.json().error.code).toBe(apiCode);
      expect(reply.body).not.toContain('ana@padaria.test');
    }
  });

  it('answers an error it does not know as an internal error, with nothing of it in the body', async () => {
    const { app } = await build(() => databaseError('XX000'));
    apps.push(app);
    const reply = await app.inject(requests.approve(sessionCookie()));
    expect(reply.statusCode).toBe(500);
    expect(reply.json().error.code).toBe('INTERNAL_ERROR');
    expect(reply.body).not.toContain('ana@padaria.test');
  });

  it('never reaches the database without a cookie, or with one that is not the shape of a session', async () => {
    const built = await build(() => databaseError('A0100'));
    apps.push(built.app);
    for (const cookie of ['', `${APPROVAL_COOKIE_NAME}=curto`, `${APPROVAL_COOKIE_NAME}=${'a'.repeat(44)}`, 'other=1', `${APPROVAL_COOKIE_NAME}=${'$'.repeat(43)}`]) {
      for (const request of [requests.batch(cookie), requests.approve(cookie), requests.changes(cookie)]) {
        const reply = await built.app.inject({ ...request, headers: { ...request.headers, cookie } });
        expect(reply.statusCode, `${request.url} ${cookie}`).toBe(404);
        expect(reply.json().error.code).toBe('APPROVAL_LINK_INVALID');
      }
    }
    expect(built.calls()).toBe(0);
  });

  it('never reaches the database with a token that is not the shape of one, or with a query', async () => {
    const built = await build(() => databaseError('A0100'));
    apps.push(built.app);
    for (const token of ['curto', 'a'.repeat(44), '$'.repeat(43), 'a'.repeat(300)]) {
      const reply = await built.app.inject({ method: 'POST', url: '/portal-approval/session', headers: origin, payload: { token } });
      expect(reply.statusCode, token.slice(0, 10)).toBe(400);
    }
    const withQuery = await built.app.inject({ method: 'POST', url: `/portal-approval/session?token=${randomBytes(32).toString('base64url')}`, headers: origin, payload: { token: randomBytes(32).toString('base64url') } });
    expect(withQuery.statusCode).toBe(400);
    expect(built.calls()).toBe(0);
  });
});
