import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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

// Issue #31 acceptance tests 1-11, 8b, 13, and 14. Runs against the migrated local database
// (`pnpm db:migrate`) as the application role. Every fixture uses a randomly suffixed email and is
// removed in `afterEach`; `audit.events` rows are append-only for the application role and are left
// in place, but assertions against them are always filtered by this run's request id/actor.
const origin = { origin: TEST_APP_PUBLIC_URL };

const createdUsers: Array<{ app: TestApp; userId: string }> = [];
const createdAgencyIds: string[] = [];
const openApps: TestApp[] = [];

const openApp: typeof buildTestApp = async (...args) => {
  const app = await buildTestApp(...args);
  openApps.push(app);
  return app;
};

/** Also grants an owned agency, so the login lands on a context. The tests of zero contexts and of
 * unconfirmed accounts use `insertTestUser` directly. */
const makeUser = async (app: TestApp, emailLabel: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel });
  createdUsers.push({ app, userId: user.id });
  createdAgencyIds.push(await grantOwnedAgencyContext(user.id));
  return user;
};

afterEach(async () => {
  // `agency_memberships` has no `on delete` action and would block deleting the agency or the user.
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

/**
 * A password row carries the date it was set (issue #719), and a session created at or before that date is refused.
 * These tests age a session by rewriting its `createdAt`; the credential was set "just now", so its date ages with it.
 */
const ageCredentialOfSession = (_app: TestApp, sessionId: string | undefined) =>
  queryAsOwner(`update auth.account set "passwordChangedAt" = now() - interval '60 days' where "userId" = (select "userId" from auth.session where id = $1)`, [sessionId]);

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

  it('#700 answers a wrong password shorter than 10 characters with the same 401 INVALID_CREDENTIALS, not a 400 (the 10-character rule is for creating a password)', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'login-short-wrong-password');
    const sharedRequestId = 'auth-test-700-shared-request-id';

    const shortWrong = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: { email: user.email, password: 'curta' }
    });
    const longWrong = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': sharedRequestId },
      payload: { email: user.email, password: 'definitely the wrong password' }
    });
    const empty = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: origin,
      payload: { email: user.email, password: '' }
    });

    expect(shortWrong.statusCode).toBe(401);
    expect(shortWrong.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas.' } });
    expect(shortWrong.body).toBe(longWrong.body);
    expect(shortWrong.cookies).toHaveLength(0);
    // An empty password is still not a credential: the contract refuses it before the server checks anything.
    expect(empty.statusCode).toBe(400);
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
// Rule 3 as the 2026-10-26 decision on the public sign-up left it: a confirmed account gets its
// session even with zero contexts (it lands on `/comecar`), and an unconfirmed one never gets one.
describe('POST /auth/login and the confirmation of the e-mail (#706)', () => {
  it('creates a session for a confirmed account with zero contexts', async () => {
    const app = await openApp();
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'login-zero-context' });
    createdUsers.push({ app, userId: user.id });

    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });

    expect(response.statusCode).toBe(200);
    expect(response.cookies.length).toBeGreaterThan(0);
    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
    expect(sessionRows.rowCount).toBe(1);
  });

  it('answers an unconfirmed account with the right password exactly like a wrong one, with no cookie and no session row (security review of PR #722)', async () => {
    const app = await openApp();
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'login-unverified', emailVerified: false });
    createdUsers.push({ app, userId: user.id });
    createdAgencyIds.push(await grantOwnedAgencyContext(user.id));

    const headers = { ...origin, 'x-request-id': 'login-unverified-right-shared-request-id' };
    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers, payload: loginPayload(user) });
    const wrong = await app.app.inject({ method: 'POST', url: '/auth/login', headers, payload: { email: user.email, password: 'definitely the wrong password' } });

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe(wrong.body);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
    expect(response.cookies.length).toBe(0);
    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
    expect(sessionRows.rowCount).toBe(0);
  });

  it('never lets an unconfirmed account reach the sign-in, whatever the password, so the time tells nothing (review of PR #722, B2)', async () => {
    const app = await openApp();
    const unconfirmed = await insertTestUser(app.pool, app.auth, { emailLabel: 'login-never-signs-in', emailVerified: false });
    const confirmed = await insertTestUser(app.pool, app.auth, { emailLabel: 'login-signs-in' });
    createdUsers.push({ app, userId: unconfirmed.id }, { app, userId: confirmed.id });
    const signIn = vi.spyOn(app.auth.api, 'signInEmail');
    const login = (email: string, password: string) =>
      app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email, password } });

    try {
      expect((await login(unconfirmed.email, unconfirmed.password)).statusCode).toBe(401);
      expect((await login(unconfirmed.email, 'definitely the wrong password')).statusCode).toBe(401);
      expect((await login(uniqueTestEmail('login-never-signs-in-unknown'), 'definitely the wrong password')).statusCode).toBe(401);
      expect(signIn).not.toHaveBeenCalled();

      expect((await login(confirmed.email, confirmed.password)).statusCode).toBe(200);
      expect(signIn).toHaveBeenCalledTimes(1);
    } finally {
      signIn.mockRestore();
    }
  });

  it('answers an unconfirmed account with a wrong password byte for byte like an unknown e-mail', async () => {
    const app = await openApp();
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'login-unverified-wrong', emailVerified: false });
    createdUsers.push({ app, userId: user.id });

    const requestId = 'login-unverified-wrong-shared-request-id';
    const wrong = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': requestId },
      payload: { email: user.email, password: 'definitely the wrong password' }
    });
    const unknown = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'x-request-id': requestId },
      payload: { email: uniqueTestEmail('login-unverified-unknown'), password: 'definitely the wrong password' }
    });

    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.cookies.length).toBe(0);
  });

  it('refuses a session an unconfirmed account somehow holds, and revokes it', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'session-unverified');
    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    expect(login.statusCode).toBe(200);
    await app.pool.query('update auth."user" set "emailVerified" = false where id = $1', [user.id]);

    const session = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: sessionCookieHeader(login.cookies) } });

    expect(session.statusCode).toBe(401);
    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
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
    await ageCredentialOfSession(app, sessionId);

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

  it('#411 GET /auth/session/check answers like /auth/session but never renews: expiresAt, updatedAt and the cookie stay, and a revoked session is a 401', async () => {
    const app = await openApp();
    const user = await makeUser(app, 'session-check');
    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const cookie = sessionCookieHeader(login.cookies);
    const sessionId = (await app.pool.query<{ id: string }>('select id from auth.session where "userId" = $1 order by "createdAt" desc limit 1', [user.id])).rows[0]!.id;
    // Due for renewal (updateAge is 1 day), and still valid.
    await app.pool.query("update auth.session set \"updatedAt\" = now() - interval '2 days', \"expiresAt\" = now() + interval '5 days' where id = $1", [sessionId]);
    const readRow = async () => (await app.pool.query<{ expiresAt: Date; updatedAt: Date }>('select "expiresAt", "updatedAt" from auth.session where id = $1', [sessionId])).rows[0]!;
    const before = await readRow();

    const check = await app.app.inject({ method: 'GET', url: '/auth/session/check', headers: { cookie } });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toEqual({
      user: { id: user.id, name: user.name, email: user.email },
      session: { expiresAt: new Date(before.expiresAt).toISOString() }
    });
    expect(check.headers['set-cookie']).toBeUndefined();
    const after = await readRow();
    expect(new Date(after.expiresAt).getTime()).toBe(new Date(before.expiresAt).getTime());
    expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());

    // The same session, asked through the route that counts as use, is renewed: the check is what differs.
    const used = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(used.statusCode).toBe(200);
    expect(new Date((await readRow()).expiresAt).getTime()).toBeGreaterThan(new Date(before.expiresAt).getTime() + 24 * 60 * 60 * 1_000);

    expect((await app.app.inject({ method: 'GET', url: '/auth/session/check' })).statusCode).toBe(401);
    await app.pool.query('delete from auth.session where id = $1', [sessionId]);
    const revoked = await app.app.inject({ method: 'GET', url: '/auth/session/check', headers: { cookie } });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
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
    await ageCredentialOfSession(app, sessionId);

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

// One app per block, closed with the block. Every `openApp()` keeps its pools until the end of the file, and
// this file already holds dozens: twelve more apps exhausted the connection slots of the CI database (53300).
describe('GET /auth/session/check applies every rule of the session guard without renewing (#423)', () => {
  let app: TestApp;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });

  const loginSession = async (app: TestApp, user: TestUserFixture) => {
    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const sessionId = (await app.pool.query<{ id: string }>(
      'select id from auth.session where "userId" = $1 order by "createdAt" desc limit 1',
      [user.id]
    )).rows[0]!.id;
    return { cookies: login.cookies, cookie: sessionCookieHeader(login.cookies), sessionId };
  };
  const check = (app: TestApp, cookie?: string) => app.app.inject({
    method: 'GET',
    url: '/auth/session/check',
    ...(cookie === undefined ? {} : { headers: { cookie } })
  });
  const sessionExists = async (app: TestApp, sessionId: string): Promise<boolean> =>
    (await app.pool.query('select 1 from auth.session where id = $1', [sessionId])).rowCount === 1;

  it('answers 401 UNAUTHENTICATED, with no cookie issued, when there is no session cookie', async () => {

    const response = await check(app);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('answers 401 UNAUTHENTICATED once the session was revoked, by logout or by the row being gone', async () => {
    const user = await makeUser(app, 'check-revoked');
    const loggedOut = await loginSession(app, user);
    const deleted = await loginSession(app, user);
    expect((await check(app, loggedOut.cookie)).statusCode).toBe(200);
    expect((await check(app, deleted.cookie)).statusCode).toBe(200);

    expect((await app.app.inject({ method: 'POST', url: '/auth/logout', headers: { ...origin, cookie: loggedOut.cookie } })).statusCode).toBe(204);
    await app.pool.query('delete from auth.session where id = $1', [deleted.sessionId]);

    for (const { cookie } of [loggedOut, deleted]) {
      const response = await check(app, cookie);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('answers 401 UNAUTHENTICATED, with no cookie issued, once the 7 days without use ran out', async () => {
    const user = await makeUser(app, 'check-expired');
    const { cookie, sessionId } = await loginSession(app, user);
    await app.pool.query('update auth.session set "expiresAt" = now() - interval \'1 second\' where id = $1', [sessionId]);

    const response = await check(app, cookie);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('answers 401 SESSION_EXPIRED and deletes the row for a session older than 30 days, although expiresAt is still ahead', async () => {
    const user = await makeUser(app, 'check-absolute-cap');
    const { cookie, sessionId } = await loginSession(app, user);
    // Recently used and far from its 7 days: only the 30 days since creation can reject it.
    await app.pool.query('update auth.session set "createdAt" = now() - interval \'31 days\', "updatedAt" = now(), "expiresAt" = now() + interval \'6 days\' where id = $1', [sessionId]);
    await ageCredentialOfSession(app, sessionId);

    const response = await check(app, cookie);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'SESSION_EXPIRED' } });
    expect(await sessionExists(app, sessionId)).toBe(false);
    // The deleted row is the whole rejection: the same cookie is now just a missing session.
    const again = await check(app, cookie);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('still accepts a session just under the 30 days: the cap is not applied early', async () => {
    const user = await makeUser(app, 'check-under-cap');
    const { cookie, sessionId } = await loginSession(app, user);
    await app.pool.query('update auth.session set "createdAt" = now() - interval \'29 days\', "updatedAt" = now(), "expiresAt" = now() + interval \'6 days\' where id = $1', [sessionId]);
    await ageCredentialOfSession(app, sessionId);

    const response = await check(app, cookie);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: user.id } });
    expect(await sessionExists(app, sessionId)).toBe(true);
  });

  it('answers 401 UNAUTHENTICATED for a tampered, unsigned or malformed cookie and leaves the real session alone', async () => {
    const user = await makeUser(app, 'check-tampered');
    const { cookies, cookie, sessionId } = await loginSession(app, user);
    const sessionCookie = cookies.find((candidate) => candidate.name.includes('session_token'));
    expect(sessionCookie).toBeDefined();
    const { name, value } = sessionCookie!;
    const flipped = `${value.startsWith('a') ? 'b' : 'a'}${value.slice(1)}`;
    const unsigned = decodeURIComponent(value).split('.')[0]!;

    for (const forged of [flipped, unsigned, 'x'.repeat(5_000), '%00', '']) {
      const response = await check(app, `${name}=${forged}`);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(await sessionExists(app, sessionId)).toBe(true);
    expect((await check(app, cookie)).statusCode).toBe(200);
  });

  it('never renews, whatever the query says: a session due for renewal keeps expiresAt and updatedAt and gets no cookie', async () => {
    const user = await makeUser(app, 'check-no-renewal');
    const { cookie, sessionId } = await loginSession(app, user);
    // 6 d 23 h since the last use: far past updateAge (1 day), 2 minutes from the 7-day expiry.
    await app.pool.query('update auth.session set "updatedAt" = now() - interval \'6 days 23 hours\', "expiresAt" = now() + interval \'2 minutes\' where id = $1', [sessionId]);
    const readRow = async () => (await app.pool.query<{ expiresAt: Date; updatedAt: Date }>('select "expiresAt", "updatedAt" from auth.session where id = $1', [sessionId])).rows[0]!;
    const before = await readRow();

    for (const query of ['', '?disableRefresh=false', '?disableRefresh=0&renew=true']) {
      const response = await app.app.inject({ method: 'GET', url: `/auth/session/check${query}`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.headers['set-cookie']).toBeUndefined();
    }

    const after = await readRow();
    expect(new Date(after.expiresAt).getTime()).toBe(new Date(before.expiresAt).getTime());
    expect(new Date(after.updatedAt).getTime()).toBe(new Date(before.updatedAt).getTime());
  });

  it('answers only GET', async () => {
    const user = await makeUser(app, 'check-get-only');
    const { cookie } = await loginSession(app, user);

    const response = await app.app.inject({ method: 'POST', url: '/auth/session/check', headers: { ...origin, cookie } });

    expect(response.statusCode).toBe(404);
  });
});

describe('Cache-Control: no-store on the auth responses that carry session data (#423)', () => {
  let app: TestApp;
  beforeAll(async () => { app = await buildTestApp(); });
  afterAll(async () => { await app.close(); });

  it('is sent by GET /auth/session and GET /auth/session/check, on 200 and on 401', async () => {
    const user = await makeUser(app, 'no-store-session');
    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const cookie = sessionCookieHeader(login.cookies);

    for (const url of ['/auth/session', '/auth/session/check']) {
      const ok = await app.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');

      const unauthenticated = await app.app.inject({ method: 'GET', url });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.headers['cache-control']).toBe('no-store');
    }
  });

  it('is sent on the SESSION_EXPIRED answer of both routes', async () => {
    const user = await makeUser(app, 'no-store-expired');

    for (const url of ['/auth/session', '/auth/session/check']) {
      const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
      await app.pool.query('update auth.session set "createdAt" = now() - interval \'31 days\' where "userId" = $1', [user.id]);
      await queryAsOwner(`update auth.account set "passwordChangedAt" = now() - interval '60 days' where "userId" = $1`, [user.id]);

      const response = await app.app.inject({ method: 'GET', url, headers: { cookie: sessionCookieHeader(login.cookies) } });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'SESSION_EXPIRED' } });
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('is sent by POST /auth/login, which returns the user and issues the session cookie', async () => {
    const user = await makeUser(app, 'no-store-login');

    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });

    expect(response.statusCode).toBe(200);
    expect(response.cookies.length).toBeGreaterThan(0);
    expect(response.headers['cache-control']).toBe('no-store');
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

  it('#9 resets the password with a valid token, revokes all (multiple) prior sessions, creates no session, and audits auth.password_reset', async () => {
    const sender = createFakeEmailSender();
    const app = await openApp({ sender });
    const user = await makeUser(app, 'reset-ok');
    const bystander = await makeUser(app, 'reset-bystander');
    const bystanderLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(bystander) });
    const bystanderCookie = sessionCookieHeader(bystanderLogin.cookies);

    // More than one prior session, as if the same person were logged in on two devices.
    const firstLogin = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'user-agent': 'device-a' }, payload: loginPayload(user)
    });
    const secondLogin = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'user-agent': 'device-b' }, payload: loginPayload(user)
    });
    const firstCookie = sessionCookieHeader(firstLogin.cookies);
    const secondCookie = sessionCookieHeader(secondLogin.cookies);
    const priorSessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
    expect(priorSessionRows.rowCount).toBe(2);

    const token = await requestResetToken(app, sender, user.email);
    const newPassword = 'a brand new correct horse battery staple';
    const reset = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token, newPassword }
    });
    // 2026-10-16: the reset only changes the password; it never signs the person in.
    expect(reset.statusCode).toBe(204);
    expect(reset.body).toBe('');
    expect(reset.cookies).toEqual([]);
    expect(reset.headers['set-cookie']).toBeUndefined();

    const oldSessionCheckA = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: firstCookie } });
    const oldSessionCheckB = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: secondCookie } });
    expect(oldSessionCheckA.statusCode).toBe(401);
    expect(oldSessionCheckB.statusCode).toBe(401);

    // No session survives: not the old ones, and the reset did not create a new one.
    const sessionRowsAfter = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
    expect(sessionRowsAfter.rowCount).toBe(0);

    // Only the account that reset loses its sessions.
    const bystanderCheck = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: bystanderCookie } });
    expect(bystanderCheck.statusCode).toBe(200);

    const loginWithOldPassword = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user)
    });
    expect(loginWithOldPassword.statusCode).toBe(401);
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

  it('#423 a reset answers Cache-Control: no-store, as it carries the reset token and the new password', async () => {
    const sender = createFakeEmailSender();
    const app = await openApp({ sender });
    const user = await makeUser(app, 'reset-no-store');
    const token = await requestResetToken(app, sender, user.email);

    const reset = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token, newPassword: 'a brand new correct horse battery staple' }
    });

    expect(reset.statusCode).toBe(204);
    expect(reset.headers['cache-control']).toBe('no-store');
  });

  it('resets the password with zero contexts, creates no session, audits the reset, and a following login gets its session', async () => {
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

    // The reset answers the same whether or not the account has a context.
    expect(reset.statusCode).toBe(204);
    expect(reset.body).toBe('');
    expect(reset.cookies.length).toBe(0);

    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
    expect(sessionRows.rowCount).toBe(0);

    // The password change itself is audited even though no session was created.
    const auditRows = await queryAsOwner<{ action: string }>(
      "select action from audit.events where action = 'auth.password_reset' and actor_user_id = $1",
      [user.id]
    );
    expect(auditRows.length).toBeGreaterThanOrEqual(1);

    const loginWithNewPassword = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: newPassword }
    });
    expect(loginWithNewPassword.statusCode).toBe(200);
  });

  it('never signs in, so a sign-in failure does not change the answer', async () => {
    const sender = createFakeEmailSender();
    const app = await openApp({ sender });
    const user = await makeUser(app, 'reset-no-sign-in');
    const signInSpy = vi.spyOn(app.auth.api, 'signInEmail').mockRejectedValue(new Error('simulated sign-in failure'));

    try {
      const token = await requestResetToken(app, sender, user.email);
      const reset = await app.app.inject({
        method: 'POST', url: '/auth/password/reset', headers: origin,
        payload: { token, newPassword: 'a password nobody gets signed in with' }
      });

      expect(reset.statusCode).toBe(204);
      expect(reset.cookies.length).toBe(0);
      expect(signInSpy).not.toHaveBeenCalled();
    } finally {
      signInSpy.mockRestore();
    }

    const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
    expect(sessionRows.rowCount).toBe(0);
  });

  it('B10 an unexpected failure part-way through a reset still revokes every session of the account, and tells the client nothing', async () => {
    const sender = createFakeEmailSender();
    const app = await openApp({ sender });
    const user = await makeUser(app, 'reset-b10');
    const bystander = await makeUser(app, 'reset-b10-bystander');
    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    const secondLogin = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: { ...origin, 'user-agent': 'device-b' }, payload: loginPayload(user)
    });
    const bystanderLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(bystander) });
    expect((await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id])).rowCount).toBe(2);
    const token = await requestResetToken(app, sender, user.email);
    const resetSpy = vi.spyOn(app.auth.api, 'resetPassword').mockRejectedValueOnce(new Error('simulated mid-way failure'));

    try {
      const reset = await app.app.inject({
        method: 'POST', url: '/auth/password/reset', headers: origin,
        payload: { token, newPassword: 'a password that may or may not be saved' }
      });

      expect(resetSpy).toHaveBeenCalledTimes(1);
      expect(reset.statusCode).toBe(500);
      expect(reset.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
      expect(reset.body).not.toContain('simulated mid-way failure');
      expect(reset.headers['set-cookie']).toBeUndefined();
    } finally {
      resetSpy.mockRestore();
    }

    for (const cookies of [login.cookies, secondLogin.cookies]) {
      const check = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: sessionCookieHeader(cookies) } });
      expect(check.statusCode).toBe(401);
    }
    expect((await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id])).rowCount).toBe(0);
    const bystanderCheck = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: sessionCookieHeader(bystanderLogin.cookies) } });
    expect(bystanderCheck.statusCode).toBe(200);
  });

  it('refuses an inviteToken in the body: the invitation continues through the login, and nothing changes', async () => {
    const sender = createFakeEmailSender();
    const app = await openApp({ sender });
    const user = await makeUser(app, 'reset-invite-in-body');
    const token = await requestResetToken(app, sender, user.email);

    const refused = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token, newPassword: 'a password the strict body must refuse', inviteToken: 'invite-token' }
    });

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    // The refusal came before the token was used: the old password still logs in, and the same
    // link still resets.
    const stillOldPassword = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: loginPayload(user) });
    expect(stillOldPassword.statusCode).toBe(200);
    const reset = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token, newPassword: 'a password the strict body must refuse' }
    });
    expect(reset.statusCode).toBe(204);
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
    expect(firstUse.statusCode).toBe(204);
    const secondUse = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token: reusedToken, newPassword: 'second use new password value' }
    });
    expect(secondUse.statusCode).toBe(400);
    expect(secondUse.json()).toMatchObject({ error: { code: 'INVALID_LINK', message: 'Este link não é mais válido.' } });
    expect(secondUse.cookies.length).toBe(0);
    const reusedSessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [reusedUser.id]);
    expect(reusedSessionRows.rowCount).toBe(0);

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
    expect(expiredUse.cookies.length).toBe(0);
    const expiredSessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [expiredUser.id]);
    expect(expiredSessionRows.rowCount).toBe(0);
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

describe('Better Auth\'s own sign-up is never reachable (#14)', () => {
  it('#14 every sign-up route but `POST /auth/sign-up` (#706) responds 404', async () => {
    const app = await openApp();
    for (const url of ['/auth/signup', '/auth/register', '/auth/sign-up/email']) {
      const response = await app.app.inject({ method: 'POST', url, headers: origin, payload: {} });
      expect(response.statusCode).toBe(404);
    }
  });
});
