import { afterAll, afterEach, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  captureLogs,
  cleanupOwnedAgencyContext,
  cleanupTestUser,
  createFakeEmailSender,
  grantOwnedAgencyContext,
  insertTestUser,
  queryAsOwner,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from './test-support/harness.js';
import { createInvitationToken } from '../invitations/tokens.js';

// Issue #31 acceptance test #15: logs captured across the flows exercised by tests #1, #8, and #9
// never contain a password, token, cookie value, or a full email address.
const origin = { origin: TEST_APP_PUBLIC_URL };

const createdUsers: Array<{ app: TestApp; userId: string }> = [];
const createdAgencyIds: string[] = [];
const createdInvitationIds: string[] = [];
const openApps: TestApp[] = [];

afterEach(async () => {
  const invitationIds = createdInvitationIds.splice(0);
  if (invitationIds.length > 0) {
    await queryAsOwner('delete from public.invitations where id = any($1::uuid[])', [invitationIds]);
  }
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

const assertNoSecretsLogged = (logText: string, secrets: { readonly password: string; readonly email: string; readonly token?: string; readonly cookie?: string; readonly inviteToken?: string }): void => {
  expect(logText).not.toContain(secrets.password);
  expect(logText).not.toContain(secrets.email);
  if (secrets.token !== undefined) expect(logText).not.toContain(secrets.token);
  if (secrets.cookie !== undefined) expect(logText).not.toContain(secrets.cookie);
  if (secrets.inviteToken !== undefined) expect(logText).not.toContain(secrets.inviteToken);
};

/** A `collaborator_invite` addressed to `email`, same shape as `auth.integration.test.ts`'s own
 * helper -- needed here to exercise the `password/reset` `inviteToken` continuation branch. */
const insertCollaboratorInvitation = async (input: { readonly agencyId: string; readonly email: string }): Promise<{ readonly token: string }> => {
  const roleRows = await queryAsOwner<{ id: string }>("select id from public.roles where key = 'production' and agency_id is null limit 1");
  const roleId = roleRows[0]?.id;
  if (roleId === undefined) throw new Error('Production role seed is missing.');
  const token = createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL });
  const rows = await queryAsOwner<{ id: string }>(`
    insert into public.invitations (agency_id, purpose, email, role_id, token_hash, expires_at)
    values ($1, 'collaborator_invite', $2, $3, $4, $5)
    returning id
  `, [input.agencyId, input.email, roleId, token.tokenHash, token.expiresAt]);
  const invitationId = rows[0]?.id;
  if (invitationId === undefined) throw new Error('Failed to insert the test invitation.');
  createdInvitationIds.push(invitationId);
  return { token: token.token };
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
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ signedIn: true });

    assertNoSecretsLogged(text(), { password: newPassword, email: user.email, token });
  });

  it('#15 password/reset with zero contexts (signedIn:false, NO_CONTEXT_ACCESS) never logs the token, the new password, or the email', async () => {
    const sender = createFakeEmailSender();
    const bootstrapApp = await buildTestApp({ sender });
    openApps.push(bootstrapApp);
    const user = await insertTestUser(bootstrapApp.pool, bootstrapApp.auth, { emailLabel: 'log-reset-zero-context' });
    createdUsers.push({ app: bootstrapApp, userId: user.id });

    await bootstrapApp.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: user.email } });
    await bootstrapApp.emailService.drain();
    const link = sender.sent.at(-1)?.text ?? '';
    const match = /senha\/redefinir\?token=([^\s"'&]+)/.exec(link);
    const token = match?.[1] !== undefined ? decodeURIComponent(match[1]) : undefined;
    expect(token).toBeDefined();

    const { logger, text } = captureLogs();
    const app = await buildTestApp({ logger });
    openApps.push(app);
    const newPassword = 'a zero context correct horse battery staple';

    const response = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token: token as string, newPassword }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ signedIn: false, reason: 'NO_CONTEXT_ACCESS' });

    assertNoSecretsLogged(text(), { password: newPassword, email: user.email, token });
  });

  it('#15 password/reset with a valid inviteToken continuation never logs the token, the inviteToken, the new password, or the email', async () => {
    const sender = createFakeEmailSender();
    const bootstrapApp = await buildTestApp({ sender });
    openApps.push(bootstrapApp);
    await makeUser(bootstrapApp, 'log-reset-invite-owner');
    const agencyId = createdAgencyIds.at(-1);
    if (agencyId === undefined) throw new Error('Expected grantOwnedAgencyContext to have created an agency.');
    const invitee = await insertTestUser(bootstrapApp.pool, bootstrapApp.auth, { emailLabel: 'log-reset-invite-invitee' });
    createdUsers.push({ app: bootstrapApp, userId: invitee.id });
    const { token: inviteToken } = await insertCollaboratorInvitation({ agencyId, email: invitee.email });

    await bootstrapApp.app.inject({
      method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: invitee.email, inviteToken }
    });
    await bootstrapApp.emailService.drain();
    const link = sender.sent.at(-1)?.text ?? '';
    const match = /senha\/redefinir\?token=([^\s"'&]+)/.exec(link);
    const resetToken = match?.[1] !== undefined ? decodeURIComponent(match[1]) : undefined;
    expect(resetToken).toBeDefined();
    expect(link).toContain(`invite=${inviteToken}`);

    const { logger, text } = captureLogs();
    const app = await buildTestApp({ logger });
    openApps.push(app);
    const newPassword = 'an invite continuation correct horse battery staple';

    const response = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token: resetToken as string, newPassword, inviteToken }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ signedIn: true });

    assertNoSecretsLogged(text(), { password: newPassword, email: invitee.email, token: resetToken, inviteToken });
  });
});
