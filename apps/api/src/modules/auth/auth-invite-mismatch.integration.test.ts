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
 * Issue #339: the `inviteToken` continuation (rules 3, 3a and 8a) only applies to a valid
 * invitation addressed to the same e-mail. Kept in its own file, with one app for every case: the
 * auth integration suite already builds a large number of apps, and each one costs database
 * connections (#167).
 */
const origin = { origin: TEST_APP_PUBLIC_URL };
const sender = createFakeEmailSender();
const createdUsers: Array<{ app: TestApp; userId: string }> = [];
const createdAgencyIds: string[] = [];

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

/** A pending `collaborator_invite` addressed to a random address, in a fresh agency. */
const invitationForAnotherEmail = async (
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
    uniqueTestEmail(`${label}-target`),
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

const requestResetToken = async (email: string): Promise<string> => {
  await app.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email } });
  await app.emailService.drain();
  const message = sender.sent.filter((sent) => sent.to === email).at(-1)?.text ?? '';
  const match = /senha\/redefinir\?token=([^\s"'&]+)/.exec(message);
  if (!match?.[1]) throw new Error('Reset token was not found in the captured email.');
  return decodeURIComponent(match[1]);
};

describe('inviteToken addressed to another e-mail (#339)', () => {
  it('does not attach an invite continuation for another e-mail to the reset message', async () => {
    const account = await makeUser('forgot-invite-other');
    const { token } = await invitationForAnotherEmail('forgot-invite-other', 'valid');

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

  it.each(['valid', 'expired', 'revoked', 'suspended'] as const)(
    'ignores a %s invite continuation addressed to another e-mail: NO_CONTEXT_ACCESS, no cookie, no session',
    async (kind) => {
      const user = await insertTestUser(app.pool, app.auth, { emailLabel: `reset-invite-other-${kind}` });
      createdUsers.push({ app, userId: user.id });
      const { token: inviteToken } = await invitationForAnotherEmail(`reset-invite-other-${kind}`, kind);

      const token = await requestResetToken(user.email);
      const reset = await app.app.inject({
        method: 'POST', url: '/auth/password/reset', headers: origin,
        payload: { token, newPassword: 'a brand new correct horse battery staple', inviteToken }
      });

      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toEqual({ signedIn: false, reason: 'NO_CONTEXT_ACCESS' });
      expect(reset.cookies.length).toBe(0);
      const sessionRows = await app.pool.query('select 1 from auth.session where "userId" = $1', [user.id]);
      expect(sessionRows.rowCount).toBe(0);
    }
  );
});
