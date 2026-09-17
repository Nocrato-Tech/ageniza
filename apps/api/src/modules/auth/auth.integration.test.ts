import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  captureLogs,
  cleanupTestUser,
  createFakeEmailSender,
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
const openApps: TestApp[] = [];

const openApp: typeof buildTestApp = async (...args) => {
  const app = await buildTestApp(...args);
  openApps.push(app);
  return app;
};

const makeUser = async (app: TestApp, emailLabel: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel });
  createdUsers.push({ app, userId: user.id });
  return user;
};

afterEach(async () => {
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
      new RegExp(`^.*${TEST_APP_PUBLIC_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/reset-password\\?token=`, 's')
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
    const match = /reset-password\?token=([^\s"'&]+)/.exec(link);
    if (!match?.[1]) throw new Error('Reset token was not found in the captured email.');
    return decodeURIComponent(match[1]);
  };

  it('#9 resets the password with a valid token, revokes all sessions, and audits auth.password_reset', async () => {
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
    expect(reset.statusCode).toBe(204);

    const oldSessionCheck = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: firstCookie } });
    expect(oldSessionCheck.statusCode).toBe(401);

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
