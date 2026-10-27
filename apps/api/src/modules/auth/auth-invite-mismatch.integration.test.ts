import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  cleanupOwnedAgencyContext,
  cleanupTestUser,
  createFakeEmailSender,
  grantOwnedAgencyContext,
  insertTestUser,
  queryAsOwner,
  TEST_APP_PUBLIC_URL,
  uniqueTestEmail,
  type TestApp
} from './test-support/harness.js';
import { createInvitationToken } from '../invitations/tokens.js';

/**
 * Issue #339: the `inviteToken` continuation (rules 3 and 3a) only applies to a valid
 * invitation addressed to the same e-mail. Kept in its own file, with one app for every case: the
 * auth integration suite already builds a large number of apps, and each one costs database
 * connections (#167).
 */
const origin = { origin: TEST_APP_PUBLIC_URL };
const sender = createFakeEmailSender();
const createdUsers: Array<{ app: TestApp; userId: string }> = [];
const createdAgencyIds: string[] = [];
const sessionCookieHeader = (setCookies: readonly { name: string; value: string }[]): string =>
  setCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

let app: TestApp;

beforeAll(async () => {
  app = await buildTestApp({ sender });
});

afterEach(async () => {
  const agencyIds = [...createdAgencyIds];
  const userIds = createdUsers.map(({ userId }) => userId);
  if (agencyIds.length > 0) {
    await queryAsOwner('delete from public.invitations where agency_id = any($1::uuid[])', [agencyIds]);
    await queryAsOwner(
      'delete from public.agency_memberships where agency_id = any($1::uuid[]) or user_id = any($2::uuid[])',
      [agencyIds, userIds]
    );
  }
  await Promise.all(createdAgencyIds.splice(0).map((agencyId) => cleanupOwnedAgencyContext(agencyId)));
  await Promise.all(createdUsers.splice(0).map(({ app: testApp, userId }) => cleanupTestUser(testApp.pool, userId)));
});

afterAll(async () => {
  await app.close();
});

const makeUser = async (emailLabel: string) => {
  const user = await insertTestUser(app.pool, app.auth, { emailLabel });
  createdUsers.push({ app, userId: user.id });
  createdAgencyIds.push(await grantOwnedAgencyContext(user.id));
  return user;
};

/** A `collaborator_invite` addressed to `email`, in a fresh agency, in the given validity state. */
const invitationFor = async (
  email: string,
  label: string,
  kind: 'valid' | 'expired' | 'revoked' | 'suspended'
): Promise<{ token: string }> => {
  const agencyOwner = await makeUser(`${label}-owner`);
  const roleRows = await queryAsOwner<{ id: string }>("select id from public.roles where key = 'production' and agency_id is null limit 1");
  const roleId = roleRows[0]?.id;
  if (roleId === undefined) throw new Error('Production role seed is missing.');
  const token = createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL });
  await queryAsOwner(`
    insert into public.invitations (agency_id, purpose, email, role_id, token_hash, expires_at, revoked_at)
    values (
      (select id from public.agencies where owner_user_id = $1 and status = 'active' limit 1),
      'collaborator_invite', $2, $3, $4, $5, $6
    )
  `, [
    agencyOwner.id,
    email,
    roleId,
    token.tokenHash,
    kind === 'expired' ? new Date(Date.now() - 60_000) : token.expiresAt,
    kind === 'revoked' ? new Date() : null
  ]);
  if (kind === 'suspended') {
    await queryAsOwner("update public.agencies set status = 'suspended' where owner_user_id = $1", [agencyOwner.id]);
  }
  return { token: token.token };
};

describe('inviteToken addressed to another e-mail (#339)', () => {
  it('does not attach an invite continuation for another e-mail to the reset message', async () => {
    const account = await makeUser('forgot-invite-other');
    const { token } = await invitationFor(uniqueTestEmail('forgot-invite-other-target'), 'forgot-invite-other', 'valid');

    const response = await app.app.inject({
      method: 'POST', url: '/auth/password/forgot', headers: origin,
      payload: { email: account.email, inviteToken: token }
    });
    expect(response.statusCode).toBe(202);

    await app.emailService.drain();
    const message = sender.sent.filter((sent) => sent.to === account.email).at(-1)?.text ?? '';
    expect(message).toMatch(/senha\/redefinir\?token=/);
    expect(message).not.toContain('invite=');
  });

  it('a reset from a valid invite link leaves no session, and the login that follows still carries the invitation (rule 3a)', async () => {
    const user = await insertTestUser(app.pool, app.auth, { emailLabel: 'reset-invite-continues' });
    createdUsers.push({ app, userId: user.id });
    const { token: inviteToken } = await invitationFor(user.email, 'reset-invite-continues', 'valid');

    await app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: user.email, inviteToken } });
    await app.emailService.drain();
    const message = sender.sent.filter((sent) => sent.to === user.email).at(-1)?.text ?? '';
    expect(message).toContain(`invite=${inviteToken}`);
    const resetToken = decodeURIComponent(/senha\/redefinir\?token=([^\s"'&]+)/.exec(message)?.[1] ?? '');
    const newPassword = 'a brand new correct horse battery staple';

    const reset = await app.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin, payload: { token: resetToken, newPassword }
    });
    expect(reset.statusCode).toBe(204);
    expect(reset.cookies.length).toBe(0);
    expect((await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id])).rowCount).toBe(0);

    // The confirmed account signs in with zero contexts (#706), and the invitation is accepted with that session.
    const withInvite = await app.app.inject({
      method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: newPassword, inviteToken }
    });
    expect(withInvite.statusCode).toBe(200);
    const accepted = await app.app.inject({
      method: 'POST', url: `/invitations/${inviteToken}/accept`,
      headers: { ...origin, cookie: sessionCookieHeader(withInvite.cookies) }
    });
    expect(accepted.statusCode).toBe(200);
  });

  it.each(['expired', 'revoked', 'suspended'] as const)(
    'does not attach an invalid %s invite continuation for the account itself to the reset message',
    async (kind) => {
      const account = await makeUser(`forgot-invite-own-${kind}`);
      const { token } = await invitationFor(account.email, `forgot-invite-own-${kind}`, kind);

      const response = await app.app.inject({
        method: 'POST', url: '/auth/password/forgot', headers: origin,
        payload: { email: account.email, inviteToken: token }
      });
      expect(response.statusCode).toBe(202);

      await app.emailService.drain();
      const message = sender.sent.filter((sent) => sent.to === account.email).at(-1)?.text ?? '';
      expect(message).toMatch(/senha\/redefinir\?token=/);
      expect(message).not.toContain('invite=');
    }
  );
});
