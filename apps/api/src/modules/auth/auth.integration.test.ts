import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  captureLogs,
  cleanupOwnedAgencyContext,
  cleanupTestUser,
  createFakeEmailSender,
  grantOwnedAgencyContext,
  insertTestUser,
  queryAsOwner,
  TEST_APP_PUBLIC_URL,
  buildTestApp,
  uniqueTestEmail,
  type TestApp,
  type TestUserFixture
} from './test-support/harness.js';
import { createInvitationToken } from '../invitations/tokens.js';

// Issue #31 acceptance tests 1-11, 8b, 13, and 14. Runs against the migrated local database
// (`pnpm db:migrate`) as the application role. Every fixture uses a randomly suffixed email and is
// removed in `afterEach`; `audit.events` rows are append-only for the application role and are left
// in place, but assertions against them are always filtered by this run's request id/actor.
const origin = { origin: TEST_APP_PUBLIC_URL };

const createdUsers: Array<{ app: TestApp; userId: string }> = [];
const createdAgencyIds: string[] = [];
const createdInvitationIds: string[] = [];
const openApps: TestApp[] = [];

const openApp: typeof buildTestApp = async (...args) => {
  const app = await buildTestApp(...args);
  openApps.push(app);
  return app;
};

/** Also grants an owned agency: every test below needs the login it exercises to actually
 * succeed, and issue #68 now rejects a correct credential that resolves to zero contexts. Tests
 * for that rejection itself use `insertTestUser` directly instead, deliberately with no context. */
const makeUser = async (app: TestApp, emailLabel: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel });
  createdUsers.push({ app, userId: user.id });
  createdAgencyIds.push(await grantOwnedAgencyContext(user.id));
  return user;
};

/**
 * The 2026-09-29 decision's one legitimate exception to zero contexts, exercised below: a
 * `collaborator_invite` addressed to `email`, in the given agency.
 */
const insertCollaboratorInvitation = async (input: {
  readonly agencyId: string;
  readonly email: string;
  readonly expiresAt?: Date;
  readonly revokedAt?: Date;
}): Promise<{ readonly invitationId: string; readonly token: string }> => {
  const roleRows = await queryAsOwner<{ id: string }>("select id from public.roles where key = 'production' and agency_id is null limit 1");
  const roleId = roleRows[0]?.id;
  if (roleId === undefined) throw new Error('Production role seed is missing.');
  const token = createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL });
  const rows = await queryAsOwner<{ id: string }>(`
    insert into public.invitations (agency_id, purpose, email, role_id, token_hash, expires_at, revoked_at)
    values ($1, 'collaborator_invite', $2, $3, $4, $5, $6)
    returning id
  `, [input.agencyId, input.email, roleId, token.tokenHash, input.expiresAt ?? token.expiresAt, input.revokedAt ?? null]);
  const invitationId = rows[0]?.id;
  if (invitationId === undefined) throw new Error('Failed to insert the test invitation.');
  createdInvitationIds.push(invitationId);
  return { invitationId, token: token.token };
};

afterEach(async () => {
  // Invitations first: `invitations.agency_id` has an FK to `public.agencies` with no `on delete`
  // action, so a still-referencing invitation would block the agency deletion right after it.
  const invitationIds = createdInvitationIds.splice(0);
  if (invitationIds.length > 0) {
    await queryAsOwner('delete from public.invitations where id = any($1::uuid[])', [invitationIds]);
  }
  // A test that runs `POST /invitations/:token/accept` (the inviteToken tests below) leaves a real
  // `agency_memberships` row behind; that FK has no `on delete` action either, and would otherwise
  // block deleting the agency or the user right after this.
  const agencyIds = [...createdAgencyIds];
  const userIds = createdUsers.map(({ userId }) => userId);
  if (agencyIds.length > 0 || userIds.length > 0) {
    await queryAsOwner(
      'delete from public.agency_memberships where agency_id = any($1::uuid[]) or user_id = any($2::uuid[])',
      [agencyIds, userIds]
    );
  }
  await Promise.all(createdAgencyIds.splice(0).map((agencyId) => cleanupOwnedAgencyContext(agencyId)));
  await Promise.all(createdUsers.splice(0).map(({ app, userId }) => cleanupTestUser(app.pool, userId)));
});

afterAll(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

const loginPayload = (user: Pick<TestUserFixture, 'email' | 'password'>) => ({ email: user.email, password: user.password });

const sessionCookieHeader = (setCookies: readonly { name: string; value: string }[]): string =>
  setCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

describe('POST /auth/login (#1, #2, #3)', () => {
  it('#1 logs in with correct credentials, returning 200 and an httpOnly, SameSite=Lax cookie; Secure is absent in test', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'login-ok');

    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: user.id, email: user.email } });
    expect(response.cookies.length).toBeGreaterThan(0);
    const sessionCookie = response.cookies[0];
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe('Lax');
    expect(sessionCookie?.secure).toBeFalsy();
    expect(sessionCookie?.path).toBe('/');
  });

  it('#1 sets Secure when environment=production', async () => {
    const app = await openApp({ config: { environment: 'production' } });
    const user = await makeUser(app, 'login-secure');

    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });

    expect(response.statusCode).toBe(200);
    const sessionCookie = response.cookies[0];
    expect(sessionCookie?.secure).toBe(true);
  });

  it('#2 responds identically for a wrong password and for a nonexistent email', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'login-wrong-password');
    // A shared client-supplied request id (echoed verbatim in `meta.requestId`) is the only way two
    // separate requests can produce a byte-for-byte identical body; each response otherwise carries
    // its own randomly generated id.
    const sharedRequestId = 'auth-test-2-shared-request-id';

    const wrongPassword = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: { email: user.email, password: 'definitely the wrong password' }
    });
    const unknownEmail = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: { email: uniqueTestEmail('does-not-exist'), password: 'definitely the wrong password' }
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.body).toBe(unknownEmail.body);
    expect(wrongPassword.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas.' } });
  });

  it('#3 finds the user when the login email has uppercase letters and surrounding spaces', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'login-normalize');
    const noisyEmail = `  ${user.email.toUpperCase()}  `;

    const response = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: origin,
      payload: { email: noisyEmail, password: user.password }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: user.id, email: user.email } });
  });
});

// Issue #68 acceptance tests. Deliberately uses `insertTestUser` directly, never `makeUser`
// above, so the user starts with exactly zero valid contexts.
describe('POST /auth/login rejects a correct credential with zero contexts (#68)', () => {
  it('responds with NO_CONTEXT_ACCESS and creates no row in auth."session"', async () => {
    const app = await openApp();
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'login-zero-context' });
    createdUsers.push({ app, userId: user.id });

    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: {
        code: 'NO_CONTEXT_ACCESS',
        message: 'Sua conta não tem acesso a nenhum espaço de trabalho. Fale com quem administra a agência para receber um convite.'
      }
    });
    expect(response.cookies.length).toBe(0);

    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
    expect(sessionRows.rowCount).toBe(0);
  });

  it('still responds with the generic INVALID_CREDENTIALS for a wrong password on a zero-context account', async () => {
    const app = await openApp();
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'login-zero-context-wrong-password' });
    createdUsers.push({ app, userId: user.id });

    const response = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: origin,
      payload: { email: user.email, password: 'definitely the wrong password' }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas.' } });
    expect(response.cookies.length).toBe(0);

    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
    expect(sessionRows.rowCount).toBe(0);
  });

  it('succeeds once the account is granted a context', async () => {
    const app = await openApp();
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'login-gains-context' });
    createdUsers.push({ app, userId: user.id });

    const denied = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    expect(denied.statusCode).toBe(403);

    const agencyId = await grantOwnedAgencyContext(user.id);
    createdAgencyIds.push(agencyId);

    const granted = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    expect(granted.statusCode).toBe(200);
    expect(granted.cookies.length).toBeGreaterThan(0);
  });
});

// 2026-09-29 decision, complementing #68: a zero-context login still gets a session when it
// continues straight into accepting an existing-account invitation addressed to it.
describe('POST /auth/login accepts inviteToken for a zero-context account continuing into accept', () => {
  it('creates a session, lets accept run, and an ordinary login succeeds afterwards', async () => {
    const app = await openApp();
    const agencyOwner = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-owner' });
    createdUsers.push({ app, userId: agencyOwner.id });
    const agencyId = await grantOwnedAgencyContext(agencyOwner.id);
    createdAgencyIds.push(agencyId);

    const invitee = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-invitee' });
    createdUsers.push({ app, userId: invitee.id });
    const { token } = await insertCollaboratorInvitation({ agencyId, email: invitee.email });

    const loginWithToken = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: origin,
      payload: { ...loginPayload(invitee), inviteToken: token }
    });
    expect(loginWithToken.statusCode).toBe(200);
    expect(loginWithToken.cookies.length).toBeGreaterThan(0);
    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [invitee.id]);
    expect(sessionRows.rowCount).toBe(1);

    // The session is contextless until accept runs — exactly the order issue #76's invite screen
    // must follow (never call `resolve` first: it would end this same session on sight).
    const cookie = sessionCookieHeader(loginWithToken.cookies);
    const accept = await app.app.inject({ method: 'POST', url: `/invitations/${token}/accept`, headers: { ...origin, cookie } });
    expect(accept.statusCode).toBe(200);
    expect(accept.json()).toMatchObject({ status: 'accepted', context: { agencyId, clientId: null } });

    const secondLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(invitee) });
    expect(secondLogin.statusCode).toBe(200);
    expect(secondLogin.cookies.length).toBeGreaterThan(0);
  });

  it('denies exactly like no token at all when inviteToken is addressed to a different e-mail', async () => {
    const app = await openApp();
    const agencyOwner = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-mismatch-owner' });
    createdUsers.push({ app, userId: agencyOwner.id });
    const agencyId = await grantOwnedAgencyContext(agencyOwner.id);
    createdAgencyIds.push(agencyId);

    const invitee = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-mismatch-invitee' });
    createdUsers.push({ app, userId: invitee.id });
    const { token } = await insertCollaboratorInvitation({ agencyId, email: uniqueTestEmail('invite-login-mismatch-someone-else') });

    const sharedRequestId = 'invite-login-mismatch-shared-request-id';
    const withToken = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: { ...loginPayload(invitee), inviteToken: token }
    });
    const withoutToken = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: loginPayload(invitee)
    });

    expect(withToken.statusCode).toBe(403);
    expect(withToken.cookies.length).toBe(0);
    expect(withToken.body).toBe(withoutToken.body);
  });

  it('denies exactly like no token at all when inviteToken is expired', async () => {
    const app = await openApp();
    const agencyOwner = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-expired-owner' });
    createdUsers.push({ app, userId: agencyOwner.id });
    const agencyId = await grantOwnedAgencyContext(agencyOwner.id);
    createdAgencyIds.push(agencyId);

    const invitee = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-expired-invitee' });
    createdUsers.push({ app, userId: invitee.id });
    const { token } = await insertCollaboratorInvitation({ agencyId, email: invitee.email, expiresAt: new Date(Date.now() - 60_000) });

    const sharedRequestId = 'invite-login-expired-shared-request-id';
    const withToken = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: { ...loginPayload(invitee), inviteToken: token }
    });
    const withoutToken = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: loginPayload(invitee)
    });

    expect(withToken.statusCode).toBe(403);
    expect(withToken.cookies.length).toBe(0);
    expect(withToken.body).toBe(withoutToken.body);
  });

  it('denies exactly like no token at all when inviteToken was revoked', async () => {
    const app = await openApp();
    const agencyOwner = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-revoked-owner' });
    createdUsers.push({ app, userId: agencyOwner.id });
    const agencyId = await grantOwnedAgencyContext(agencyOwner.id);
    createdAgencyIds.push(agencyId);

    const invitee = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-revoked-invitee' });
    createdUsers.push({ app, userId: invitee.id });
    const { token } = await insertCollaboratorInvitation({ agencyId, email: invitee.email, revokedAt: new Date() });

    const sharedRequestId = 'invite-login-revoked-shared-request-id';
    const withToken = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: { ...loginPayload(invitee), inviteToken: token }
    });
    const withoutToken = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: loginPayload(invitee)
    });

    expect(withToken.statusCode).toBe(403);
    expect(withToken.cookies.length).toBe(0);
    expect(withToken.body).toBe(withoutToken.body);
  });

  it('denies exactly like no token at all when the invite\'s agency is suspended', async () => {
    const app = await openApp();
    const agencyOwner = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-suspended-owner' });
    createdUsers.push({ app, userId: agencyOwner.id });
    const agencyId = await grantOwnedAgencyContext(agencyOwner.id);
    createdAgencyIds.push(agencyId);

    const invitee = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-suspended-invitee' });
    createdUsers.push({ app, userId: invitee.id });
    const { token } = await insertCollaboratorInvitation({ agencyId, email: invitee.email });
    await queryAsOwner('update public.agencies set status = $1 where id = $2', ['suspended', agencyId]);

    const sharedRequestId = 'invite-login-suspended-shared-request-id';
    const withToken = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: { ...loginPayload(invitee), inviteToken: token }
    });
    const withoutToken = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: loginPayload(invitee)
    });

    expect(withToken.statusCode).toBe(403);
    expect(withToken.cookies.length).toBe(0);
    expect(withToken.body).toBe(withoutToken.body);
  });

  it('still responds with the generic INVALID_CREDENTIALS when inviteToken is valid but the password is wrong', async () => {
    const app = await openApp();
    const agencyOwner = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-wrong-password-owner' });
    createdUsers.push({ app, userId: agencyOwner.id });
    const agencyId = await grantOwnedAgencyContext(agencyOwner.id);
    createdAgencyIds.push(agencyId);

    const invitee = await insertTestUser(app.pool, app.auth, { emailLabel: 'invite-login-wrong-password-invitee' });
    createdUsers.push({ app, userId: invitee.id });
    const { token } = await insertCollaboratorInvitation({ agencyId, email: invitee.email });

    const response = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: origin,
      payload: { email: invitee.email, password: 'definitely the wrong password', inviteToken: token }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas.' } });
    expect(response.cookies.length).toBe(0);
    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [invitee.id]);
    expect(sessionRows.rowCount).toBe(0);
  });
});

describe('auth.user email normalization (#4)', () => {
  it('#4 rejects a non-normalized email at the database constraint', async () => {
    const app = await openApp();
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID();

    await expect(
      app.pool.query('insert into auth."user" (id, name, email, "emailVerified") values ($1, $2, $3, false)', [
        id, 'Bad Email User', ` Upper.Case@Example.Test `
      ])
    ).rejects.toThrow(/user_email_normalized/);
  });
});

describe('GET /auth/session (#5, #6)', () => {
  it('#5 returns 401 UNAUTHENTICATED without a cookie and 200 with a valid one', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'session-ok');

    const noCookie = await app.app.inject({ method: 'GET', url: '/auth/session' });
    expect(noCookie.statusCode).toBe(401);
    expect(noCookie.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });

    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const withCookie = await app.app.inject({
      method: 'GET', url: '/auth/session',
      headers: { cookie: sessionCookieHeader(login.cookies) }
    });

    expect(withCookie.statusCode).toBe(200);
    expect(withCookie.json()).toMatchObject({ user: { id: user.id, email: user.email } });
  });

  it('#6 rejects a session created 31 days ago as SESSION_EXPIRED and deletes it', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'session-absolute-limit');

    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const cookie = sessionCookieHeader(login.cookies);

    const sessionRow = await app.pool.query<{ id: string }>(
      'select id from auth.session where "userId" = $1 order by "createdAt" desc limit 1',
      [user.id]
    );
    const sessionId = sessionRow.rows[0]?.id;
    expect(sessionId).toBeDefined();
    await app.pool.query('update auth.session set "createdAt" = now() - interval \'31 days\' where id = $1', [sessionId]);

    const response = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_EXPIRED' } });

    const remaining = await app.pool.query('select 1 from auth.session where id = $1', [sessionId]);
    expect(remaining.rowCount).toBe(0);
  });

  it('M1 renews the session cookie and extends the DB expiry once updateAge has elapsed', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'session-renewal');

    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const cookie = sessionCookieHeader(login.cookies);

    const sessionRow = await app.pool.query<{ id: string }>(
      'select id from auth.session where "userId" = $1 order by "createdAt" desc limit 1',
      [user.id]
    );
    const sessionId = sessionRow.rows[0]?.id;
    expect(sessionId).toBeDefined();
    // updateAge is 1 day (better-auth.ts); moving updatedAt 2 days back guarantees Better Auth's
    // own `shouldBeUpdated` check (based on `expiresAt - expiresIn + updateAge`) decides this
    // session needs a refresh. expiresAt is set 5 days out so the session is still valid.
    await app.pool.query(
      'update auth.session set "updatedAt" = now() - interval \'2 days\', "expiresAt" = now() + interval \'5 days\' where id = $1',
      [sessionId]
    );

    const response = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(response.statusCode).toBe(200);

    const setCookieHeader = response.headers['set-cookie'];
    expect(setCookieHeader).toBeDefined();
    const renewedCookie = response.cookies.find((candidate) => candidate.name.includes('session'));
    expect(renewedCookie).toBeDefined();
    expect(renewedCookie?.maxAge).toBeGreaterThan(604_800 - 60);
    expect(renewedCookie?.maxAge).toBeLessThan(604_800 + 60);

    const updatedRow = await app.pool.query<{ expiresAt: Date }>(
      'select "expiresAt" from auth.session where id = $1',
      [sessionId]
    );
    const newExpiresAtMs = new Date(updatedRow.rows[0]!.expiresAt).getTime();
    const expectedMs = Date.now() + 7 * 24 * 60 * 60 * 1_000;
    expect(Math.abs(newExpiresAtMs - expectedMs)).toBeLessThan(60_000);
  });

  it('B8 never lets a refresh push expiresAt past createdAt + 30 days, even at the database-hook level', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'session-absolute-clamp');

    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const cookie = sessionCookieHeader(login.cookies);

    const sessionRow = await app.pool.query<{ id: string; createdAt: Date }>(
      'select id, "createdAt" from auth.session where "userId" = $1 order by "createdAt" desc limit 1',
      [user.id]
    );
    const sessionId = sessionRow.rows[0]?.id;
    expect(sessionId).toBeDefined();
    // 29 days old: still under the 30-day absolute limit (so `session-guard.ts` will not reject
    // it outright), but a due `updateAge` refresh would normally push `expiresAt` to
    // now + 7 days, i.e. well past `createdAt + 30 days`. The `databaseHooks.session.update.before`
    // clamp (B8) must cap it regardless.
    await app.pool.query(
      'update auth.session set "createdAt" = now() - interval \'29 days\', "updatedAt" = now() - interval \'2 days\', "expiresAt" = now() + interval \'5 days\' where id = $1',
      [sessionId]
    );

    const response = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(response.statusCode).toBe(200);

    const updatedRow = await app.pool.query<{ expiresAt: Date; createdAt: Date }>(
      'select "expiresAt", "createdAt" from auth.session where id = $1',
      [sessionId]
    );
    const row = updatedRow.rows[0]!;
    const maxAllowedMs = new Date(row.createdAt).getTime() + 30 * 24 * 60 * 60 * 1_000;
    expect(new Date(row.expiresAt).getTime()).toBeLessThanOrEqual(maxAllowedMs + 1_000);
  });
});

describe('POST /auth/logout and /auth/logout-all (#7)', () => {
  it('#7 logout revokes only the current session; logout-all revokes every session and is audited', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'logout');

    const firstLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const secondLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const firstCookie = sessionCookieHeader(firstLogin.cookies);
    const secondCookie = sessionCookieHeader(secondLogin.cookies);

    const logout = await app.app.inject({ method: 'POST', url: '/auth/logout', headers: { ...origin, cookie: firstCookie } });
    expect(logout.statusCode).toBe(204);

    const afterLogoutFirst = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: firstCookie } });
    expect(afterLogoutFirst.statusCode).toBe(401);
    const afterLogoutSecond = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: secondCookie } });
    expect(afterLogoutSecond.statusCode).toBe(200);

    const logoutAll = await app.app.inject({ method: 'POST', url: '/auth/logout-all', headers: { ...origin, cookie: secondCookie } });
    expect(logoutAll.statusCode).toBe(204);

    const afterLogoutAll = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: secondCookie } });
    expect(afterLogoutAll.statusCode).toBe(401);

    const auditRows = await queryAsOwner<{ action: string; actor_user_id: string; request_id: string }>(
      "select action, actor_user_id, request_id from audit.events where action = 'auth.logout_all' and actor_user_id = $1",
      [user.id]
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
    expect(auditRows[0]?.request_id).toEqual(expect.any(String));
    expect(auditRows[0]?.request_id.length).toBeGreaterThan(0);
  });

  it('#7 logout and logout-all without a session return 401 UNAUTHENTICATED', async () => {
    const app = await openApp();
    const logout = await app.app.inject({ method: 'POST', url: '/auth/logout', headers: origin });
    const logoutAll = await app.app.inject({ method: 'POST', url: '/auth/logout-all', headers: origin });
    expect(logout.statusCode).toBe(401);
    expect(logoutAll.statusCode).toBe(401);
  });
});

describe('POST /auth/password/forgot (#8, #8b)', () => {
  it('#8 responds 202 for both an existing and a nonexistent email, and only the existing one is sent', async () => {
    const sender = createFakeEmailSender();
    const app = await openApp({ sender });
    const user = await makeUser(app, 'forgot-existing');

    const existing = await app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: user.email } });
    const nonExistent = await app.app.inject({
      method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: uniqueTestEmail('forgot-missing') }
    });

    expect(existing.statusCode).toBe(202);
    expect(existing.json()).toEqual({});
    expect(nonExistent.statusCode).toBe(202);
    expect(nonExistent.json()).toEqual({});

    await app.emailService.drain();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.to).toBe(user.email);
    expect(sender.sent[0]?.text).toMatch(
      new RegExp(`^.*${TEST_APP_PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/senha\\/redefinir\\?token=`, 's')
    );
  });

  it('#8b responds 202 before a slow transport settles, and a failing transport still responds 202', async () => {
    let releaseSlowSend: (() => void) | undefined;
    const slowSender = createFakeEmailSender(() => new Promise((resolve) => {
      releaseSlowSend = () => resolve();
    }));
    const slowApp = await openApp({ sender: slowSender });
    const slowUser = await makeUser(slowApp, 'forgot-slow');

    const slowResponsePromise = slowApp.app.inject({
      method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: slowUser.email }
    });
    const slowResponse = await slowResponsePromise;
    expect(slowResponse.statusCode).toBe(202);
    expect(releaseSlowSend).toBeDefined();
    releaseSlowSend?.();
    await slowApp.emailService.drain();

    const failingSender = createFakeEmailSender(async () => {
      throw new Error('simulated SMTP failure');
    });
    const capturedLogs = captureLogs();
    const failingApp = await openApp({ sender: failingSender, logger: capturedLogs.logger });
    const failingUser = await makeUser(failingApp, 'forgot-failing');

    const failingResponse = await failingApp.app.inject({
      method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: failingUser.email }
    });
    expect(failingResponse.statusCode).toBe(202);
    await failingApp.emailService.drain();

    const logText = capturedLogs.text();
    expect(logText).toMatch(/EMAIL_DELIVERY_FAILED|Password reset email delivery failed/);
    expect(logText).not.toContain(failingUser.email);
  });
});

describe('POST /auth/password/reset (#9, #10, #11)', () => {
  const requestResetToken = async (app: TestApp, sender: ReturnType<typeof createFakeEmailSender>, email: string): Promise<string> => {
    await app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email } });
    await app.emailService.drain();
    const link = sender.sent.at(-1)?.text ?? '';
    const match = /senha\/redefinir\?token=([^\s"'&]+)/.exec(link);
    if (!match?.[1]) throw new Error('Reset token was not found in the captured email.');
    return decodeURIComponent(match[1]);
  };

  it('#9 resets the password with a valid token, revokes all sessions, signs the account back in, and audits auth.password_reset', async () => {
    const sender = createFakeEmailSender();
    const app = await openApp({ sender });
    const user = await makeUser(app, 'reset-ok');

    const firstLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const firstCookie = sessionCookieHeader(firstLogin.cookies);

    const token = await requestResetToken(app, sender, user.email);
    const newPassword = 'a brand new correct horse battery staple';
    const reset = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token, newPassword }
    });
    // Issue #175: a reset with at least one context always authenticates, not just the
    // invite-continuation branch — a new, valid, cookied session, same mechanism as login.
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ signedIn: true });
    expect(reset.cookies.length).toBeGreaterThan(0);

    const oldSessionCheck = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: firstCookie } });
    expect(oldSessionCheck.statusCode).toBe(401);

    const newSessionCheck = await app.app.inject({
      method: 'GET', url: '/auth/session', headers: { cookie: sessionCookieHeader(reset.cookies) }
    });
    expect(newSessionCheck.statusCode).toBe(200);

    const loginWithNewPassword = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: newPassword }
    });
    expect(loginWithNewPassword.statusCode).toBe(200);

    const auditRows = await queryAsOwner<{ action: string }>(
      "select action from audit.events where action = 'auth.password_reset' and actor_user_id = $1",
      [user.id]
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);
  });

  it('resets the password with zero contexts, creates no session, and a following login gets NO_CONTEXT_ACCESS', async () => {
    const sender = createFakeEmailSender();
    const app = await openApp({ sender });
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'reset-zero-context' });
    createdUsers.push({ app, userId: user.id });

    const token = await requestResetToken(app, sender, user.email);
    const newPassword = 'a brand new zero context password';
    const reset = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token, newPassword }
    });

    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ signedIn: false, reason: 'NO_CONTEXT_ACCESS' });
    expect(reset.cookies.length).toBe(0);

    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
    expect(sessionRows.rowCount).toBe(0);

    const loginWithNewPassword = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: newPassword }
    });
    expect(loginWithNewPassword.statusCode).toBe(403);
    expect(loginWithNewPassword.json()).toMatchObject({ error: { code: 'NO_CONTEXT_ACCESS' } });
  });

  it('#10 a reused token and an expired token both return 400 INVALID_LINK', async () => {
    const sender = createFakeEmailSender();
    const app = await openApp({ sender });

    const reusedUser = await makeUser(app, 'reset-reused');
    const reusedToken = await requestResetToken(app, sender, reusedUser.email);

    // M4: the reset token's TTL must actually be the ~30 minutes issue #31 prescribes
    // (`resetPasswordTokenExpiresIn: 60 * 30` in better-auth.ts), not merely "some expiry".
    const verificationTtlRow = await app.pool.query<{ createdAt: Date; expiresAt: Date }>(
      'select "createdAt", "expiresAt" from auth.verification where value = $1 order by "createdAt" desc limit 1',
      [reusedUser.id]
    );
    const ttlRow = verificationTtlRow.rows[0];
    expect(ttlRow).toBeDefined();
    const ttlMinutes = (new Date(ttlRow!.expiresAt).getTime() - new Date(ttlRow!.createdAt).getTime()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(29);
    expect(ttlMinutes).toBeLessThan(31);

    const firstUse = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token: reusedToken, newPassword: 'first use new password value' }
    });
    expect(firstUse.statusCode).toBe(200);
    expect(firstUse.json()).toEqual({ signedIn: true });
    const secondUse = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token: reusedToken, newPassword: 'second use new password value' }
    });
    expect(secondUse.statusCode).toBe(400);
    expect(secondUse.json()).toMatchObject({ error: { code: 'INVALID_LINK', message: 'Este link não é mais válido.' } });

    const expiredUser = await makeUser(app, 'reset-expired');
    const expiredToken = await requestResetToken(app, sender, expiredUser.email);
    await app.pool.query(
      'update auth.verification set "expiresAt" = now() - interval \'1 minute\' where value = $1',
      [expiredUser.id]
    );
    const expiredUse = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token: expiredToken, newPassword: 'expired token new password value' }
    });
    expect(expiredUse.statusCode).toBe(400);
    expect(expiredUse.json()).toMatchObject({ error: { code: 'INVALID_LINK' } });
  });

  it('#11 the raw token is never stored in plaintext anywhere in the database', async () => {
    const sender = createFakeEmailSender();
    const app = await openApp({ sender });
    const user = await makeUser(app, 'reset-hashed');

    const token = await requestResetToken(app, sender, user.email);
    expect(token.length).toBeGreaterThan(10);

    const verificationRows = await app.pool.query<{ identifier: string; value: string }>(
      'select identifier, value from auth.verification where value = $1',
      [user.id]
    );
    expect(verificationRows.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of verificationRows.rows) {
      expect(row.identifier).not.toContain(token);
      expect(row.identifier).not.toBe(`reset-password:${token}`);
      expect(row.value).not.toContain(token);
    }

    const sessionRows = await app.pool.query<{ token: string }>('select token from auth.session where "userId" = $1', [user.id]);
    for (const row of sessionRows.rows) expect(row.token).not.toContain(token);
  });
});

describe('global origin/CSRF check (#13)', () => {
  it('#13 rejects a POST without or with the wrong Origin on any route, including one outside the auth module', async () => {
    const app = await openApp();

    const noOriginAuth = await app.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'a@example.test', password: 'irrelevant password' } });
    expect(noOriginAuth.statusCode).toBe(403);
    expect(noOriginAuth.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });

    const wrongOriginAuth = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { origin: 'https://not-allowed.example' },
      payload: { email: 'a@example.test', password: 'irrelevant password' }
    });
    expect(wrongOriginAuth.statusCode).toBe(403);

    const noOriginOutside = await app.app.inject({ method: 'POST', url: '/does-not-exist-either-way' });
    expect(noOriginOutside.statusCode).toBe(403);
    expect(noOriginOutside.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });

    const health = await app.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
  });

  it('#13 (B12) rejects a POST without Origin and accepts one with the correct Origin on a real, non-auth route', async () => {
    const app = await openApp({
      registerExtraRoutes: (fastifyApp) => {
        fastifyApp.post('/__test/echo', async () => ({ ok: true }));
      }
    });

    const withoutOrigin = await app.app.inject({ method: 'POST', url: '/__test/echo', payload: {} });
    expect(withoutOrigin.statusCode).toBe(403);
    expect(withoutOrigin.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });

    const withOrigin = await app.app.inject({ method: 'POST', url: '/__test/echo', headers: origin, payload: {} });
    expect(withOrigin.statusCode).toBe(200);
    expect(withOrigin.json()).toEqual({ ok: true });
  });
});

describe('no public sign-up route (#14)', () => {
  it('#14 every plausible sign-up route responds 404', async () => {
    const app = await openApp();
    for (const url of ['/auth/sign-up', '/auth/signup', '/auth/register', '/auth/sign-up/email']) {
      const response = await app.app.inject({ method: 'POST', url, headers: origin, payload: {} });
      expect(response.statusCode).toBe(404);
    }
  });
});
