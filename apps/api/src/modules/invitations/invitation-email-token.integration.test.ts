import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@ageniza/database';

import {
  buildTestApp,
  captureLogs,
  createFakeEmailSender,
  insertTestUser,
  ownerClient,
  TEST_APP_PUBLIC_URL,
  type FakeEmailSender,
  type TestApp,
  type TestUserFixture
} from '../auth/test-support/harness.js';
import { hashInvitationToken } from './tokens.js';

// Decision 2026-10-27, "o aceite pelo link do e-mail confirma o e-mail". Each collaborator invitation has
// two single-use tokens: the one in the e-mail (accepting through it proves the mailbox, so the account is
// born confirmed) and the one the inviter copies (the account is born unconfirmed, as in #722, and the
// person confirms with one click while holding that account's session). Every test builds an app of its
// own: the accept routes share a per-address rate budget with the rest of the invitation tests.
const origin = { origin: TEST_APP_PUBLIC_URL };
const chosenPassword = 'a secure password chosen at the acceptance';

let owner: DatabaseClient;
let adminRoleId = '';
let productionRoleId = '';
const agencyId = randomUUID();
const adminOwnerUserId = randomUUID();
const createdUserIds: string[] = [adminOwnerUserId];
const otherAgencyIds: string[] = [];
const openApps: TestApp[] = [];

interface World {
  readonly app: TestApp;
  readonly sender: FakeEmailSender;
  readonly logs: () => string;
  readonly admin: TestUserFixture;
  readonly adminCookie: string;
}

const cookieHeader = (cookies: readonly { name: string; value: string }[]): string =>
  cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');

const tokenOfLink = (link: string): string => {
  const token = link.match(/\/convite\/([^\s]+)/)?.[1];
  if (token === undefined) throw new Error('No invitation token in the link.');
  return token;
};

const world = async (): Promise<World> => {
  const sender = createFakeEmailSender();
  const { logger, text } = captureLogs();
  const app = await buildTestApp({ sender, logger });
  openApps.push(app);
  const admin = await insertTestUser(app.pool, app.auth, { emailLabel: 'email-token-admin' });
  createdUserIds.push(admin.id);
  await owner.knex('agency_memberships').insert({ agency_id: agencyId, user_id: admin.id, role_id: adminRoleId });
  const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: admin.email, password: admin.password } });
  expect(login.statusCode).toBe(200);
  return { app, sender, logs: text, admin, adminCookie: cookieHeader(login.cookies) };
};

interface Invited {
  readonly invitationId: string;
  readonly email: string;
  readonly emailToken: string;
  readonly copyToken: string;
  readonly createResponseBody: string;
}

/** Creates a collaborator invitation through the API: the e-mail token from the e-mail, the copy token from the answer. */
const invite = async (w: World): Promise<Invited> => {
  const email = `email-token-${randomUUID()}@example.test`;
  const created = await w.app.app.inject({
    method: 'POST', url: `/agencies/${agencyId}/invitations/collaborators`,
    headers: { ...origin, cookie: w.adminCookie }, payload: { email, roleId: productionRoleId }
  });
  expect(created.statusCode).toBe(201);
  const { invitationId, invitationUrl } = created.json<{ invitationId: string; invitationUrl: string }>();
  const mail = w.sender.sent.filter((message) => message.to === email).at(-1);
  return { invitationId, email, emailToken: tokenOfLink(mail?.text ?? ''), copyToken: tokenOfLink(invitationUrl), createResponseBody: created.body };
};

const acceptNewAccount = (w: World, token: string) =>
  w.app.app.inject({
    method: 'POST', url: `/invitations/${token}/accept-new-account`, headers: origin,
    payload: { name: 'Pessoa Convidada', password: chosenPassword, acceptTerms: true }
  });

const accountOf = async (email: string): Promise<{ id: string; emailVerified: boolean } | undefined> => {
  const row = await owner.knex('auth.user').where({ email }).first('id', 'emailVerified');
  if (row !== undefined) createdUserIds.push(row.id as string);
  return row as { id: string; emailVerified: boolean } | undefined;
};

const confirmationMessagesTo = (w: World, email: string) =>
  w.sender.sent.filter((message) => message.to === email && message.text.includes('/email/verificar'));

const confirmationTokenOf = (w: World, email: string): string => {
  const link = /\/email\/verificar\?token=([^\s"&<]+)/.exec(confirmationMessagesTo(w, email).at(-1)?.text ?? '');
  if (link?.[1] === undefined) throw new Error('No confirmation link was sent.');
  return decodeURIComponent(link[1]);
};

const verify = (w: World, token: string, options: { readonly cookie?: string; readonly password?: string } = {}) =>
  w.app.app.inject({
    method: 'POST', url: '/auth/email/verify',
    headers: { ...origin, ...(options.cookie === undefined ? {} : { cookie: options.cookie }) },
    payload: options.password === undefined ? { token } : { token, password: options.password }
  });

const login = (w: World, email: string, password = chosenPassword) =>
  w.app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email, password } });

beforeAll(async () => {
  owner = ownerClient();
  const admin = await owner.knex('roles').where({ key: 'admin' }).whereNull('agency_id').first('id');
  const production = await owner.knex('roles').where({ key: 'production' }).whereNull('agency_id').first('id');
  if (admin === undefined || production === undefined) throw new Error('System role seeds are missing.');
  adminRoleId = admin.id;
  productionRoleId = production.id;
  await owner.knex('auth.user').insert({ id: adminOwnerUserId, name: 'Dono', email: `email-token-owner-${agencyId}@example.test`, emailVerified: true });
  await owner.knex('agencies').insert({ id: agencyId, name: 'Token do e-mail', owner_user_id: adminOwnerUserId });
});

afterAll(async () => {
  await owner.knex('audit.events').where({ agency_id: agencyId }).delete();
  await owner.knex('invitations').where({ agency_id: agencyId }).delete();
  await owner.knex('agency_memberships').where({ agency_id: agencyId }).delete();
  await owner.knex('agencies').where({ id: agencyId }).update({ owner_user_id: null });
  await owner.knex('agencies').where({ id: agencyId }).delete();
  await owner.knex('agencies').whereIn('id', otherAgencyIds).update({ owner_user_id: null });
  await owner.knex('agencies').whereIn('id', otherAgencyIds).delete();
  await owner.knex('legal_acceptances').whereIn('user_id', createdUserIds).delete();
  await owner.knex('auth.user').whereIn('id', createdUserIds).delete();
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await owner.close();
});

describe('accepting through the token of the e-mail', () => {
  it('creates a confirmed account that enters at once, with no confirmation e-mail and a login that works', async () => {
    const w = await world();
    const invitation = await invite(w);
    const sentBefore = w.sender.sent.length;

    const accepted = await acceptNewAccount(w, invitation.emailToken);
    expect(accepted.statusCode).toBe(201);
    await w.app.emailService.drain();

    const account = await accountOf(invitation.email);
    expect(account?.emailVerified).toBe(true);
    expect(w.sender.sent.length).toBe(sentBefore);
    expect(await owner.knex('email_confirmations').where({ user_id: account!.id }).select('id')).toEqual([]);

    const contexts = await w.app.app.inject({ method: 'GET', url: '/me/contexts', headers: { cookie: cookieHeader(accepted.cookies) } });
    expect(contexts.statusCode).toBe(200);
    expect(contexts.body).toContain(agencyId);
    expect((await login(w, invitation.email)).statusCode).toBe(200);
  });
});

describe('accepting through the copied token', () => {
  it('creates an unconfirmed account with the session of the invitation and the confirmation e-mail, and the password login stays 401', async () => {
    const w = await world();
    const invitation = await invite(w);

    const accepted = await acceptNewAccount(w, invitation.copyToken);
    expect(accepted.statusCode).toBe(201);
    await w.app.emailService.drain();

    const account = await accountOf(invitation.email);
    expect(account?.emailVerified).toBe(false);
    expect(confirmationMessagesTo(w, invitation.email)).toHaveLength(1);
    expect(await owner.knex('email_confirmations').where({ user_id: account!.id }).select('consumed_at')).toEqual([{ consumed_at: null }]);

    // The session of the acceptance exists, and opens nothing until the e-mail is confirmed (decision 2026-10-27).
    const cookie = cookieHeader(accepted.cookies);
    const session = await w.app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ emailVerified: false });
    const contexts = await w.app.app.inject({ method: 'GET', url: '/me/contexts', headers: { cookie } });
    expect(contexts.statusCode).toBe(200);
    expect(contexts.json()).toEqual({ contexts: [], canCreateAgency: false });
    const agencyRoute = await w.app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/me`, headers: { cookie } });
    expect(agencyRoute.statusCode).toBe(403);
    expect(agencyRoute.json()).toMatchObject({ error: { code: 'EMAIL_NOT_CONFIRMED' } });

    const attempt = await login(w, invitation.email);
    expect(attempt.statusCode).toBe(401);
    expect(attempt.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
  });
});

describe('the two tokens consume one invitation', () => {
  it.each([
    ['the e-mail token first', 'emailToken', 'copyToken'],
    ['the copied token first', 'copyToken', 'emailToken']
  ] as const)('%s: the other one, and the first again, are refused with 410 and nothing else is created', async (_name, first, second) => {
    const w = await world();
    const invitation = await invite(w);

    expect((await acceptNewAccount(w, invitation[first])).statusCode).toBe(201);
    const account = await accountOf(invitation.email);
    expect(account).toBeDefined();

    for (const token of [invitation[second], invitation[first]]) {
      expect((await w.app.app.inject({ method: 'GET', url: `/invitations/${token}` })).statusCode).toBe(410);
      expect((await acceptNewAccount(w, token)).statusCode).toBe(410);
    }
    expect(await owner.knex('auth.user').where({ email: invitation.email }).select('id')).toHaveLength(1);
    expect(await owner.knex('agency_memberships').where({ agency_id: agencyId, user_id: account!.id }).select('id')).toHaveLength(1);
    expect(await owner.knex('invitations').where({ id: invitation.invitationId }).whereNotNull('used_at').select('id')).toHaveLength(1);
  });

  it('a resend gives both tokens again: neither old token opens anything, each new one does', async () => {
    const w = await world();
    const invitation = await invite(w);
    const resent = await w.app.app.inject({
      method: 'POST', url: `/agencies/${agencyId}/invitations/${invitation.invitationId}/resend`,
      headers: { ...origin, cookie: w.adminCookie }
    });
    expect(resent.statusCode).toBe(200);
    const newEmailToken = tokenOfLink(w.sender.sent.filter((message) => message.to === invitation.email).at(-1)?.text ?? '');
    const newCopyToken = tokenOfLink(resent.json<{ invitationUrl: string }>().invitationUrl);
    expect(new Set([invitation.emailToken, invitation.copyToken, newEmailToken, newCopyToken]).size).toBe(4);

    for (const stale of [invitation.emailToken, invitation.copyToken]) {
      expect((await w.app.app.inject({ method: 'GET', url: `/invitations/${stale}` })).statusCode).toBe(410);
      expect((await acceptNewAccount(w, stale)).statusCode).toBe(410);
    }
    expect(await owner.knex('auth.user').where({ email: invitation.email }).select('id')).toEqual([]);
    for (const live of [newEmailToken, newCopyToken]) {
      expect((await w.app.app.inject({ method: 'GET', url: `/invitations/${live}` })).statusCode).toBe(200);
    }
    // The new e-mail token is still an e-mail token.
    expect((await acceptNewAccount(w, newEmailToken)).statusCode).toBe(201);
    expect((await accountOf(invitation.email))?.emailVerified).toBe(true);
  });
});

describe('the token of the e-mail leaves the database only inside the e-mail', () => {
  it('appears in no response, list, log or audit event, nor does its hash', async () => {
    const w = await world();
    const invitation = await invite(w);
    const emailHash = hashInvitationToken(invitation.emailToken);
    const everythingTheApiSaid: string[] = [invitation.createResponseBody];

    const list = await w.app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/invitations?pageSize=100`, headers: { ...origin, cookie: w.adminCookie } });
    expect(list.statusCode).toBe(200);
    everythingTheApiSaid.push(list.body);
    const preview = await w.app.app.inject({ method: 'GET', url: `/invitations/${invitation.emailToken}` });
    expect(preview.statusCode).toBe(200);
    everythingTheApiSaid.push(preview.body);

    const resent = await w.app.app.inject({
      method: 'POST', url: `/agencies/${agencyId}/invitations/${invitation.invitationId}/resend`,
      headers: { ...origin, cookie: w.adminCookie }
    });
    expect(resent.statusCode).toBe(200);
    const resentEmailToken = tokenOfLink(w.sender.sent.filter((message) => message.to === invitation.email).at(-1)?.text ?? '');
    everythingTheApiSaid.push(resent.body);

    const accepted = await acceptNewAccount(w, resentEmailToken);
    expect(accepted.statusCode).toBe(201);
    everythingTheApiSaid.push(accepted.body);
    const session = await w.app.app.inject({ method: 'GET', url: '/auth/session', headers: { cookie: cookieHeader(accepted.cookies) } });
    everythingTheApiSaid.push(session.body);
    const contexts = await w.app.app.inject({ method: 'GET', url: '/me/contexts', headers: { cookie: cookieHeader(accepted.cookies) } });
    everythingTheApiSaid.push(contexts.body);
    await accountOf(invitation.email);

    await w.app.emailService.drain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const audit = JSON.stringify(await owner.knex('audit.events').where({ agency_id: agencyId }).select('*'));
    const resentHash = hashInvitationToken(resentEmailToken);
    const secrets = [invitation.emailToken, emailHash, resentEmailToken, resentHash];
    for (const place of [...everythingTheApiSaid, w.logs(), audit]) {
      for (const secret of secrets) expect(place).not.toContain(secret);
    }
    // The e-mail token is not the copy token either, so neither response hands it over by another name.
    expect(invitation.emailToken).not.toBe(invitation.copyToken);
    expect(list.body).not.toContain('/convite/');
  });
});

describe('/auth/email/verify with no password', () => {
  const copiedAccount = async (w: World) => {
    const invitation = await invite(w);
    const accepted = await acceptNewAccount(w, invitation.copyToken);
    expect(accepted.statusCode).toBe(201);
    await w.app.emailService.drain();
    const account = await accountOf(invitation.email);
    return {
      email: invitation.email,
      userId: account!.id,
      cookie: cookieHeader(accepted.cookies),
      link: confirmationTokenOf(w, invitation.email)
    };
  };

  const stillUnconfirmed = async (userId: string, link: string): Promise<void> => {
    expect((await owner.knex('auth.user').where({ id: userId }).first('emailVerified'))?.emailVerified).toBe(false);
    expect((await owner.knex('email_confirmations').where({ user_id: userId }).first('consumed_at'))?.consumed_at).toBeNull();
    expect(link).toMatch(/^[A-Za-z0-9_-]{43}$/);
  };

  it('confirms with one click when the request carries the session of the account the link belongs to', async () => {
    const w = await world();
    const mine = await copiedAccount(w);

    const confirmed = await verify(w, mine.link, { cookie: mine.cookie });
    expect(confirmed.statusCode).toBe(200);
    expect((await owner.knex('auth.user').where({ id: mine.userId }).first('emailVerified'))?.emailVerified).toBe(true);
    expect((await owner.knex('email_confirmations').where({ user_id: mine.userId }).first('consumed_at'))?.consumed_at).not.toBeNull();
    // The session it had keeps working, now opens the agency of the invitation, and the password login is open too.
    expect((await w.app.app.inject({ method: 'GET', url: `/agencies/${agencyId}/me`, headers: { cookie: mine.cookie } })).statusCode).toBe(200);
    expect((await w.app.app.inject({ method: 'GET', url: '/me/contexts', headers: { cookie: mine.cookie } })).body).toContain(agencyId);
    expect((await login(w, mine.email)).statusCode).toBe(200);
    // The link is spent: the same click again is refused like any dead link.
    const again = await verify(w, mine.link, { cookie: mine.cookie });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: { code: 'INVALID_LINK_OR_PASSWORD' } });
  });

  it('refuses it with no session at all, answering as a wrong password does, and leaves the link alive', async () => {
    const w = await world();
    const mine = await copiedAccount(w);

    const refused = await verify(w, mine.link);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: 'INVALID_LINK_OR_PASSWORD' } });
    expect(refused.cookies).toEqual([]);
    await stillUnconfirmed(mine.userId, mine.link);
    // The link still works with the password.
    expect((await verify(w, mine.link, { password: chosenPassword })).statusCode).toBe(200);
  });

  it('refuses it with the session of another confirmed account', async () => {
    const w = await world();
    const mine = await copiedAccount(w);
    const other = await insertTestUser(w.app.pool, w.app.auth, { emailLabel: 'email-token-other' });
    createdUserIds.push(other.id);
    // A confirmed account needs a context of its own to sign in (#68).
    const otherAgencyId = randomUUID();
    otherAgencyIds.push(otherAgencyId);
    await owner.knex('agencies').insert({ id: otherAgencyId, name: 'Casa do outro', owner_user_id: other.id });
    const otherLogin = await login(w, other.email, other.password);
    expect(otherLogin.statusCode).toBe(200);

    const refused = await verify(w, mine.link, { cookie: cookieHeader(otherLogin.cookies) });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: 'INVALID_LINK_OR_PASSWORD' } });
    await stillUnconfirmed(mine.userId, mine.link);
  });

  it('refuses it with the session of another unconfirmed invited account, and each link still belongs to its own account', async () => {
    const w = await world();
    const mine = await copiedAccount(w);
    const theirs = await copiedAccount(w);

    const crossed = await verify(w, mine.link, { cookie: theirs.cookie });
    expect(crossed.statusCode).toBe(400);
    expect(crossed.json()).toMatchObject({ error: { code: 'INVALID_LINK_OR_PASSWORD' } });
    await stillUnconfirmed(mine.userId, mine.link);
    await stillUnconfirmed(theirs.userId, theirs.link);

    expect((await verify(w, theirs.link, { cookie: theirs.cookie })).statusCode).toBe(200);
    await stillUnconfirmed(mine.userId, mine.link);
  });

  it('refuses it once the account has lost the context the invitation gave it, since that session no longer stands', async () => {
    const w = await world();
    const mine = await copiedAccount(w);
    await owner.knex('agency_memberships').where({ agency_id: agencyId, user_id: mine.userId }).update({ status: 'removed' });

    const refused = await verify(w, mine.link, { cookie: mine.cookie });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: 'INVALID_LINK_OR_PASSWORD' } });
    await stillUnconfirmed(mine.userId, mine.link);
  });

  it('refuses a made-up link with a real session, the same way', async () => {
    const w = await world();
    const mine = await copiedAccount(w);

    const refused = await verify(w, 'x'.repeat(43), { cookie: mine.cookie });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: 'INVALID_LINK_OR_PASSWORD' } });
    await stillUnconfirmed(mine.userId, mine.link);
  });
});
