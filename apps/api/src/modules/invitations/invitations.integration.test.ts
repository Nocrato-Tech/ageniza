import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { raw, type DatabaseClient } from '@ageniza/database';
import { randomUUID } from 'node:crypto';

const origin = { origin: TEST_APP_PUBLIC_URL };

type Injection = Awaited<ReturnType<TestApp['app']['inject']>>;
type Transaction = Parameters<Parameters<DatabaseClient['transaction']>[0]>[0];

/** Every raw statement the API sends through the harness's application-role client (issue #304). */
const recordedStatements: string[] = [];

/**
 * Wraps the harness database so each `raw` the modules send is recorded first; the listing test
 * proves the counter and the page are one statement this way (issue #304).
 */
const recordStatements = (database: DatabaseClient): DatabaseClient => {
  const recordingTransaction = (transaction: Transaction): Transaction => new Proxy(transaction, {
    get(target, property, receiver) {
      if (property === 'raw') {
        return (statement: string, bindings?: Parameters<Transaction['raw']>[1]) => {
          recordedStatements.push(statement);
          return target.raw(statement, bindings ?? []);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return (work: (transaction: Transaction) => Promise<unknown>) =>
          target.transaction((transaction) => work(recordingTransaction(transaction)));
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  });
};

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
  readonly createdAt?: Date;
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
    revoked_at: input.revokedAt ?? null,
    ...(input.createdAt === undefined ? {} : { created_at: input.createdAt })
  });
  return { invitationId, token: token.token };
};

const invitationTokenFromLatestEmail = (emailSender = sender): string => {
  const text = emailSender.sent.at(-1)?.text ?? '';
  const token = text.match(/\/convite\/([^\s]+)/)?.[1];
  if (token === undefined) throw new Error('The invitation email did not contain a token.');
  return token;
};

/** Waits until some backend is blocked waiting for a relation lock, so a race is sequenced by the
 * lock, not by a sleep. Used by the listing test that pins the count and the page to one snapshot. */
const waitForRelationLockWait = async (database: DatabaseClient, relation: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await raw<{ rows: Array<{ waiting: number }> }>(database.knex, `
      select count(*)::int as waiting
      from pg_catalog.pg_locks locks
      join pg_catalog.pg_class relation on relation.oid = locks.relation
      where relation.relname = ? and not locks.granted
    `, [relation]);
    if ((result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No backend ever waited on the ${relation} lock.`);
};

/** The backend pid of an open transaction, to scope a lock wait to this test's holder. */
const backendPid = async (transaction: Transaction): Promise<number> => {
  const result = await raw<{ rows: Array<{ pid: number }> }>(transaction, 'select pg_catalog.pg_backend_pid() as pid', []);
  return Number(result.rows[0]?.pid);
};

/**
 * Waits until a backend of this database is blocked by the given holder and returns the
 * `query_start` of the statement it blocks in -- the lock itself, never a sleep, and blind to
 * waits in other databases (issue #304 review).
 */
const waitForBlockedQueryStart = async (database: DatabaseClient, holderPid: number): Promise<Date> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await raw<{ rows: Array<{ query_start: string | Date }> }>(database.knex, `
      select activity.query_start
      from pg_catalog.pg_stat_activity activity
      join pg_catalog.pg_locks locks on locks.pid = activity.pid and not locks.granted
      where activity.datname = pg_catalog.current_database()
        and pg_catalog.pg_blocking_pids(activity.pid) @> array[?::int]
      limit 1
    `, [holderPid]);
    const row = result.rows[0];
    if (row !== undefined) return new Date(row.query_start);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('No backend ever waited on the holder lock.');
};

/** Waits until the database clock passes the invitation's expiry, reading the row without locking
 * it (the request may hold it) and never trusting the Node clock (issue #304). */
const waitUntilInvitationExpires = async (database: DatabaseClient, invitationId: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await raw<{ rows: Array<{ expired: boolean }> }>(database.knex, `
      select expires_at <= pg_catalog.now() as expired
      from public.invitations
      where id = ?::uuid
    `, [invitationId]);
    if (result.rows[0]?.expired === true) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('The invitation never expired.');
};

/** Holds the invitation row, starts the request so it blocks on `for update`, expires the
 * invitation one millisecond after the blocked statement started and releases it: the request's
 * transaction clock always sees it pending, its post-lock read always sees it expired (issue #304).
 */
const expireInvitationWhileRequestWaits = async (invitationId: string, start: () => Promise<Injection>): Promise<Injection> => {
  const holder = await owner.knex.transaction();
  let released = false;
  try {
    const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.invitations where id = ?::uuid for update', [invitationId]);
    if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one invitation.');
    const holderPid = await backendPid(holder);
    const responsePromise = start();
    const queryStart = await waitForBlockedQueryStart(owner, holderPid);
    const expired = await raw<{ rows: Array<{ id: string }> }>(holder, `
      update public.invitations
      set expires_at = ?::timestamptz + interval '1 millisecond'
      where id = ?::uuid
      returning id
    `, [queryStart, invitationId]);
    if (expired.rows.length !== 1) throw new Error('The holder did not expire exactly one invitation.');
    // Let the wall clock pass the expiry before releasing, so the post-lock read is past it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await holder.commit();
    released = true;
    return await responsePromise;
  } finally {
    if (!released) await holder.rollback();
  }
};

describe('invitation HTTP module', () => {
  beforeAll(async () => {
    owner = ownerClient();
    sender = createFakeEmailSender();
    app = await buildTestApp({ sender, wrapDatabase: recordStatements });
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
    // Issue #68: logging invitee in below (to then accept the invitation as an existing account)
    // requires at least one context of their own, unrelated to the invite being accepted.
    await createAgency('Invitee Home Agency', invitee.id);
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

  it('creates the account with the invitation email, already verified, for every invitation purpose', async () => {
    const activationAgency = await createAgency('Verified email activation agency', null);
    const cases = [
      { purpose: 'agency_activation' as const, agencyId: activationAgency, roleId: null, clientId: null },
      { purpose: 'collaborator_invite' as const, agencyId, roleId: productionRoleId, clientId: null },
      { purpose: 'client_invite' as const, agencyId, roleId: null, clientId }
    ];
    for (const item of cases) {
      const email = `verified-${item.purpose}-${randomUUID()}@example.test`;
      const invitation = await insertInvitation({ ...item, email });
      const response = await app.app.inject({
        method: 'POST',
        url: `/invitations/${invitation.token}/accept-new-account`,
        headers: origin,
        payload: { name: 'Verified Invitee', password: 'a secure activation password', acceptTerms: true }
      });
      expect(response.statusCode, item.purpose).toBe(201);
      const created = await owner.knex('auth.user').where({ email }).select('id', 'email', 'emailVerified');
      expect(created, item.purpose).toHaveLength(1);
      expect(created[0]).toMatchObject({ email, emailVerified: true });
      createdUserIds.push(created[0]!.id as string);
    }
  });

  it('rejects an email in the accept-new-account body with 400 and writes nothing', async () => {
    const agency = await createAgency('Foreign email activation agency', null);
    const email = `invited-${randomUUID()}@example.test`;
    const foreignEmail = `foreign-${randomUUID()}@example.test`;
    const invitation = await insertInvitation({ agencyId: agency, purpose: 'agency_activation', roleId: null, clientId: null, email });

    const rejected = await app.app.inject({
      method: 'POST',
      url: `/invitations/${invitation.token}/accept-new-account`,
      headers: origin,
      payload: { name: 'Foreign Email', email: foreignEmail, password: 'a secure activation password', acceptTerms: true }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    await expect(owner.knex('auth.user').whereIn('email', [email, foreignEmail]).count({ count: '*' }).first()).resolves.toMatchObject({ count: '0' });
    await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('used_at')).resolves.toEqual({ used_at: null });
    await expect(owner.knex('agencies').where({ id: agency }).first('owner_user_id')).resolves.toEqual({ owner_user_id: null });

    const recovered = await app.app.inject({
      method: 'POST',
      url: `/invitations/${invitation.token}/accept-new-account`,
      headers: origin,
      payload: { name: 'Foreign Email', password: 'a secure activation password', acceptTerms: true }
    });
    expect(recovered.statusCode).toBe(201);
    const users = await owner.knex('auth.user').whereIn('email', [email, foreignEmail]).select('id', 'email');
    expect(users.map((row) => row.email)).toEqual([email]);
    createdUserIds.push(users[0]!.id as string);
  });

  it('validates the invited name on accept-new-account: hostile names are 400 without an error log, international names succeed', async () => {
    const logs = captureLogs();
    const logSender = createFakeEmailSender();
    const logApp = await buildTestApp({ logger: logs.logger, sender: logSender });
    try {
      const hostileAgency = await createAgency('Invitation name hostile agency', null);
      const hostileEmail = `hostile-name-${randomUUID()}@example.test`;
      const hostile = await insertInvitation({ agencyId: hostileAgency, purpose: 'agency_activation', roleId: null, clientId: null, email: hostileEmail });
      const logOffset = logs.lines().length;

      const hostileNames = ['Ana\u0000Bia', 'Ana\u0007Bia', '\u001b[31mAna', 'Ana\u007fBia', 'Ana\u202eBia', '\u200b', '\u3164', '\u200c', '\u200d'];
      for (const name of hostileNames) {
        const response = await logApp.app.inject({
          method: 'POST',
          url: `/invitations/${hostile.token}/accept-new-account`,
          headers: origin,
          payload: { name, password: 'a secure activation password', acceptTerms: true }
        });
        expect(response.statusCode, `name ${JSON.stringify(name)}`).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      }

      // Validation failed before the token was consumed, so the invitation still works.
      const recovered = await logApp.app.inject({
        method: 'POST',
        url: `/invitations/${hostile.token}/accept-new-account`,
        headers: origin,
        payload: { name: 'Recovered Name', password: 'a secure activation password', acceptTerms: true }
      });
      expect(recovered.statusCode).toBe(201);
      createdUserIds.push((await owner.knex('auth.user').where({ email: hostileEmail }).first('id'))!.id as string);

      // Legitimate names in other scripts -- including a Persian name with a real ZWNJ between
      // letters, a Devanagari conjunct (virama + ZWJ) and an emoji family between letters -- are
      // accepted and stored exactly as sent.
      const legitimateNames = ['José da Silva', '李雷', 'علي بن أبي طالب', 'Zoë', 'می\u200Cرود', 'क\u094D\u200Dष', 'A\uD83D\uDC68\u200D\uD83D\uDC69B'];
      for (const name of legitimateNames) {
        const agency = await createAgency('Invitation name legit agency', null);
        const email = `legit-name-${randomUUID()}@example.test`;
        const invitation = await insertInvitation({ agencyId: agency, purpose: 'agency_activation', roleId: null, clientId: null, email });
        const response = await logApp.app.inject({
          method: 'POST',
          url: `/invitations/${invitation.token}/accept-new-account`,
          headers: origin,
          payload: { name, password: 'a secure activation password', acceptTerms: true }
        });
        expect(response.statusCode, `name ${JSON.stringify(name)}`).toBe(201);
        const row = await owner.knex('auth.user').where({ email }).first('id', 'name');
        expect(row?.name).toBe(name);
        createdUserIds.push(row!.id as string);
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
      const requestLogs = logs.lines().slice(logOffset).join('\n');
      expect(requestLogs).not.toContain('"level":50');
      expect(requestLogs).not.toContain('Request failed unexpectedly');
    } finally {
      await logApp.close();
    }
  }, 20_000);

  it('rejects a non-empty body on accept with 400 and changes nothing', async () => {
    // The existing-account accept (`POST /invitations/:token/accept`) takes no name: the person
    // already has one. The route schema is a body-less request, so an unexpected body is a 400 --
    // and the name already stored must not change, nor the invitation be consumed.
    const existing = await makeUser('invitation-name-existing');
    const homeAgency = await createAgency('Invitation name existing home', existing.id);
    expect(homeAgency).toBeDefined();
    const before = await owner.knex('auth.user').where({ id: existing.id }).first('name');
    const invitation = await insertInvitation({ agencyId, email: existing.email, roleId: productionRoleId });
    const login = await app.app.inject({ method: 'POST', url: '/auth/login', headers: origin, payload: { email: existing.email, password: existing.password } });
    const cookie = sessionCookieHeader(login.cookies);

    const rejected = await app.app.inject({
      method: 'POST',
      url: `/invitations/${invitation.token}/accept`,
      headers: { ...origin, cookie },
      payload: { name: 'Ana\u0000Bia' }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const after = await owner.knex('auth.user').where({ id: existing.id }).first('name');
    expect(after?.name).toBe(before?.name);
    const pending = await owner.knex('invitations').where({ id: invitation.invitationId }).first('used_at');
    expect(pending?.used_at).toBeNull();

    // The body-less accept, which is the real contract, still works.
    const accepted = await app.app.inject({ method: 'POST', url: `/invitations/${invitation.token}/accept`, headers: { ...origin, cookie } });
    expect(accepted.statusCode).toBe(200);
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

  it('decides "still pending" with the database clock, not the application clock', async () => {
    const clockOwner = await makeUser('invitations-clock-owner');
    const clockAgencyId = await createAgency('Invitations clock agency', clockOwner.id);
    const cookie = await loginCookie(clockOwner);
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const resendable = await insertInvitation({ agencyId: clockAgencyId, email: `clock-resend-${randomUUID()}@example.test`, expiresAt });
    const cancelable = await insertInvitation({ agencyId: clockAgencyId, email: `clock-cancel-${randomUUID()}@example.test`, expiresAt });

    // The application clock jumps past `expires_at` while the database clock stays put. The
    // listing and `app_private.accept_invitation` already decide this by the server clock, so
    // resend and cancel must too: the database still sees both invitations as pending (issue #165).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 20 * 60_000));
    try {
      const resent = await app.app.inject({
        method: 'POST',
        url: `/agencies/${clockAgencyId}/invitations/${resendable.invitationId}/resend`,
        headers: { ...origin, cookie }
      });
      expect(resent.statusCode).toBe(200);

      const cancelled = await app.app.inject({
        method: 'DELETE',
        url: `/agencies/${clockAgencyId}/invitations/${cancelable.invitationId}`,
        headers: { ...origin, cookie }
      });
      expect(cancelled.statusCode).toBe(204);
    } finally {
      vi.useRealTimers();
    }

    const revoked = await owner.knex('invitations').where({ id: cancelable.invitationId }).first('revoked_at');
    expect(revoked?.revoked_at).not.toBeNull();
  });

  it('refuses to cancel an invitation that expired while the request waited for its row lock (issue #304)', async () => {
    const expiryOwner = await makeUser('invitations-expiry-cancel-owner');
    const expiryAgencyId = await createAgency('Invitations expiry cancel agency', expiryOwner.id);
    const cookie = await loginCookie(expiryOwner);
    const invitation = await insertInvitation({ agencyId: expiryAgencyId, email: `expiry-cancel-${randomUUID()}@example.test` });

    const response = await expireInvitationWhileRequestWaits(invitation.invitationId, () => app.app.inject({
      method: 'DELETE',
      url: `/agencies/${expiryAgencyId}/invitations/${invitation.invitationId}`,
      headers: { ...origin, cookie }
    }));

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INVITATION_NOT_PENDING' } });
    await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('revoked_at')).resolves.toEqual({ revoked_at: null });
  }, 20_000);

  it('refuses to resend an invitation that expired while the request waited for its row lock (issue #304)', async () => {
    const expiryOwner = await makeUser('invitations-expiry-resend-owner');
    const expiryAgencyId = await createAgency('Invitations expiry resend agency', expiryOwner.id);
    const cookie = await loginCookie(expiryOwner);
    const invitation = await insertInvitation({ agencyId: expiryAgencyId, email: `expiry-resend-${randomUUID()}@example.test` });

    const response = await expireInvitationWhileRequestWaits(invitation.invitationId, () => app.app.inject({
      method: 'POST',
      url: `/agencies/${expiryAgencyId}/invitations/${invitation.invitationId}/resend`,
      headers: { ...origin, cookie }
    }));

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'INVITATION_NOT_PENDING' } });
    // The expired invitation is not revoked and no replacement is created.
    const rows = await owner.knex('invitations').where({ agency_id: expiryAgencyId }).select('id', 'revoked_at');
    expect(rows).toEqual([{ id: invitation.invitationId, revoked_at: null }]);
  }, 20_000);

  it('refuses to resend an invitation that expired while the request waited for the invitation slot (issue #304 review)', async () => {
    const slotOwner = await makeUser('invitations-expiry-slot-owner');
    const slotAgencyId = await createAgency('Invitations expiry slot agency', slotOwner.id);
    const cookie = await loginCookie(slotOwner);
    const email = `expiry-slot-${randomUUID()}@example.test`;
    const invitation = await insertInvitation({ agencyId: slotAgencyId, email });
    await owner.knex('invitations').where({ id: invitation.invitationId }).update({ expires_at: owner.knex.raw("pg_catalog.now() + interval '4 seconds'") });

    const holder = await owner.knex.transaction();
    let released = false;
    try {
      // The exact advisory key `lockPendingInvitationSlot` takes (clientId null -> nil uuid).
      await holder.raw('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))', [
        `${slotAgencyId}:collaborator_invite:${email}:00000000-0000-0000-0000-000000000000`
      ]);
      const holderPid = await backendPid(holder);
      const responsePromise = app.app.inject({
        method: 'POST',
        url: `/agencies/${slotAgencyId}/invitations/${invitation.invitationId}/resend`,
        headers: { ...origin, cookie }
      });
      await waitForBlockedQueryStart(owner, holderPid);
      await waitUntilInvitationExpires(owner, invitation.invitationId);
      await holder.commit();
      released = true;

      const response = await responsePromise;
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'INVITATION_NOT_PENDING' } });
      const rows = await owner.knex('invitations').where({ agency_id: slotAgencyId }).select('id', 'revoked_at');
      expect(rows).toEqual([{ id: invitation.invitationId, revoked_at: null }]);
    } finally {
      if (!released) await holder.rollback();
    }
  }, 20_000);

  it('rejects an acceptance whose invitation expired while the request waited for its row lock (issue #304)', async () => {
    const expiryOwner = await makeUser('invitations-expiry-accept-owner');
    const expiryAgencyId = await createAgency('Invitations expiry accept agency', expiryOwner.id);
    const invited = await makeUser('invitations-expiry-accept-invitee');
    // Issue #68: logging in requires a context of their own, unrelated to the invitation.
    await createAgency('Invitations expiry invitee home agency', invited.id);
    const cookie = await loginCookie(invited);
    const invitation = await insertInvitation({ agencyId: expiryAgencyId, email: invited.email });

    const response = await expireInvitationWhileRequestWaits(invitation.invitationId, () => app.app.inject({
      method: 'POST',
      url: `/invitations/${invitation.token}/accept`,
      headers: { ...origin, cookie }
    }));

    expect(response.statusCode).toBe(410);
    expect(response.json().error).toEqual({ code: 'INVALID_LINK', message: 'Este link não é mais válido.' });
    await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('used_at')).resolves.toEqual({ used_at: null });
  }, 20_000);

  it('rejects an acceptance whose invitation expired while the request waited for the agency lock (issue #304 review)', async () => {
    const agencyLockOwner = await makeUser('invitations-expiry-agency-owner');
    const agencyLockAgencyId = await createAgency('Invitations expiry agency lock agency', agencyLockOwner.id);
    const invited = await makeUser('invitations-expiry-agency-invitee');
    // Issue #68: logging in requires a context of their own, unrelated to the invitation.
    await createAgency('Invitations expiry agency invitee home agency', invited.id);
    const cookie = await loginCookie(invited);
    const invitation = await insertInvitation({ agencyId: agencyLockAgencyId, email: invited.email });
    await owner.knex('invitations').where({ id: invitation.invitationId }).update({ expires_at: owner.knex.raw("pg_catalog.now() + interval '4 seconds'") });

    const holder = await owner.knex.transaction();
    let released = false;
    try {
      const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.agencies where id = ?::uuid for update', [agencyLockAgencyId]);
      if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one agency.');
      const holderPid = await backendPid(holder);
      const responsePromise = app.app.inject({
        method: 'POST',
        url: `/invitations/${invitation.token}/accept`,
        headers: { ...origin, cookie }
      });
      await waitForBlockedQueryStart(owner, holderPid);
      await waitUntilInvitationExpires(owner, invitation.invitationId);
      await holder.commit();
      released = true;

      const response = await responsePromise;
      expect(response.statusCode).toBe(410);
      expect(response.json().error).toEqual({ code: 'INVALID_LINK', message: 'Este link não é mais válido.' });
      await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('used_at')).resolves.toEqual({ used_at: null });
    } finally {
      if (!released) await holder.rollback();
    }
  }, 20_000);

  // Issue #335: creation and resend must take the slot before the row; the opposite order deadlocks.
  describe('lock order between creating and resending (issue #335)', () => {
    const LOCK_ORDER_IP = '127.0.0.4';
    const loginFromLockOrderIp = async (user: TestUserFixture): Promise<string> => {
      const login = await app.app.inject({
        method: 'POST',
        url: '/auth/login',
        remoteAddress: LOCK_ORDER_IP,
        headers: origin,
        payload: { email: user.email, password: user.password }
      });
      expect(login.statusCode).toBe(200);
      return sessionCookieHeader(login.cookies);
    };
    /** The pid of one backend currently blocked by the given database backend, in this database. */
    const backendBlockedBy = async (blockerPid: number): Promise<number | undefined> => {
      const result = await raw<{ rows: Array<{ pid: number }> }>(owner.knex, `
        select activity.pid
        from pg_catalog.pg_stat_activity activity
        where activity.datname = pg_catalog.current_database()
          and pg_catalog.pg_blocking_pids(activity.pid) @> array[?::int]
        limit 1
      `, [blockerPid]);
      return result.rows[0]?.pid;
    };
    /** Waits until a backend is blocked by the given backend, so the race is sequenced by locks. */
    const waitForBackendBlockedBy = async (blockerPid: number): Promise<number> => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const pid = await backendBlockedBy(blockerPid);
        if (pid !== undefined) return pid;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`No backend ever waited on a lock held by ${blockerPid}.`);
    };

    it('serializes a create and a resend of the same recipient instead of deadlocking', async () => {
      const raceOwner = await makeUser('invitations-lock-order-owner');
      const raceAgencyId = await createAgency('Invitations lock order agency', raceOwner.id);
      const cookie = await loginFromLockOrderIp(raceOwner);
      const email = `lock-order-${randomUUID()}@example.test`;
      const invitation = await insertInvitation({ agencyId: raceAgencyId, email });

      const holder = await owner.knex.transaction();
      let released = false;
      try {
        const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.invitations where id = ?::uuid for update', [invitation.invitationId]);
        if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one invitation.');
        const holderPid = await backendPid(holder);

        // The resend takes the slot and lines up on the row; the create then waits on the slot the
        // resend holds (the same order); only that wait releases the holder.
        const resent = app.app.inject({
          method: 'POST',
          url: `/agencies/${raceAgencyId}/invitations/${invitation.invitationId}/resend`,
          remoteAddress: LOCK_ORDER_IP,
          headers: { ...origin, cookie }
        });
        const resendPid = await waitForBackendBlockedBy(holderPid);
        const created = app.app.inject({
          method: 'POST',
          url: `/agencies/${raceAgencyId}/invitations/collaborators`,
          remoteAddress: LOCK_ORDER_IP,
          headers: { ...origin, cookie },
          payload: { email, roleId: productionRoleId }
        });
        await waitForBackendBlockedBy(resendPid);
        await holder.commit();
        released = true;

        const [resendResponse, createResponse] = await Promise.all([resent, created]);
        expect(resendResponse.statusCode).toBe(200);
        expect(createResponse.statusCode).toBe(201);
        expect(JSON.stringify([resendResponse.json(), createResponse.json()])).not.toMatch(/deadlock|40P01|pg_|relation|process/i);
        // The resend replaced the holder's invitation and the create replaced the resend's: one
        // pending invitation for the e-mail remains.
        const rows = await owner.knex('invitations').where({ agency_id: raceAgencyId, email }).select('id', 'revoked_at');
        expect(rows).toHaveLength(3);
        expect(rows.filter((row) => row.revoked_at === null)).toHaveLength(1);
      } finally {
        if (!released) await holder.rollback();
      }
    }, 20_000);

    it('answers 409 TRY_AGAIN, with no database detail and nothing changed, when a resend loses a deadlock', async () => {
      const raceOwner = await makeUser('invitations-deadlock-owner');
      const raceAgencyId = await createAgency('Invitations deadlock agency', raceOwner.id);
      const cookie = await loginFromLockOrderIp(raceOwner);
      const email = `deadlock-${randomUUID()}@example.test`;
      const invitation = await insertInvitation({ agencyId: raceAgencyId, email });

      const holder = await owner.knex.transaction();
      let released = false;
      try {
        // Hold the row, start the resend so it takes the slot and waits on the row, then ask for the
        // same slot from the holder: the two wait on each other and the resend, waiting first, loses.
        const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.invitations where id = ?::uuid for update', [invitation.invitationId]);
        if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one invitation.');
        const holderPid = await backendPid(holder);
        const resent = app.app.inject({
          method: 'POST',
          url: `/agencies/${raceAgencyId}/invitations/${invitation.invitationId}/resend`,
          remoteAddress: LOCK_ORDER_IP,
          headers: { ...origin, cookie }
        });
        await waitForBlockedQueryStart(owner, holderPid);
        // The exact advisory key `lockPendingInvitationSlot` takes (clientId null -> nil uuid).
        await holder.raw('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))', [
          `${raceAgencyId}:collaborator_invite:${email}:00000000-0000-0000-0000-000000000000`
        ]);
        await holder.commit();
        released = true;

        const response = await resent;
        expect(response.statusCode).toBe(409);
        expect(response.json().error?.code).toBe('TRY_AGAIN');
        expect(JSON.stringify(response.json())).not.toMatch(/deadlock|40P01|pg_|relation|process/i);
        await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('revoked_at')).resolves.toEqual({ revoked_at: null });
        await expect(owner.knex('invitations').where({ agency_id: raceAgencyId }).select('id')).resolves.toHaveLength(1);

        // Repeating the call after the lost race works.
        const retried = await app.app.inject({
          method: 'POST',
          url: `/agencies/${raceAgencyId}/invitations/${invitation.invitationId}/resend`,
          remoteAddress: LOCK_ORDER_IP,
          headers: { ...origin, cookie }
        });
        expect(retried.statusCode).toBe(200);
      } finally {
        if (!released) await holder.rollback();
      }
    }, 20_000);

    it('answers 409 TRY_AGAIN when a creation loses a deadlock, and changes nothing', async () => {
      const raceOwner = await makeUser('invitations-deadlock-create-owner');
      const raceAgencyId = await createAgency('Invitations deadlock create agency', raceOwner.id);
      const cookie = await loginFromLockOrderIp(raceOwner);
      const email = `deadlock-create-${randomUUID()}@example.test`;
      const invitation = await insertInvitation({ agencyId: raceAgencyId, email });

      const holder = await owner.knex.transaction();
      let released = false;
      try {
        // Same cycle as the resend case, with the creation waiting on the row first: it takes the
        // slot, blocks on the revoke, and the holder closes the cycle by asking for the slot.
        const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.invitations where id = ?::uuid for update', [invitation.invitationId]);
        if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one invitation.');
        const holderPid = await backendPid(holder);
        const created = app.app.inject({
          method: 'POST',
          url: `/agencies/${raceAgencyId}/invitations/collaborators`,
          remoteAddress: LOCK_ORDER_IP,
          headers: { ...origin, cookie },
          payload: { email, roleId: productionRoleId }
        });
        await waitForBlockedQueryStart(owner, holderPid);
        await holder.raw('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))', [
          `${raceAgencyId}:collaborator_invite:${email}:00000000-0000-0000-0000-000000000000`
        ]);
        await holder.commit();
        released = true;

        const response = await created;
        expect(response.statusCode).toBe(409);
        expect(JSON.stringify(response.json())).not.toMatch(/deadlock|40P01|pg_|relation|process/i);
        await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('revoked_at')).resolves.toEqual({ revoked_at: null });
        await expect(owner.knex('invitations').where({ agency_id: raceAgencyId }).select('id')).resolves.toHaveLength(1);

        const retried = await app.app.inject({
          method: 'POST',
          url: `/agencies/${raceAgencyId}/invitations/collaborators`,
          remoteAddress: LOCK_ORDER_IP,
          headers: { ...origin, cookie },
          payload: { email, roleId: productionRoleId }
        });
        expect(retried.statusCode).toBe(201);
      } finally {
        if (!released) await holder.rollback();
      }
    }, 20_000);

    it('answers 409 TRY_AGAIN when a client-invitation creation loses a deadlock, and changes nothing', async () => {
      const raceOwner = await makeUser('invitations-deadlock-client-owner');
      const raceAgencyId = await createAgency('Invitations deadlock client agency', raceOwner.id);
      const raceClientId = randomUUID();
      createdClientIds.push(raceClientId);
      await owner.knex('clients').insert({ id: raceClientId, agency_id: raceAgencyId, name: 'Deadlock client' });
      const cookie = await loginFromLockOrderIp(raceOwner);
      const email = `deadlock-client-${randomUUID()}@example.test`;
      const invitation = await insertInvitation({ agencyId: raceAgencyId, purpose: 'client_invite', clientId: raceClientId, roleId: null, email });

      const holder = await owner.knex.transaction();
      let released = false;
      try {
        // Same cycle as the collaborator creation, and the client slot key carries the clientId.
        const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.invitations where id = ?::uuid for update', [invitation.invitationId]);
        if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one invitation.');
        const holderPid = await backendPid(holder);
        const created = app.app.inject({
          method: 'POST',
          url: `/agencies/${raceAgencyId}/clients/${raceClientId}/invitations`,
          remoteAddress: LOCK_ORDER_IP,
          headers: { ...origin, cookie },
          payload: { email }
        });
        await waitForBlockedQueryStart(owner, holderPid);
        await holder.raw('select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(?, 0))', [
          `${raceAgencyId}:client_invite:${email}:${raceClientId}`
        ]);
        await holder.commit();
        released = true;

        const response = await created;
        expect(response.statusCode).toBe(409);
        expect(response.json().error?.code).toBe('TRY_AGAIN');
        expect(JSON.stringify(response.json())).not.toMatch(/deadlock|40P01|pg_|relation|process/i);
        await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('revoked_at')).resolves.toEqual({ revoked_at: null });
        await expect(owner.knex('invitations').where({ agency_id: raceAgencyId }).select('id')).resolves.toHaveLength(1);

        const retried = await app.app.inject({
          method: 'POST',
          url: `/agencies/${raceAgencyId}/clients/${raceClientId}/invitations`,
          remoteAddress: LOCK_ORDER_IP,
          headers: { ...origin, cookie },
          payload: { email }
        });
        expect(retried.statusCode).toBe(201);
      } finally {
        if (!released) await holder.rollback();
      }
    }, 20_000);

    it('answers 409 TRY_AGAIN when a cancellation loses a deadlock, and the invitation stays pending', async () => {
      const raceOwner = await makeUser('invitations-deadlock-cancel-owner');
      const raceAgencyId = await createAgency('Invitations deadlock cancel agency', raceOwner.id);
      const cookie = await loginFromLockOrderIp(raceOwner);
      const email = `deadlock-cancel-${randomUUID()}@example.test`;
      const invitation = await insertInvitation({ agencyId: raceAgencyId, email });

      const holder = await owner.knex.transaction();
      let released = false;
      try {
        // The audit insert is the cancellation's last target: holding that table makes it wait
        // there while it holds the invitation row, and the holder then asks for that row.
        await holder.raw('lock table audit.events in access exclusive mode');
        const holderPid = await backendPid(holder);
        const canceled = app.app.inject({
          method: 'DELETE',
          url: `/agencies/${raceAgencyId}/invitations/${invitation.invitationId}`,
          remoteAddress: LOCK_ORDER_IP,
          headers: { ...origin, cookie }
        });
        await waitForBlockedQueryStart(owner, holderPid);
        await raw(holder, 'select id from public.invitations where id = ?::uuid for update', [invitation.invitationId]);
        await holder.commit();
        released = true;

        const response = await canceled;
        expect(response.statusCode).toBe(409);
        expect(response.json().error?.code).toBe('TRY_AGAIN');
        expect(JSON.stringify(response.json())).not.toMatch(/deadlock|40P01|pg_|relation|process/i);
        await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('revoked_at')).resolves.toEqual({ revoked_at: null });

        const retried = await app.app.inject({
          method: 'DELETE',
          url: `/agencies/${raceAgencyId}/invitations/${invitation.invitationId}`,
          remoteAddress: LOCK_ORDER_IP,
          headers: { ...origin, cookie }
        });
        expect(retried.statusCode).toBe(204);
      } finally {
        if (!released) await holder.rollback();
      }
    }, 20_000);

    it('answers 409 TRY_AGAIN when an acceptance loses a deadlock, and the link still works afterwards', async () => {
      const raceOwner = await makeUser('invitations-deadlock-accept-owner');
      const raceAgencyId = await createAgency('Invitations deadlock accept agency', raceOwner.id);
      const invited = await makeUser('invitations-deadlock-accept-invitee');
      // Issue #68: logging in requires a context of their own, unrelated to the invitation.
      await createAgency('Invitations deadlock accept home agency', invited.id);
      const cookie = await loginFromLockOrderIp(invited);
      const invitation = await insertInvitation({ agencyId: raceAgencyId, email: invited.email });

      const holder = await owner.knex.transaction();
      let released = false;
      try {
        // The acceptance locks the invitation row and then the agency; holding the agency makes it
        // wait there while it holds the invitation row, and the holder then asks for that row.
        const locked = await raw<{ rows: Array<{ id: string }> }>(holder, 'select id from public.agencies where id = ?::uuid for update', [raceAgencyId]);
        if (locked.rows.length !== 1) throw new Error('The holder did not lock exactly one agency.');
        const holderPid = await backendPid(holder);
        const accepted = app.app.inject({
          method: 'POST',
          url: `/invitations/${invitation.token}/accept`,
          remoteAddress: '127.0.0.5',
          headers: { ...origin, cookie }
        });
        await waitForBlockedQueryStart(owner, holderPid);
        await raw(holder, 'select id from public.invitations where id = ?::uuid for update', [invitation.invitationId]);
        await holder.commit();
        released = true;

        const response = await accepted;
        expect(response.statusCode).toBe(409);
        expect(response.json().error?.code).toBe('TRY_AGAIN');
        expect(JSON.stringify(response.json())).not.toMatch(/deadlock|40P01|pg_|relation|process/i);
        await expect(owner.knex('invitations').where({ id: invitation.invitationId }).first('used_at')).resolves.toEqual({ used_at: null });
        await expect(owner.knex('agency_memberships').where({ agency_id: raceAgencyId, user_id: invited.id }).first('id')).resolves.toBeUndefined();

        const retried = await app.app.inject({
          method: 'POST',
          url: `/invitations/${invitation.token}/accept`,
          remoteAddress: '127.0.0.5',
          headers: { ...origin, cookie }
        });
        expect(retried.statusCode).toBe(200);
      } finally {
        if (!released) await holder.rollback();
      }
    }, 20_000);
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
    // Issue #68: logging in requires a context of their own, unrelated to `mismatch`'s agency.
    await createAgency('Mismatch Home Agency', otherUser.id);
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
    // Issue #68: logging in requires a context of their own, unrelated to `agencyId`.
    await createAgency('Unrelated Home Agency', unrelated.id);
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

  it('rejects an extra field in the collaborator invitation body (.strict())', async () => {
    // The schema in `config.schemas.body` is the same object the handler parses: mutating it to
    // `.passthrough()` breaks the documentation coverage test, and this test breaks the behaviour.
    const email = `extra-field-${randomUUID()}@example.test`;
    const response = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/invitations/collaborators`,
      headers: { ...origin, cookie: await loginCookie(admin) },
      payload: { email, roleId: productionRoleId, isAdmin: true }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    await expect(owner.knex('invitations').where({ email }).first('id')).resolves.toBeUndefined();
  });

  it('rejects an extra field in the client invitation body (.strict())', async () => {
    // The client-invite body is the route the #187 re-review mutated to `.passthrough()` and stayed
    // green; this test is what turns that drift red in behavior, alongside the schema-identity
    // check in `routeBody` and the harness response validation.
    // A distinct source IP keeps this login and rejected invite out of the shared per-IP rate limit
    // buckets the rest of the suite runs against (login and invitation are both per-IP).
    const login = await app.app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '127.0.0.2',
      headers: origin,
      payload: { email: admin.email, password: admin.password }
    });
    expect(login.statusCode).toBe(200);

    const email = `extra-field-client-${randomUUID()}@example.test`;
    const response = await app.app.inject({
      method: 'POST',
      url: `/agencies/${agencyId}/clients/${clientId}/invitations`,
      remoteAddress: '127.0.0.2',
      headers: { ...origin, cookie: sessionCookieHeader(login.cookies) },
      payload: { email, leakedRoleId: productionRoleId }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    await expect(owner.knex('invitations').where({ email }).first('id')).resolves.toBeUndefined();
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

    // A role scoped to exactly one permission distinguishes "the guard checks the right key" from
    // "the guard checks *a* key that only `admin` happens to hold" -- the divergence issue #99
    // itself points to (#39): rota e policy exigindo chaves diferentes.
    const customRoleWithPermission = async (targetAgencyId: string, permissionKey: string): Promise<string> => {
      const roleId = randomUUID();
      createdCustomRoleIds.push(roleId);
      await owner.knex('roles').insert({ id: roleId, agency_id: targetAgencyId, key: `custom-${roleId}`, name: `Custom (${permissionKey})`, is_system: false });
      await owner.knex('role_permissions').insert({ role_id: roleId, permission_key: permissionKey });
      return roleId;
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
      // A pending activation invite has no role and no client -- the opposite shape of a
      // collaborator invite. A `purpose <> 'client_invite'` regression (instead of `purpose =
      // 'collaborator_invite'`) would let this through; the response schema would then also have
      // to reject it, since `role` is required there.
      const activation = await insertInvitation({ agencyId: pendingAgencyId, email: `activation-list-${randomUUID()}@example.test`, purpose: 'agency_activation', roleId: null, clientId: null });
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
      expect(returnedIds).not.toContain(activation.invitationId);
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

      // `page=4e17` is still `Number.isInteger`-true and would overflow the OFFSET computed from
      // it into a 500; `.safe()` on the shared schema rejects it as 400 before it reaches the query.
      const overflow = await app.app.inject({
        method: 'GET',
        url: `/agencies/${pageAgencyId}/invitations?page=4e17`,
        headers: { ...origin, cookie: await loginCookie(pageOwner) }
      });
      expect(overflow.statusCode).toBe(400);
      expect(overflow.json().error).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('orders by created_at ascending, breaks ties by id, and keeps pages disjoint', async () => {
      const orderOwner = await makeUser('invitations-pending-order-owner');
      const orderAgencyId = await createAgency('Pending invitations order agency', orderOwner.id);
      const tiedAt = new Date('2026-01-01T00:00:00.000Z');
      const laterAt = new Date('2026-01-02T00:00:00.000Z');
      // Two invitations share the exact same `created_at`; the query's own `, invitation.id asc`
      // tiebreaker is what keeps their relative order stable and the pages disjoint.
      const tied = await Promise.all([0, 1].map((index) =>
        insertInvitation({ agencyId: orderAgencyId, email: `order-tied-${index}-${randomUUID()}@example.test`, roleId: productionRoleId, createdAt: tiedAt })
      ));
      const later = await insertInvitation({ agencyId: orderAgencyId, email: `order-later-${randomUUID()}@example.test`, roleId: productionRoleId, createdAt: laterAt });
      // Plain ordinal comparison, not `localeCompare`: Postgres orders `uuid` by raw byte value,
      // which for a lowercase-hex UUID string matches simple codepoint comparison, not collation.
      const [tiedFirstById, tiedSecondById] = [...tied].sort((a, b) => (a.invitationId < b.invitationId ? -1 : 1));

      const firstPage = await app.app.inject({
        method: 'GET',
        url: `/agencies/${orderAgencyId}/invitations?page=1&pageSize=2`,
        headers: { ...origin, cookie: await loginCookie(orderOwner) }
      });
      const firstIds = firstPage.json<{ data: Array<{ id: string }> }>().data.map((row) => row.id);
      expect(firstIds).toEqual([tiedFirstById.invitationId, tiedSecondById.invitationId]);

      const secondPage = await app.app.inject({
        method: 'GET',
        url: `/agencies/${orderAgencyId}/invitations?page=2&pageSize=2`,
        headers: { ...origin, cookie: await loginCookie(orderOwner) }
      });
      const secondIds = secondPage.json<{ data: Array<{ id: string }> }>().data.map((row) => row.id);
      expect(secondIds).toEqual([later.invitationId]);
      expect(new Set([...firstIds, ...secondIds]).size).toBe(3);
    });

    it('serves the counter and the page from one snapshot when an invitation is revoked mid-request', async () => {
      const raceOwner = await makeUser('invitations-pending-race-owner');
      const raceAgencyId = await createAgency('Pending invitations race agency', raceOwner.id);
      const cookie = await loginCookie(raceOwner);
      const pending = await insertInvitation({ agencyId: raceAgencyId, email: `race-${randomUUID()}@example.test` });

      // The guard reads `agencies`, whose RLS policy pulls `clients`, so a clients lock held from
      // the start would freeze the request before the count. Two locks sequence instead:
      // `invitations` pauses the handler's first statement, and `clients` is taken right after the
      // guard returns (proved by the first wait) to pause the page. By then a separate count has
      // already answered from its own snapshot; the revocation then commits while the page waits.
      // A count read before it would report one, while the list shows none (issue #165).
      const holdInvitations = await owner.knex.transaction();
      await holdInvitations.raw('lock table public.invitations in access exclusive mode');
      let invitationsReleased = false;
      try {
        const responsePromise = app.app.inject({
          method: 'GET',
          url: `/agencies/${raceAgencyId}/invitations`,
          headers: { ...origin, cookie }
        });
        await waitForRelationLockWait(owner, 'invitations');

        const holdClients = await owner.knex.transaction();
        let clientsReleased = false;
        try {
          await holdClients.raw('lock table public.clients in access exclusive mode');
          await holdInvitations.commit();
          invitationsReleased = true;
          await waitForRelationLockWait(owner, 'clients');

          await owner.knex('invitations').where({ id: pending.invitationId }).update({ revoked_at: new Date() });
          await holdClients.commit();
          clientsReleased = true;

          const response = await responsePromise;
          expect(response.statusCode).toBe(200);
          const body = response.json<{ data: Array<{ id: string }>; meta: { totalItems: number; totalPages: number } }>();
          expect(body.data).toEqual([]);
          expect(body.meta).toMatchObject({ totalItems: 0, totalPages: 0 });
        } finally {
          if (!clientsReleased) await holdClients.rollback();
        }
      } finally {
        if (!invitationsReleased) await holdInvitations.rollback();
      }
    }, 20_000);

    it('serves a non-empty page with a single statement, so the counter cannot come from a second snapshot (issue #304)', async () => {
      const singleOwner = await makeUser('invitations-single-snapshot-owner');
      const singleAgencyId = await createAgency('Single snapshot agency', singleOwner.id);
      await insertInvitation({ agencyId: singleAgencyId, email: `single-${randomUUID()}@example.test` });
      const cookie = await loginCookie(singleOwner);

      recordedStatements.length = 0;
      const response = await app.app.inject({ method: 'GET', url: `/agencies/${singleAgencyId}/invitations`, headers: { ...origin, cookie } });
      expect(response.statusCode).toBe(200);
      const invitationStatements = recordedStatements.filter((statement) => statement.includes('from public.invitations'));
      expect(invitationStatements).toHaveLength(1);
      expect(invitationStatements[0]).toContain('count(*) over ()');
      expect(response.json<{ meta: { totalItems: number } }>().meta.totalItems).toBe(1);
    });

    it('answers an empty first page from its own snapshot, without a fallback count (issue #304)', async () => {
      const emptyOwner = await makeUser('invitations-empty-first-page-owner');
      const emptyAgencyId = await createAgency('Empty first page agency', emptyOwner.id);
      const cookie = await loginCookie(emptyOwner);

      recordedStatements.length = 0;
      const response = await app.app.inject({ method: 'GET', url: `/agencies/${emptyAgencyId}/invitations`, headers: { ...origin, cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ data: [], meta: { page: 1, totalItems: 0, totalPages: 0 } });
      expect(recordedStatements.filter((statement) => statement.includes('from public.invitations'))).toHaveLength(1);
    });

    it('keeps the real total for an empty page past the first, where the fallback count is the contract (issue #304)', async () => {
      const beyondOwner = await makeUser('invitations-beyond-page-owner');
      const beyondAgencyId = await createAgency('Beyond page agency', beyondOwner.id);
      await insertInvitation({ agencyId: beyondAgencyId, email: `beyond-a-${randomUUID()}@example.test` });
      await insertInvitation({ agencyId: beyondAgencyId, email: `beyond-b-${randomUUID()}@example.test` });
      const cookie = await loginCookie(beyondOwner);

      recordedStatements.length = 0;
      const response = await app.app.inject({ method: 'GET', url: `/agencies/${beyondAgencyId}/invitations?page=3&pageSize=1`, headers: { ...origin, cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ data: [], meta: { page: 3, pageSize: 1, totalItems: 2, totalPages: 2 } });
      // The page and its fallback count: the offset page is where the second statement is the contract.
      expect(recordedStatements.filter((statement) => statement.includes('from public.invitations'))).toHaveLength(2);
    });

    it('returns 200 for a role with only colaborador.convidar, and 403 for one with only cliente.convidar_usuario, convite.reenviar, or convite.cancelar', async () => {
      const scopedOwner = await makeUser('invitations-pending-scoped-owner');
      const scopedAgencyId = await createAgency('Pending invitations scoped agency', scopedOwner.id);
      await insertInvitation({ agencyId: scopedAgencyId, email: `scoped-${randomUUID()}@example.test`, roleId: productionRoleId });

      const convidarRoleId = await customRoleWithPermission(scopedAgencyId, 'colaborador.convidar');
      const convidarUser = await makeUser('invitations-pending-only-convidar');
      await owner.knex('agency_memberships').insert({ agency_id: scopedAgencyId, user_id: convidarUser.id, role_id: convidarRoleId });
      const allowed = await app.app.inject({
        method: 'GET',
        url: `/agencies/${scopedAgencyId}/invitations`,
        headers: { ...origin, cookie: await loginCookie(convidarUser) }
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json<{ data: unknown[] }>().data).toHaveLength(1);

      for (const [label, permissionKey] of [
        ['client-invite', 'cliente.convidar_usuario'],
        ['resend', 'convite.reenviar'],
        ['cancel', 'convite.cancelar']
      ] as const) {
        const roleId = await customRoleWithPermission(scopedAgencyId, permissionKey);
        const user = await makeUser(`invitations-pending-only-${label}`);
        await owner.knex('agency_memberships').insert({ agency_id: scopedAgencyId, user_id: user.id, role_id: roleId });
        const response = await app.app.inject({
          method: 'GET',
          url: `/agencies/${scopedAgencyId}/invitations`,
          headers: { ...origin, cookie: await loginCookie(user) }
        });
        expect(response.statusCode).toBe(403);
      }
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
      // Issue #68: logging in requires a context of their own, unrelated to `agencyId`.
      await createAgency('Outsider Home Agency', outsider.id);
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
    const resentInvitationId = resent.json<{ invitationId: string }>().invitationId;
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

    // The resent invitation is still pending at this point (only the client and activation
    // invitations above were accepted), so the pending list is exercised with a live invitation in
    // play. `resentToken` itself was never trustworthy here: the database never stores the raw
    // token, only its hash, so asserting the response lacks the token is vacuously true. What
    // could actually leak is the hash, so that is what gets checked, against both the response and
    // the logs this specific request produced.
    const resentTokenHash = (await owner.knex('invitations').where({ id: resentInvitationId }).first('token_hash'))?.token_hash;
    expect(resentTokenHash).toBeDefined();
    const pendingList = await logApp.app.inject({
      method: 'GET',
      url: `/agencies/${logAgencyId}/invitations`,
      headers: { ...origin, cookie: adminCookie }
    });
    expect(pendingList.statusCode).toBe(200);
    const pendingListBody = JSON.stringify(pendingList.json());
    expect(pendingListBody).not.toContain(resentTokenHash);
    expect(pendingListBody).not.toMatch(/token/i);

    await new Promise<void>((resolve) => setImmediate(resolve));
    const logs = text();
    expect(logs).not.toContain(resentTokenHash);
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

  // Issue #333: the creation response carries the pending invitation it revoked, so the screen no
  // longer guesses it from the loaded pages of the invitations list.
  describe('POST /agencies/:agencyId/invitations/collaborators superseded id', () => {
    const invite = async (cookie: string, email: string, targetAgency = agencyId): Promise<{ statusCode: number; body: { invitationId: string; supersededInvitationId: string | null } }> => {
      const response = await app.app.inject({
        method: 'POST',
        url: `/agencies/${targetAgency}/invitations/collaborators`,
        // A distinct source IP keeps these logins and creations out of the shared per-IP buckets
        // the rest of the suite runs against, like the client-invite strict-body test above.
        remoteAddress: '127.0.0.3',
        headers: { ...origin, cookie },
        payload: { email, roleId: productionRoleId }
      });
      return { statusCode: response.statusCode, body: response.json() };
    };
    const loginFromTestIp = async (): Promise<string> => {
      const login = await app.app.inject({
        method: 'POST',
        url: '/auth/login',
        remoteAddress: '127.0.0.3',
        headers: origin,
        payload: { email: admin.email, password: admin.password }
      });
      expect(login.statusCode).toBe(200);
      return sessionCookieHeader(login.cookies);
    };

    it('answers the revoked pending invitation id, and null when there was none', async () => {
      const targetEmail = `superseded-${randomUUID()}@example.test`;
      const cookie = await loginFromTestIp();

      const first = await invite(cookie, targetEmail);
      expect(first.statusCode).toBe(201);
      expect(first.body.supersededInvitationId).toBeNull();

      const second = await invite(cookie, targetEmail);
      expect(second.statusCode).toBe(201);
      expect(second.body.supersededInvitationId).toBe(first.body.invitationId);
      expect(second.body.invitationId).not.toBe(first.body.invitationId);
      await expect(owner.knex('invitations').where({ id: first.body.invitationId }).first('revoked_at')).resolves.toMatchObject({ revoked_at: expect.any(Date) });
    });

    it('never answers an invitation id from another agency for the same e-mail', async () => {
      const targetEmail = `cross-agency-${randomUUID()}@example.test`;
      const otherAgency = await createAgency('Superseded other agency', admin.id);
      const other = await insertInvitation({ agencyId: otherAgency, email: targetEmail });
      const mine = await insertInvitation({ agencyId, email: targetEmail });

      const created = await invite(await loginFromTestIp(), targetEmail);
      expect(created.statusCode).toBe(201);
      expect(created.body.supersededInvitationId).toBe(mine.invitationId);
      expect(created.body.supersededInvitationId).not.toBe(other.invitationId);
      // Only this agency's pending invitation was revoked; the other agency's is untouched.
      await expect(owner.knex('invitations').where({ id: mine.invitationId }).first('revoked_at')).resolves.toMatchObject({ revoked_at: expect.any(Date) });
      await expect(owner.knex('invitations').where({ id: other.invitationId }).first('revoked_at')).resolves.toEqual({ revoked_at: null });
    });

    it('answers null when the revoked previous invitation had already expired', async () => {
      const targetEmail = `expired-superseded-${randomUUID()}@example.test`;
      const expired = await insertInvitation({ agencyId, email: targetEmail, expiresAt: new Date(Date.now() - 60_000) });

      const created = await invite(await loginFromTestIp(), targetEmail);
      expect(created.statusCode).toBe(201);
      expect(created.body.supersededInvitationId).toBeNull();
      // The expired row is still revoked, so the partial index frees the slot for the new one.
      await expect(owner.knex('invitations').where({ id: expired.invitationId }).first('revoked_at')).resolves.toMatchObject({ revoked_at: expect.any(Date) });
      await expect(owner.knex('invitations').where({ agency_id: agencyId, email: targetEmail }).select('id', 'revoked_at')).resolves.toHaveLength(2);
    });

    it('answers null when an expired previous invitation was already revoked', async () => {
      const targetEmail = `expired-revoked-${randomUUID()}@example.test`;
      const alreadyRevoked = await insertInvitation({
        agencyId,
        email: targetEmail,
        expiresAt: new Date(Date.now() - 120_000),
        revokedAt: new Date(Date.now() - 30_000)
      });
      const before = await owner.knex('invitations').where({ id: alreadyRevoked.invitationId }).first('revoked_at');

      const created = await invite(await loginFromTestIp(), targetEmail);
      expect(created.statusCode).toBe(201);
      expect(created.body.supersededInvitationId).toBeNull();
      // The revoke only touches rows with `revoked_at is null`, so this one is left as it was.
      const after = await owner.knex('invitations').where({ id: alreadyRevoked.invitationId }).first('revoked_at');
      expect(after?.revoked_at).toEqual(before?.revoked_at);
    });
  });
});
