import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  captureLogs,
  cleanupOwnedAgencyContext,
  cleanupTestUser,
  createFakeEmailSender,
  grantOwnedAgencyContext,
  insertTestUser,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from './test-support/harness.js';

// Issue #31 acceptance test #15: logs captured across the flows exercised by tests #1, #8, and #9
// never contain a password, token, cookie value, or a full email address.
const origin = { origin: TEST_APP_PUBLIC_URL };

const createdUsers: Array<{ app: TestApp; userId: string }> = [];
const createdAgencyIds: string[] = [];
const openApps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(createdAgencyIds.splice(0).map((agencyId) => cleanupOwnedAgencyContext(agencyId)));
  await Promise.all(createdUsers.splice(0).map(({ app, userId }) => cleanupTestUser(app.pool, userId)));
});

afterAll(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

/** Also grants an owned agency: the login below (issue #68) is now rejected for zero contexts. */
const makeUser = async (app: TestApp, emailLabel: string): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel });
  createdUsers.push({ app, userId: user.id });
  createdAgencyIds.push(await grantOwnedAgencyContext(user.id));
  return user;
};

const assertNoSecretsLogged = (logText: string, secrets: { readonly password: string; readonly email: string; readonly token?: string; readonly cookie?: string }): void => {
  expect(logText).not.toContain(secrets.password);
  expect(logText).not.toContain(secrets.email);
  if (secrets.token !== undefined) expect(logText).not.toContain(secrets.token);
  if (secrets.cookie !== undefined) expect(logText).not.toContain(secrets.cookie);
};

describe('auth logging never leaks secrets (#15)', () => {
  it('#15 login (test #1) never logs the password, email, or cookie value', async () => {
    const { logger, text } = captureLogs();
    const app = await buildTestApp({ logger });
    openApps.push(app);
    const user = await makeUser(app, 'log-login');

    const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
    expect(response.statusCode).toBe(200);
    const cookieValue = response.cookies[0]?.value;
    expect(cookieValue).toBeDefined();

    assertNoSecretsLogged(text(), { password: user.password, email: user.email, cookie: cookieValue });
  });

  it('#15 password/forgot (test #8) never logs the email or the reset token', async () => {
    const { logger, text } = captureLogs();
    const sender = createFakeEmailSender();
    const app = await buildTestApp({ logger, sender });
    openApps.push(app);
    const user = await makeUser(app, 'log-forgot');

    const response = await app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: user.email } });
    expect(response.statusCode).toBe(202);
    await app.emailService.drain();

    const link = sender.sent.at(-1)?.text ?? '';
    const match = /senha\/redefinir\?token=([^\s"'&]+)/.exec(link);
    const token = match?.[1] !== undefined ? decodeURIComponent(match[1]) : undefined;
    expect(token).toBeDefined();

    assertNoSecretsLogged(text(), { password: user.password, email: user.email, token });
  });

  it('#15 password/reset (test #9) never logs the token, the new password, or the email', async () => {
    const sender = createFakeEmailSender();
    const bootstrapApp = await buildTestApp({ sender });
    openApps.push(bootstrapApp);
    const user = await makeUser(bootstrapApp, 'log-reset');

    await bootstrapApp.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: user.email } });
    await bootstrapApp.emailService.drain();
    const link = sender.sent.at(-1)?.text ?? '';
    const match = /senha\/redefinir\?token=([^\s"'&]+)/.exec(link);
    const token = match?.[1] !== undefined ? decodeURIComponent(match[1]) : undefined;
    expect(token).toBeDefined();

    const { logger, text } = captureLogs();
    const app = await buildTestApp({ logger });
    openApps.push(app);
    const newPassword = 'a completely different correct horse battery staple';

    const response = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token: token as string, newPassword }
    });
    expect(response.statusCode).toBe(204);

    assertNoSecretsLogged(text(), { password: newPassword, email: user.email, token });
  });
});
