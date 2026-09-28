import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
  captureLogs,
  createFakeEmailSender,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import { createInvitationToken } from './tokens.js';
import type { DatabaseClient } from '@ageniza/database';
import { randomUUID } from 'node:crypto';

const origin = { origin: TEST_APP_PUBLIC_URL };

let owner: DatabaseClient;
let app: TestApp;
let sender: ReturnType<typeof createFakeEmailSender>;
let admin: TestUserFixture;
let invitee: TestUserFixture;
const agencyId = randomUUID();
const clientId = randomUUID();
const activationAgencyId = randomUUID();
let activationUserId: string | undefined;
const createdUserIds: string[] = [];
const createdAgencyIds = [agencyId, activationAgencyId];
const createdClientIds = [clientId];
const createdCustomRoleIds: string[] = [];
let adminRoleId: string;
let productionRoleId: string;

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const loginCookie = async (user: TestUserFixture): Promise<string> => {
  const response = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: user.email, password: user.password } });
  expect(response.statusCode).toBe(200);
  return sessionCookieHeader(response.cookies);
};

const makeUser = async (emailLabel: string, options: Parameters<typeof insertTestUser>[2] = {}): Promise<TestUserFixture> => {
  const user = await insertTestUser(app.pool, app.auth, { ...options, emailLabel });
  createdUserIds.push(user.id);
  return user;
};

const createAgency = async (name: string, ownerUserId: string | null = null): Promise<string> => {
  const id = randomUUID();
  createdAgencyIds.push(id);
  await owner.knex('agencies').insert({ id, name, owner_user_id: ownerUserId });
  return id;
};

const insertInvitation = async (input: {
  readonly agencyId: string;
  readonly email: string;
  readonly purpose?: 'agency_activation' | 'collaborator_invite' | 'client_invite';
  readonly roleId?: string | null;
  readonly clientId?: string | null;
  readonly expiresAt?: Date;
  readonly usedAt?: Date | null;
  readonly revokedAt?: Date | null;
}): Promise<{ invitationId: string; token: string }> => {
  const invitationId = randomUUID();
  const token = createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL });
  await owner.knex('invitations').insert({
    id: invitationId,
    agency_id: input.agencyId,
    purpose: input.purpose ?? 'collaborator_invite',
    email: input.email,
    role_id: input.roleId === undefined ? productionRoleId : input.roleId,
    client_id: input.clientId === undefined ? null : input.clientId,
    token_hash: token.tokenHash,
    expires_at: input.expiresAt ?? token.expiresAt,
    used_at: input.usedAt ?? null,
    revoked_at: input.revokedAt ?? null
  });
  return { invitationId, token: token.token };
};

const invitationTokenFromLatestEmail = (emailSender = sender): string => {
  const text = emailSender.sent.at(-1)?.text ?? '';
  const token = text.match(/\/convite\/([^\s]+)/)?.[1];
  if (token === undefined) throw new Error('The invitation email did not contain a token.');
  return token;
};

describe('invitation HTTP module', () => {
  beforeAll(async () => {
    owner = ownerClient();
    sender = createFakeEmailSender();
    app = await buildTestApp({ sender });
    admin = await makeUser('invitation-admin');
    invitee = await makeUser('invitation-invitee');

    const adminRole = await owner.knex('roles').where({ key: 'admin' }).whereNull('agency_id').first('id');
    const productionRole = await owner.knex('roles').where({ key: 'production' }).whereNull('agency_id').first('id');
    if (adminRole === undefined) throw new Error('Admin role seed is missing.');
    if (productionRole === undefined) throw new Error('Production role seed is missing.');
    adminRoleId = adminRole.id;
    productionRoleId = productionRole.id;
    await owner.knex('agencies').insert({ id: agencyId, name: 'Invitation Agency', owner_user_id: admin.id });
    await owner.knex('clients').insert({ id: clientId, agency_id: agencyId, name: 'Invitation Client' });
    await owner.knex('agencies').insert({ id: activationAgencyId, name: 'Activation Agency', owner_user_id: null });
    const activation = createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL });
    await owner.knex('invitations').insert({
      agency_id: activationAgencyId,
      purpose: 'agency_activation',
      email: `activation-${agencyId}@example.test`,
      token_hash: activation.tokenHash,
      expires_at: activation.expiresAt
    });
    await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: admin.id, role_id: adminRole.id });
  });

  afterAll(async () => {
    const agencyIds = [...new Set(createdAgencyIds)];
    const clientIds = [...new Set(createdClientIds)];
    await owner.knex('audit.events').whereIn('agency_id', agencyIds).delete();
    await owner.knex('invitations').whereIn('agency_id', agencyIds).delete();
    await owner.knex('client_memberships').whereIn('client_id', clientIds).delete();
    await owner.knex('agency_memberships').whereIn('agency_id', agencyIds).delete();
    await owner.knex('roles').whereIn('id', createdCustomRoleIds).delete();
    await owner.knex('clients').whereIn('id', clientIds).delete();
    await owner.knex('agencies').whereIn('id', agencyIds).update({ owner_user_id: null });
    await owner.knex('agencies').whereIn('id', agencyIds).delete();
    await owner.knex('legal_acceptances').whereIn('user_id', createdUserIds).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [createdUserIds]);
    await app.close();
    await owner.close();
  });

  it('creates, previews and accepts an existing-account collaborator invitation', async () => {
    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: admin.email, password: admin.password } });
    expect(login.statusCode).toBe(200);
    const adminCookie = sessionCookieHeader(login.cookies);

    const created = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/collaborators`,
      headers: { ...origin, cookie: adminCookie },
      payload: { email: invitee.email.toUpperCase(), roleId: productionRoleId }
    });
    expect(created.statusCode).toBe(201);
    const invitationId = created.json<{ invitationId: string }>().invitationId;
    expect(sender.sent).toHaveLength(1);
    const link = sender.sent[0]?.text.match(/\/convite\/([^\s]+)/)?.[1];
    expect(link).toBeDefined();

    const preview = await app.app.inject({ method: 'GET', url: `/invitations/${link}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ purpose: 'collaborator_invite', email: invitee.email, accountExists: true });

    const inviteeLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: invitee.email, password: invitee.password } });
    const inviteeCookie = sessionCookieHeader(inviteeLogin.cookies);
    const accepted = await app.app.inject({ method: 'POST', url: `/invitations/${link}/accept`, headers: { ...origin, cookie: inviteeCookie } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted', context: { agencyId, clientId: null } });

    const invitation = await owner.knex('invitations').where({ id: invitationId }).first('used_at', 'accepted_by_user_id');
    expect(invitation?.used_at).toBeInstanceOf(Date);
    expect(invitation?.accepted_by_user_id).toBe(invitee.id);
    await expect(owner.knex('agency_memberships').where({ agency_id: agencyId, user_id: invitee.id }).first('role_id', 'status')).resolves.toEqual({
      role_id: productionRoleId,
      status: 'active'
    });
  });

  it('keeps a valid client invitation through forgot/reset and signs the account in', async () => {
    const adminLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: admin.email, password: admin.password } });
    const adminCookie = sessionCookieHeader(adminLogin.cookies);
    const created = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/clients/${clientId}/invitations`,
      headers: { ...origin, cookie: adminCookie },
      payload: { email: invitee.email }
    });
    expect(created.statusCode).toBe(201);
    const inviteToken = sender.sent.at(-1)?.text.match(/\/convite\/([^\s]+)/)?.[1];
    expect(inviteToken).toBeDefined();

    const forgot = await app.app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      headers: origin,
      payload: { email: invitee.email, inviteToken }
    });
    expect(forgot.statusCode).toBe(202);
    await app.emailService.drain();
    const resetMessage = sender.sent.at(-1)?.text ?? '';
    const resetToken = /senha\/redefinir\?token=([^&\s]+)/.exec(resetMessage)?.[1];
    expect(resetToken).toBeDefined();
    expect(resetMessage).toContain(`invite=${inviteToken}`);

    const reset = await app.app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      headers: origin,
      payload: { token: decodeURIComponent(resetToken!), newPassword: 'a different secure password', inviteToken }
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ signedIn: true });

    const accepted = await app.app.inject({
      method: 'POST',
      url: `/invitations/${inviteToken}/accept`,
      headers: { ...origin, cookie: sessionCookieHeader(reset.cookies) }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted', context: { agencyId, clientId } });
  });

  it('atomically creates and signs in a new account for agency activation', async () => {
    const activation = await owner.knex('invitations').where({ agency_id: activationAgencyId, purpose: 'agency_activation' }).first('token_hash', 'email');
    expect(activation).toBeDefined();
    const email = activation!.email;
    const token = createInvitationToken({ appPublicUrl: TEST_APP_PUBLIC_URL });
    await owner.knex('invitations').where({ agency_id: activationAgencyId, purpose: 'agency_activation' }).update({ token_hash: token.tokenHash, expires_at: token.expiresAt });

    const preview = await app.app.inject({ method: 'GET', url: `/invitations/${token.token}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ purpose: 'agency_activation', email, accountExists: false, client: null });

    const accepted = await app.app.inject({
      method: 'POST',
      url: `/invitations/${token.token}/accept-new-account`,
      headers: origin,
      payload: { name: 'Activation Owner', password: 'a secure activation password', acceptTerms: true }
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ status: 'accepted', context: { agencyId: activationAgencyId, clientId: null } });
    const session = await app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: sessionCookieHeader(accepted.cookies) } });
    expect(session.statusCode).toBe(200);
    activationUserId = session.json<{ user: { id: string } }>().user.id;
    createdUserIds.push(activationUserId);

    const agency = await owner.knex('agencies').where({ id: activationAgencyId }).first('owner_user_id');
    expect(agency?.owner_user_id).toBe(activationUserId);
    const legal = await owner.knex('legal_acceptances').where({ user_id: activationUserId }).select('document');
    expect(legal).toHaveLength(2);
  });

  it('revokes the previous token on resend and rejects repeated cancellation', async () => {
    const adminLogin = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: admin.email, password: admin.password } });
    const adminCookie = sessionCookieHeader(adminLogin.cookies);
    const targetEmail = `pending-${agencyId}@example.test`;
    const created = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/collaborators`,
      headers: { ...origin, cookie: adminCookie },
      payload: { email: targetEmail, roleId: productionRoleId }
    });
    expect(created.statusCode).toBe(201);
    const invitationId = created.json<{ invitationId: string }>().invitationId;
    const oldToken = sender.sent.at(-1)?.text.match(/\/convite\/([^\s]+)/)?.[1];
    expect(oldToken).toBeDefined();

    const resent = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/${invitationId}/resend`,
      headers: { ...origin, cookie: adminCookie }
    });
    expect(resent.statusCode).toBe(200);
    const newInvitationId = resent.json<{ invitationId: string }>().invitationId;
    const newToken = sender.sent.at(-1)?.text.match(/\/convite\/([^\s]+)/)?.[1];
    expect(newToken).toBeDefined();
    expect(newInvitationId).not.toBe(invitationId);

    const oldPreview = await app.app.inject({ method: 'GET', url: `/invitations/${oldToken}` });
    expect(oldPreview.statusCode).toBe(410);
    const cancelled = await app.app.inject({
      method: 'DELETE',
      url: `/agencies/${agencyId}/invitations/${newInvitationId}`,
      headers: { ...origin, cookie: adminCookie }
    });
    expect(cancelled.statusCode).toBe(204);
    const newPreview = await app.app.inject({ method: 'GET', url: `/invitations/${newToken}` });
    expect(newPreview.statusCode).toBe(410);
    const repeated = await app.app.inject({
      method: 'DELETE',
      url: `/agencies/${agencyId}/invitations/${newInvitationId}`,
      headers: { ...origin, cookie: adminCookie }
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({ error: { code: 'INVITATION_NOT_PENDING' } });
  });

  it.each([
    ['missing', () => `missing-${randomUUID()}`],
    ['expired', async () => (await insertInvitation({ agencyId, email: `expired-${randomUUID()}@example.test`, expiresAt: new Date(Date.now() - 1_000) })).token],
    ['used', async () => (await insertInvitation({ agencyId, email: `used-${randomUUID()}@example.test`, usedAt: new Date() })).token],
    ['revoked', async () => (await insertInvitation({ agencyId, email: `revoked-${randomUUID()}@example.test`, revokedAt: new Date() })).token]
  ])('returns the same INVALID_LINK error for %s invitations', async (_label, tokenFactory) => {
    const token = await tokenFactory();
    const response = await app.app.inject({ method: 'GET', url: `/invitations/${token}` });
    expect(response.statusCode).toBe(410);
    expect(response.json().error).toEqual({ code: 'INVALID_LINK', message: 'Este link não é mais válido.' });
  });

  it('treats a suspended agency invitation as the same invalid link and keeps its data', async () => {
    const suspendedAgencyId = await createAgency('Suspended invitation agency', admin.id);
    const invitation = await insertInvitation({ agencyId: suspendedAgencyId, email: `suspended-${randomUUID()}@example.test` });
    await owner.knex('agencies').where({ id: suspendedAgencyId }).update({ status: 'suspended' });

    const response = await app.app.inject({ method: 'GET', url: `/invitations/${invitation.token}` });
    expect(response.statusCode).toBe(410);
    expect(response.json().error).toEqual({ code: 'INVALID_LINK', message: 'Este link não é mais válido.' });
    await owner.knex('agencies').where({ id: suspendedAgencyId }).update({ status: 'active' });
    await expect(app.app.inject({ method: 'GET', url: `/invitations/${invitation.token}` })).resolves.toMatchObject({ statusCode: 200 });
  });

  it('rejects accept-new-account for an existing identity without consuming the invitation', async () => {
    const invitation = await insertInvitation({ agencyId, email: invitee.email });
    const response = await app.app.inject({
      method: 'POST',
      url: `/invitations/${invitation.token}/accept-new-account`,
      headers: origin,
      payload: { name: 'Existing account', password: 'a valid replacement password', acceptTerms: true }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: 'ACCOUNT_EXISTS' });
    await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('used_at')).resolves.toEqual({ used_at: null });
  });

  it('rejects a mismatched session without logging it out, then returns already_member without consuming the token', async () => {
    const mismatch = await insertInvitation({ agencyId, email: admin.email });
    // A dedicated user: the earlier forgot/reset test rotates `invitee`'s password, so its fixture
    // password no longer logs in.
    const otherUser = await makeUser('invitation-mismatch');
    const otherCookie = await loginCookie(otherUser);
    const mismatchResponse = await app.app.inject({
      method: 'POST',
      url: `/invitations/${mismatch.token}/accept`,
      headers: { ...origin, cookie: otherCookie }
    });
    expect(mismatchResponse.statusCode).toBe(403);
    expect(mismatchResponse.json().error).toMatchObject({ code: 'INVITATION_ACCOUNT_MISMATCH' });
    await expect(app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: otherCookie } })).resolves.toMatchObject({ statusCode: 200 });
    await owner.knex('invitations').where({ id: mismatch.invitationId }).delete();

    const already = await insertInvitation({ agencyId, email: admin.email });
    const alreadyResponse = await app.app.inject({
      method: 'POST',
      url: `/invitations/${already.token}/accept`,
      headers: { ...origin, cookie: await loginCookie(admin) }
    });
    expect(alreadyResponse.statusCode).toBe(200);
    expect(alreadyResponse.json()).toMatchObject({ status: 'already_member', context: { agencyId, clientId: null } });
    await expect(owner.knex('invitations').where({ id: already.invitationId }).first('used_at')).resolves.toEqual({ used_at: null });
  });

  it('enforces owner and member permissions while hiding the agency from unrelated users', async () => {
    const productionUser = await makeUser('invitation-production');
    await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: productionUser.id, role_id: productionRoleId });
    const forbidden = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/collaborators`,
      headers: { ...origin, cookie: await loginCookie(productionUser) },
      payload: { email: `forbidden-${randomUUID()}@example.test`, roleId: productionRoleId }
    });
    expect(forbidden.statusCode).toBe(403);

    const unrelated = await makeUser('invitation-unrelated');
    const hidden = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/collaborators`,
      headers: { ...origin, cookie: await loginCookie(unrelated) },
      payload: { email: `hidden-${randomUUID()}@example.test`, roleId: productionRoleId }
    });
    expect(hidden.statusCode).toBe(404);

    const ownerOnly = await makeUser('invitation-owner-only');
    const ownerOnlyAgency = await createAgency('Owner-only agency', ownerOnly.id);
    const ownerInvite = await app.app.inject({
      method: 'POST',
      url: `/agencies/${ownerOnlyAgency}/invitations/collaborators`,
      headers: { ...origin, cookie: await loginCookie(ownerOnly) },
      payload: { email: `owner-invite-${randomUUID()}@example.test`, roleId: productionRoleId }
    });
    expect(ownerInvite.statusCode).toBe(201);
  });

  it('denies the whole tenant while the agency is suspended and restores it untouched on reactivation', async () => {
    const suspendedOwner = await makeUser('invitation-suspend-owner');
    const suspendedMember = await makeUser('invitation-suspend-member');
    const suspendableAgency = await createAgency('Suspendable agency', suspendedOwner.id);
    await owner.knex('agency_memberships').insert({ agency_id: suspendableAgency, user_id: suspendedMember.id, role_id: productionRoleId });
    const ownerCookie = await loginCookie(suspendedOwner);
    const memberCookie = await loginCookie(suspendedMember);
    const invite = async (cookie: string): Promise<number> => (await app.app.inject({
      method: 'POST',
      url: `/agencies/${suspendableAgency}/invitations/collaborators`,
      headers: { ...origin, cookie },
      payload: { email: `suspend-${randomUUID()}@example.test`, roleId: productionRoleId }
    })).statusCode;

    // While active the guard lets both through: the owner has every permission, and the
    // production member is stopped by the permission check, not by the tenant guard.
    expect(await invite(ownerCookie)).toBe(201);
    expect(await invite(memberCookie)).toBe(403);

    await owner.knex('agencies').where({ id: suspendableAgency }).update({ status: 'suspended' });
    // Suspension turns 201 and 403 alike into a non-enumerating 404: the tenant guard now denies
    // everyone, on the very next request, without touching sessions.
    expect(await invite(ownerCookie)).toBe(404);
    expect(await invite(memberCookie)).toBe(404);
    await expect(app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: memberCookie } })).resolves.toMatchObject({ statusCode: 200 });
    // Other tenants are unaffected.
    const unaffected = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/collaborators`,
      headers: { ...origin, cookie: await loginCookie(admin) },
      payload: { email: `unaffected-${randomUUID()}@example.test`, roleId: productionRoleId }
    });
    expect(unaffected.statusCode).toBe(201);

    await owner.knex('agencies').where({ id: suspendableAgency }).update({ status: 'active' });
    expect(await invite(ownerCookie)).toBe(201);
    expect(await invite(memberCookie)).toBe(403);
    await expect(owner.knex('agency_memberships').where({ agency_id: suspendableAgency, user_id: suspendedMember.id }).first('role_id', 'status')).resolves.toEqual({
      role_id: productionRoleId,
      status: 'active'
    });
  });

  it('revokes an equivalent pending invitation when a second one is created', async () => {
    const targetEmail = `equivalent-${randomUUID()}@example.test`;
    const cookie = await loginCookie(admin);
    const first = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/collaborators`,
      headers: { ...origin, cookie },
      payload: { email: targetEmail, roleId: productionRoleId }
    });
    expect(first.statusCode).toBe(201);
    const oldToken = invitationTokenFromLatestEmail();
    const firstId = first.json<{ invitationId: string }>().invitationId;
    const second = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/collaborators`,
      headers: { ...origin, cookie },
      payload: { email: targetEmail, roleId: adminRoleId }
    });
    expect(second.statusCode).toBe(201);
    expect((await app.app.inject({ method: 'GET', url: `/invitations/${oldToken}` })).statusCode).toBe(410);
    await expect(owner.knex('invitations').where({ id: firstId }).first('revoked_at')).resolves.toMatchObject({ revoked_at: expect.any(Date) });
  });

  it('serializes two concurrent equivalent invitations instead of losing one to the unique index', async () => {
    const targetEmail = `concurrent-${randomUUID()}@example.test`;
    const cookie = await loginCookie(admin);
    const send = (): Promise<{ statusCode: number; invitationId?: string }> => app.app
      .inject({
        method: 'POST',
        url: `/agencies/${agencyId}/invitations/collaborators`,
        headers: { ...origin, cookie },
        payload: { email: targetEmail, roleId: productionRoleId }
      })
      .then((response) => ({ statusCode: response.statusCode, invitationId: response.json<{ invitationId?: string }>().invitationId }));

    // Without the advisory lock the revoking UPDATE cannot see the row the other transaction
    // inserted after its snapshot, so one side used to lose on the partial unique index and 500.
    const results = await Promise.all([send(), send()]);
    expect(results.map((result) => result.statusCode)).toEqual([201, 201]);
    // Exactly one pending invitation survives, and the other was revoked rather than rejected.
    const rows = await owner.knex('invitations').where({ agency_id: agencyId, email: targetEmail }).select('id', 'revoked_at');
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
  });

  it('validates collaborator roles and client tenant ownership', async () => {
    const otherAgency = await createAgency('Other role agency', admin.id);
    const otherRoleId = randomUUID();
    createdCustomRoleIds.push(otherRoleId);
    await owner.knex('roles').insert({ id: otherRoleId, agency_id: otherAgency, key: `custom-${otherRoleId}`, name: 'Other role', is_system: false });
    const invalidRoleResponse = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/collaborators`,
      headers: { ...origin, cookie: await loginCookie(admin) },
      payload: { email: `invalid-role-${randomUUID()}@example.test`, roleId: otherRoleId }
    });
    expect(invalidRoleResponse.statusCode).toBe(400);
    expect(invalidRoleResponse.json().error).toMatchObject({ code: 'INVALID_ROLE' });

    const otherClientId = randomUUID();
    createdClientIds.push(otherClientId);
    await owner.knex('clients').insert({ id: otherClientId, agency_id: otherAgency, name: 'Other client' });
    const invalidClientResponse = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/clients/${otherClientId}/invitations`,
      headers: { ...origin, cookie: await loginCookie(admin) },
      payload: { email: `invalid-client-${randomUUID()}@example.test` }
    });
    expect(invalidClientResponse.statusCode).toBe(404);
    expect(invalidClientResponse.json().error).toMatchObject({ code: 'NOT_FOUND' });
  });

  describe('GET /agencies/:agencyId/invitations', () => {
    const systemRoleId = async (key: string): Promise<string> => {
      const role = await owner.knex('roles').where({ key }).whereNull('agency_id').first('id');
      if (role === undefined) throw new Error(`Role seed "${key}" is missing.`);
      return role.id as string;
    };

    it('returns only pending collaborator invitations for that agency, paginated by the shared contract', async () => {
      const pendingAgencyOwner = await makeUser('invitations-pending-owner');
      const pendingAgencyId = await createAgency('Pending invitations agency', pendingAgencyOwner.id);
      const otherAgencyId = await createAgency('Other pending invitations agency', pendingAgencyOwner.id);
      const otherClientId = randomUUID();
      createdClientIds.push(otherClientId);
      await owner.knex('clients').insert({ id: otherClientId, agency_id: pendingAgencyId, name: 'Pending invitations client' });

      const pendingEmail = `pending-list-${randomUUID()}@example.test`;
      const pending = await insertInvitation({ agencyId: pendingAgencyId, email: pendingEmail, roleId: productionRoleId });
      const used = await insertInvitation({ agencyId: pendingAgencyId, email: `used-list-${randomUUID()}@example.test`, roleId: productionRoleId, usedAt: new Date() });
      const revoked = await insertInvitation({ agencyId: pendingAgencyId, email: `revoked-list-${randomUUID()}@example.test`, roleId: productionRoleId, revokedAt: new Date() });
      const expired = await insertInvitation({ agencyId: pendingAgencyId, email: `expired-list-${randomUUID()}@example.test`, roleId: productionRoleId, expiresAt: new Date(Date.now() - 1_000) });
      // Same policy (`invitations_select`) grants read access for both invitation types; only the
      // query's own `purpose` filter is what has to keep this out of a collaborator-only list.
      const clientInvite = await insertInvitation({ agencyId: pendingAgencyId, email: `client-list-${randomUUID()}@example.test`, purpose: 'client_invite', roleId: null, clientId: otherClientId });
      const elsewhere = await insertInvitation({ agencyId: otherAgencyId, email: `elsewhere-list-${randomUUID()}@example.test`, roleId: productionRoleId });

      const response = await app.app.inject({
        method: 'GET',
        url: `/agencies/${pendingAgencyId}/invitations`,
        headers: { ...origin, cookie: await loginCookie(pendingAgencyOwner) }
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: Array<Record<string, unknown>>; meta: Record<string, unknown> }>();

      expect(body.meta).toEqual({ page: 1, pageSize: 24, totalItems: 1, totalPages: 1 });
      expect(body.data).toHaveLength(1);
      const [item] = body.data;
      expect(item).toMatchObject({
        id: pending.invitationId,
        email: pendingEmail,
        purpose: 'collaborator_invite',
        role: { key: 'production', name: expect.any(String) },
        client: null
      });
      expect(item).toHaveProperty('createdAt');
      expect(item).toHaveProperty('expiresAt');
      expect(Object.keys(item ?? {}).sort()).toEqual(['client', 'createdAt', 'email', 'expiresAt', 'id', 'purpose', 'role']);

      const returnedIds = body.data.map((row) => row.id);
      expect(returnedIds).not.toContain(used.invitationId);
      expect(returnedIds).not.toContain(revoked.invitationId);
      expect(returnedIds).not.toContain(expired.invitationId);
      expect(returnedIds).not.toContain(clientInvite.invitationId);
      expect(returnedIds).not.toContain(elsewhere.invitationId);

      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/token/i);
      const storedHash = (await owner.knex('invitations').where({ id: pending.invitationId }).first('token_hash'))?.token_hash;
      expect(storedHash).toBeDefined();
      expect(serialized).not.toContain(storedHash);
    });

    it('paginates with the shared { data, meta } contract and a 100-item ceiling on pageSize', async () => {
      const pageOwner = await makeUser('invitations-pending-page-owner');
      const pageAgencyId = await createAgency('Pending invitations page agency', pageOwner.id);
      const emails = await Promise.all(
        [0, 1, 2].map((index) => insertInvitation({ agencyId: pageAgencyId, email: `page-list-${index}-${randomUUID()}@example.test`, roleId: productionRoleId }))
      );
      expect(emails).toHaveLength(3);

      const firstPage = await app.app.inject({
        method: 'GET',
        url: `/agencies/${pageAgencyId}/invitations?page=1&pageSize=2`,
        headers: { ...origin, cookie: await loginCookie(pageOwner) }
      });
      expect(firstPage.statusCode).toBe(200);
      const firstBody = firstPage.json<{ data: unknown[]; meta: Record<string, unknown> }>();
      expect(firstBody.data).toHaveLength(2);
      expect(firstBody.meta).toEqual({ page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });

      const secondPage = await app.app.inject({
        method: 'GET',
        url: `/agencies/${pageAgencyId}/invitations?page=2&pageSize=2`,
        headers: { ...origin, cookie: await loginCookie(pageOwner) }
      });
      const secondBody = secondPage.json<{ data: unknown[]; meta: Record<string, unknown> }>();
      expect(secondBody.data).toHaveLength(1);
      expect(secondBody.meta).toEqual({ page: 2, pageSize: 2, totalItems: 3, totalPages: 2 });

      const ceiling = await app.app.inject({
        method: 'GET',
        url: `/agencies/${pageAgencyId}/invitations?pageSize=100000`,
        headers: { ...origin, cookie: await loginCookie(pageOwner) }
      });
      expect(ceiling.statusCode).toBe(200);
      expect(ceiling.json<{ meta: { pageSize: number } }>().meta.pageSize).toBe(100);
    });

    it.each(['account_manager', 'production', 'sales', 'finance'])('returns 403 for a %s collaborator', async (roleKey) => {
      const member = await makeUser(`invitations-pending-${roleKey}`);
      await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: member.id, role_id: await systemRoleId(roleKey) });
      const response = await app.app.inject({
        method: 'GET',
        url: `/agencies/${agencyId}/invitations`,
        headers: { ...origin, cookie: await loginCookie(member) }
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 404 for a user without access to the agency', async () => {
      const outsider = await makeUser('invitations-pending-outsider');
      const response = await app.app.inject({
        method: 'GET',
        url: `/agencies/${agencyId}/invitations`,
        headers: { ...origin, cookie: await loginCookie(outsider) }
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it('rolls back the new account when acceptance fails after the auth rows are inserted', async () => {
    const rollbackEmail = `rollback-api-${randomUUID()}@example.test`;
    const invitation = await insertInvitation({ agencyId, email: rollbackEmail });
    const failingApp = await buildTestApp({ sender: createFakeEmailSender(), config: { authPrivacyVersion: '' } });
    const userRowsBefore = await owner.knex('auth.user').where({ email: rollbackEmail }).select('id');
    expect(userRowsBefore).toEqual([]);
    const response = await failingApp.app.inject({
      method: 'POST',
      url: `/invitations/${invitation.token}/accept-new-account`,
      headers: origin,
      payload: { name: 'Rolled back', password: 'a valid rollback password', acceptTerms: true }
    });
    expect(response.statusCode).toBe(410);
    expect(response.json().error).toEqual({ code: 'INVALID_LINK', message: 'Este link não é mais válido.' });
    await failingApp.close();
    await expect(owner.knex('auth.user').where({ email: rollbackEmail }).select('id')).resolves.toEqual([]);
    await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('used_at')).resolves.toEqual({ used_at: null });
  });

  it('keeps all #32 secrets out of invitation, activation, resend, and recovery logs', async () => {
    const { logger, text } = captureLogs();
    const logSender = createFakeEmailSender();
    const logApp = await buildTestApp({ logger, sender: logSender });
    const logAdmin = await insertTestUser(logApp.pool, logApp.auth, { emailLabel: 'invitation-log-admin' });
    const logInvitee = await insertTestUser(logApp.pool, logApp.auth, { emailLabel: 'invitation-log-invitee' });
    createdUserIds.push(logAdmin.id, logInvitee.id);
    const logAgencyId = await createAgency('Invitation log agency', logAdmin.id);
    await owner.knex('agency_memberships').insert({ agency_id: logAgencyId, user_id: logAdmin.id, role_id: adminRoleId });
    const adminLogin = await logApp.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: logAdmin.email, password: logAdmin.password } });
    const adminCookie = sessionCookieHeader(adminLogin.cookies);
    const collaborator = await logApp.app.inject({
      method: 'POST',
      url: `/agencies/${logAgencyId}/invitations/collaborators`,
      headers: { ...origin, cookie: adminCookie },
      payload: { email: `log-pending-${randomUUID()}@example.test`, roleId: productionRoleId }
    });
    const collaboratorId = collaborator.json<{ invitationId: string }>().invitationId;
    const collaboratorToken = invitationTokenFromLatestEmail(logSender);
    const resent = await logApp.app.inject({
      method: 'POST',
      url: `/agencies/${logAgencyId}/invitations/${collaboratorId}/resend`,
      headers: { ...origin, cookie: adminCookie }
    });
    expect(resent.statusCode).toBe(200);
    const resentToken = logSender.sent.at(-1)?.text.match(/\/convite\/([^\s]+)/)?.[1];
    expect(resentToken).toBeDefined();

    const logClientId = randomUUID();
    createdClientIds.push(logClientId);
    await owner.knex('clients').insert({ id: logClientId, agency_id: logAgencyId, name: 'Invitation log client' });
    const clientInvite = await logApp.app.inject({
      method: 'POST',
      url: `/agencies/${logAgencyId}/clients/${logClientId}/invitations`,
      headers: { ...origin, cookie: adminCookie },
      payload: { email: logInvitee.email }
    });
    expect(clientInvite.statusCode).toBe(201);
    const clientToken = logSender.sent.at(-1)?.text.match(/\/convite\/([^\s]+)/)?.[1];
    expect(clientToken).toBeDefined();
    const forgot = await logApp.app.inject({ method: 'POST', url: '/auth/password/forgot', headers: origin, payload: { email: logInvitee.email, inviteToken: clientToken } });
    expect(forgot.statusCode).toBe(202);
    await logApp.emailService.drain();
    const resetMessage = logSender.sent.at(-1)?.text ?? '';
    const resetToken = /senha\/redefinir\?token=([^&\s]+)/.exec(resetMessage)?.[1];
    expect(resetToken).toBeDefined();
    const nextPassword = 'a secure logging reset password';
    const reset = await logApp.app.inject({
      method: 'POST', url: '/auth/password/reset', headers: origin,
      payload: { token: decodeURIComponent(resetToken!), newPassword: nextPassword, inviteToken: clientToken }
    });
    expect(reset.statusCode).toBe(200);
    const accept = await logApp.app.inject({
      method: 'POST', url: `/invitations/${clientToken}/accept`,
      headers: { ...origin, cookie: sessionCookieHeader(reset.cookies) }
    });
    expect(accept.statusCode).toBe(200);

    const activationLogAdminAgency = await createAgency('Activation log agency', null);
    const activationLog = await insertInvitation({ agencyId: activationLogAdminAgency, purpose: 'agency_activation', roleId: null, clientId: null, email: `activation-log-${randomUUID()}@example.test` });
    const activationPassword = 'a secure activation logging password';
    const activation = await logApp.app.inject({
      method: 'POST', url: `/invitations/${activationLog.token}/accept-new-account`, headers: origin,
      payload: { name: 'Activation log owner', password: activationPassword, acceptTerms: true }
    });
    expect(activation.statusCode).toBe(201);
    const activationSession = await logApp.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: sessionCookieHeader(activation.cookies) } });
    expect(activationSession.statusCode).toBe(200);
    createdUserIds.push(activationSession.json<{ user: { id: string } }>().user.id);

    // `resentToken`'s invitation is still pending at this point (only the client and activation
    // invitations above were accepted), so the pending list is exercised with a live token in play.
    const pendingList = await logApp.app.inject({
      method: 'GET',
      url: `/agencies/${logAgencyId}/invitations`,
      headers: { ...origin, cookie: adminCookie }
    });
    expect(pendingList.statusCode).toBe(200);
    const pendingListBody = JSON.stringify(pendingList.json());
    expect(pendingListBody).not.toContain(resentToken!);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const logs = text();
    expect(logs).not.toContain(collaboratorToken);
    expect(logs).not.toContain(resentToken!);
    expect(logs).not.toContain(clientToken!);
    expect(logs).not.toContain(resetToken!);
    expect(logs).not.toContain(nextPassword);
    expect(logs).not.toContain(activationPassword);
    expect(logs).not.toContain(logAdmin.email);
    expect(logs).not.toContain(logInvitee.email);
    await logApp.close();
  });
});
