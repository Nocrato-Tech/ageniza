import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@ageniza/database';

import {
  buildTestApp,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp
} from './test-support/harness.js';

// Decision 2026-10-27, "a conta de convite só entra depois de confirmar". The one unconfirmed account that holds a
// session is the one an invitation created (`unconfirmed_account_may_hold_session`), and that session opens nothing:
// not the agency, not the portal, not the contexts, until the e-mail is confirmed. The three purposes are attacked one
// by one. The account holds every link at once, so a guard that refuses only the link of the invitation's own purpose
// still lets the others through and the test fails.
const origin = { origin: TEST_APP_PUBLIC_URL };

type Purpose = 'agency_activation' | 'collaborator_invite' | 'client_invite';
const PURPOSES: readonly Purpose[] = ['agency_activation', 'collaborator_invite', 'client_invite'];

/** Every route Fastify registered, collected by the `onRoute` observer before the app is ready. */
const registeredRoutes: { method: string; url: string }[] = [];

let owner: DatabaseClient;
let app: TestApp;
let adminRoleId = '';
const createdUserIds: string[] = [];
const createdAgencyIds: string[] = [];

interface Scene {
  readonly userId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly cookie: string;
}

const confirm = (scene: Scene, confirmed: boolean) =>
  owner.knex('auth.user').where({ id: scene.userId }).update({ emailVerified: confirmed });

/**
 * An account an invitation of `purpose` created, holding the session of its acceptance. The session is a real one (a login
 * of the account while it was still confirmed), and the account is then made unconfirmed, because the login of an
 * unconfirmed account is closed by design.
 */
const scene = async (purpose: Purpose): Promise<Scene> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'opens-nothing' });
  createdUserIds.push(user.id);
  const agencyId = randomUUID();
  const clientId = randomUUID();
  createdAgencyIds.push(agencyId);
  await owner.knex('agencies').insert({ id: agencyId, name: `Opens nothing ${agencyId}`, status: 'active', owner_user_id: user.id });
  await owner.knex('clients').insert({ id: clientId, agency_id: agencyId, name: `Opens nothing ${clientId}`, status: 'active' });
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: user.id, role_id: adminRoleId, status: 'active' });
  await owner.knex('client_memberships').insert({ client_id: clientId, user_id: user.id, status: 'active' });

  const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');

  const invitationId = randomUUID();
  await owner.knex('invitations').insert({
    id: invitationId,
    agency_id: agencyId,
    purpose,
    email: `opens-nothing-${invitationId}@example.test`,
    role_id: purpose === 'collaborator_invite' ? adminRoleId : null,
    client_id: purpose === 'client_invite' ? clientId : null,
    token_hash: createHash('sha256').update(invitationId).digest('hex'),
    expires_at: new Date(Date.now() + 86_400_000),
    used_at: new Date(),
    accepted_by_user_id: user.id
  });
  const made = { userId: user.id, agencyId, clientId, cookie };
  await confirm(made, false);
  return made;
};

const get = (cookie: string, url: string) => app.app.inject({ method: 'GET', url, headers: { cookie } });
const send = (cookie: string, method: 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.app.inject({ method, url, headers: { ...origin, cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });

const expectNotConfirmed = (response: { statusCode: number; json: () => unknown }): void => {
  expect(response.statusCode).toBe(403);
  expect(response.json()).toMatchObject({ error: { code: 'EMAIL_NOT_CONFIRMED' } });
};

beforeAll(async () => {
  owner = ownerClient();
  app = await buildTestApp({
    onRoute: (route) => { registeredRoutes.push({ method: route.method, url: route.url }); },
    registerExtraRoutes: (fastifyApp, guards) => {
      // The guards that come after the session, each tried alone: with the session guard letting the account through,
      // only the guard under test stands between it and the handler.
      fastifyApp.get('/__test/agencies/:agencyId', { preHandler: [guards.requireSessionUnconfirmedAllowed, guards.requireAgencyAccess] }, async () => ({ ok: true }));
      fastifyApp.get('/__test/clients/:clientId', { preHandler: [guards.requireSessionUnconfirmedAllowed, guards.requireClientAccess] }, async () => ({ ok: true }));
    }
  });
  const admin = await owner.knex('roles').where({ key: 'admin' }).whereNull('agency_id').first('id');
  if (admin === undefined) throw new Error('System role seeds are missing.');
  adminRoleId = admin.id;
});

afterAll(async () => {
  await owner.knex('user_context_preferences').whereIn('user_id', createdUserIds).delete();
  await owner.knex('invitations').whereIn('agency_id', createdAgencyIds).delete();
  await owner.knex('client_memberships').whereIn('user_id', createdUserIds).delete();
  await owner.knex('agency_memberships').whereIn('agency_id', createdAgencyIds).delete();
  await owner.knex('clients').whereIn('agency_id', createdAgencyIds).delete();
  await owner.knex('agencies').whereIn('id', createdAgencyIds).update({ owner_user_id: null });
  await owner.knex('agencies').whereIn('id', createdAgencyIds).delete();
  await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
  await app.close();
  await owner.close();
});

describe.each(PURPOSES)('the session of an unconfirmed account created by an invitation of %s', (purpose) => {
  it('says who it is and that the e-mail is not confirmed, and ends like any session', async () => {
    const mine = await scene(purpose);

    for (const url of ['/auth/session', '/auth/session/check']) {
      const session = await get(mine.cookie, url);
      expect(session.statusCode, url).toBe(200);
      expect(session.json(), url).toMatchObject({ emailVerified: false });
    }
    expect((await send(mine.cookie, 'POST', '/auth/logout')).statusCode).toBe(204);
    expect((await get(mine.cookie, '/auth/session')).statusCode).toBe(401);
  });

  it('signs out of every session, so a person who cannot confirm is never trapped in it', async () => {
    const mine = await scene(purpose);

    expect((await send(mine.cookie, 'POST', '/auth/logout-all')).statusCode).toBe(204);
    expect((await get(mine.cookie, '/auth/session')).statusCode).toBe(401);
  });

  it('lists no context and resolves to none, though the agency and the client are linked to it', async () => {
    const mine = await scene(purpose);

    const contexts = await get(mine.cookie, '/me/contexts');
    expect(contexts.statusCode).toBe(200);
    expect(contexts.json()).toEqual({ contexts: [], canCreateAgency: false });
    const resolved = await get(mine.cookie, '/me/contexts/resolve');
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toEqual({ decision: 'none' });
  });

  it('is refused with 403 EMAIL_NOT_CONFIRMED by the agency routes, the portal routes and every other route that needs a session', async () => {
    const mine = await scene(purpose);

    expectNotConfirmed(await get(mine.cookie, `/agencies/${mine.agencyId}/me`));
    expectNotConfirmed(await get(mine.cookie, `/clients/${mine.clientId}`));
    expectNotConfirmed(await get(mine.cookie, '/me/legal-acceptances'));
    expectNotConfirmed(await send(mine.cookie, 'PATCH', '/me/profile', { name: 'Outro nome' }));
    expectNotConfirmed(await send(mine.cookie, 'PUT', '/me/last-context', { type: 'agency', agencyId: mine.agencyId }));
    expectNotConfirmed(await send(mine.cookie, 'POST', '/agencies', { name: 'Minha agência' }));
    expect(await owner.knex('user_context_preferences').where({ user_id: mine.userId }).select('user_id')).toEqual([]);
  });

  it('is a 401 SESSION_EXPIRED, and the session is revoked, once it is past its 30 days, not a 403', async () => {
    const mine = await scene(purpose);
    await app.pool.query(`update auth.session set "createdAt" = now() - interval '31 days' where "userId" = $1`, [mine.userId]);
    // The credential was set "just now", and a session created before that is refused first (issue #719): age it too, so only the 30 days reject.
    await owner.knex.raw(`update auth.account set "passwordChangedAt" = now() - interval '60 days' where "userId" = ?`, [mine.userId]);

    const expired = await get(mine.cookie, `/agencies/${mine.agencyId}/me`);
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error: { code: 'SESSION_EXPIRED' } });
    expect((await app.pool.query('select id from auth.session where "userId" = $1', [mine.userId])).rows).toEqual([]);
  });

  it('is refused by the agency guard on its own, whatever the session guard in front of it did', async () => {
    const mine = await scene(purpose);

    expectNotConfirmed(await get(mine.cookie, `/__test/agencies/${mine.agencyId}`));
    await confirm(mine, true);
    expect((await get(mine.cookie, `/__test/agencies/${mine.agencyId}`)).statusCode).toBe(200);
  });

  it('is refused by the client guard on its own, whatever the session guard in front of it did', async () => {
    const mine = await scene(purpose);

    expectNotConfirmed(await get(mine.cookie, `/__test/clients/${mine.clientId}`));
    await confirm(mine, true);
    expect((await get(mine.cookie, `/__test/clients/${mine.clientId}`)).statusCode).toBe(200);
  });

  it('opens the agency, the portal and the contexts, with the same session, as soon as the e-mail is confirmed', async () => {
    const mine = await scene(purpose);
    expect((await get(mine.cookie, `/agencies/${mine.agencyId}/me`)).statusCode).toBe(403);

    await confirm(mine, true);

    expect((await get(mine.cookie, `/agencies/${mine.agencyId}/me`)).statusCode).toBe(200);
    expect((await get(mine.cookie, `/clients/${mine.clientId}`)).statusCode).toBe(200);
    const contexts = await get(mine.cookie, '/me/contexts');
    expect(contexts.json<{ contexts: { type: string }[] }>().contexts.map((context) => context.type).sort()).toEqual(['agency', 'client']);
    expect((await get(mine.cookie, '/auth/session')).json()).toMatchObject({ emailVerified: true });
  });
});

describe('an unconfirmed account that no invitation created', () => {
  it('has no session at all: it is revoked, as before this decision', async () => {
    const mine = await scene('collaborator_invite');
    await owner.knex('invitations').where({ accepted_by_user_id: mine.userId }).delete();

    expect((await get(mine.cookie, '/auth/session')).statusCode).toBe(401);
    expect((await get(mine.cookie, '/me/contexts')).statusCode).toBe(401);
  });
});

// The session routes that answer an account whose e-mail is not confirmed, fixed here on purpose: a route that needs a
// session and is not one of these refuses it, so one added later that escapes the guard turns the sweep below red.
const ANSWERS_UNCONFIRMED_ACCOUNT = new Set([
  'get /auth/session',
  'get /auth/session/check',
  'post /auth/logout',
  'post /auth/logout-all',
  'get /me/contexts',
  'get /me/contexts/resolve'
]);

const concretePath = (url: string): string => url
  .replace(/:agencyId|:clientId|:contentId|:folderId|:assetId|:scriptId|:roleId|:invitationId|:membershipId|:accessId|:threadId|:taskId|:userId|:id\b/g, () => randomUUID())
  .replace(/:[A-Za-z]+/g, 'some-value');

describe('every route that needs a session', () => {
  it('refuses the session of an unconfirmed invited account with 403 EMAIL_NOT_CONFIRMED, except the six that answer it', async () => {
    const mine = await scene('collaborator_invite');
    const routes = registeredRoutes.filter((route) => route.method !== 'head' && route.method !== 'options' && !route.url.includes('*') && !route.url.startsWith('/__test/'));
    const sessionRoutes: string[] = [];
    const wronglyOpen: string[] = [];

    for (const route of routes) {
      const key = `${route.method} ${route.url}`;
      const request = (cookie?: string) => app.app.inject({
        method: route.method.toUpperCase() as 'GET',
        url: concretePath(route.url),
        headers: { ...origin, ...(cookie === undefined ? {} : { cookie }) },
        ...(route.method === 'get' || route.method === 'delete' ? {} : { payload: {} })
      });
      const anonymous = await request();
      const needsSession = anonymous.statusCode === 401 && anonymous.json<{ error?: { code?: string } }>().error?.code === 'UNAUTHENTICATED';
      if (!needsSession) continue;
      sessionRoutes.push(key);
      if (ANSWERS_UNCONFIRMED_ACCOUNT.has(key)) continue;

      const answered = await request(mine.cookie);
      if (answered.statusCode !== 403 || answered.json<{ error?: { code?: string } }>().error?.code !== 'EMAIL_NOT_CONFIRMED') {
        wronglyOpen.push(`${key} -> ${answered.statusCode}`);
      }
    }

    expect(wronglyOpen).toEqual([]);
    // The sweep sees the real surface: the six are session routes, and so are the rest of the product's.
    for (const key of ANSWERS_UNCONFIRMED_ACCOUNT) expect(sessionRoutes, key).toContain(key);
    expect(sessionRoutes.length).toBeGreaterThan(60);
  });

  it.each([...ANSWERS_UNCONFIRMED_ACCOUNT])('%s does answer the unconfirmed account', async (key) => {
    const mine = await scene('collaborator_invite');
    const [method, url] = key.split(' ') as ['get' | 'post', string];

    const answered = await app.app.inject({ method: method.toUpperCase() as 'GET', url, headers: { ...origin, cookie: mine.cookie } });
    expect(answered.statusCode, key).toBeLessThan(300);
  });
});
