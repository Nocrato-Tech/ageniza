import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildTestApp,
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
let productionRoleId: string;

const sessionCookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

describe('invitation HTTP module', () => {
  beforeAll(async () => {
    owner = ownerClient();
    sender = createFakeEmailSender();
    app = await buildTestApp({ sender });
    admin = await insertTestUser(app.pool, app.auth, { emailLabel: 'invitation-admin' });
    invitee = await insertTestUser(app.pool, app.auth, { emailLabel: 'invitation-invitee' });

    const adminRole = await owner.knex('roles').where({ key: 'admin' }).whereNull('agency_id').first('id');
    const productionRole = await owner.knex('roles').where({ key: 'production' }).whereNull('agency_id').first('id');
    if (adminRole === undefined) throw new Error('Admin role seed is missing.');
    if (productionRole === undefined) throw new Error('Production role seed is missing.');
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
    await owner.knex('audit.events').where({ agency_id: agencyId }).delete();
    await owner.knex('audit.events').where({ agency_id: activationAgencyId }).delete();
    await owner.knex('invitations').where({ agency_id: agencyId }).delete();
    await owner.knex('invitations').where({ agency_id: activationAgencyId }).delete();
    await owner.knex('client_memberships').where({ client_id: clientId }).delete();
    await owner.knex('clients').where({ id: clientId }).delete();
    await owner.knex('agency_memberships').where({ agency_id: agencyId }).delete();
    await owner.knex('agency_memberships').where({ agency_id: activationAgencyId }).delete();
    await owner.knex('agencies').where({ id: agencyId }).delete();
    await owner.knex('agencies').where({ id: activationAgencyId }).update({ owner_user_id: null });
    await owner.knex('agencies').where({ id: activationAgencyId }).delete();
    if (activationUserId !== undefined) await owner.knex('legal_acceptances').where({ user_id: activationUserId }).delete();
    await app.pool.query('delete from auth."user" where id = any($1::uuid[])', [[admin.id, invitee.id]]);
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
    const link = sender.sent[0]?.text.match(/\/invite\/([^\s]+)/)?.[1];
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
    const inviteToken = sender.sent.at(-1)?.text.match(/\/invite\/([^\s]+)/)?.[1];
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
    const resetToken = /reset-password\?token=([^&\s]+)/.exec(resetMessage)?.[1];
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
    const oldToken = sender.sent.at(-1)?.text.match(/\/invite\/([^\s]+)/)?.[1];
    expect(oldToken).toBeDefined();

    const resent = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/${invitationId}/resend`,
      headers: { ...origin, cookie: adminCookie }
    });
    expect(resent.statusCode).toBe(200);
    const newInvitationId = resent.json<{ invitationId: string }>().invitationId;
    const newToken = sender.sent.at(-1)?.text.match(/\/invite\/([^\s]+)/)?.[1];
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
});
