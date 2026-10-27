import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  resolveIntegrationDatabaseUrls,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Decision 2026-10-27, "o aceite pelo link do e-mail confirma o e-mail". An invitation row has two
// hashes: `token_hash` (the link that may be copied) and `email_token_hash` (the one that only goes in
// the e-mail). Either finds the row, either consumes it, and only the e-mail one is reported as such.
// The application role writes the e-mail hash on INSERT and can never read it back.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
let adminRoleId = '';
const agencyId = randomUUID();
const ownerUserId = randomUUID();
const userIds = [ownerUserId];
const invitationIds: string[] = [];

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};
const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUser = <TResult>(userId: string, work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

const insertUser = async (id: string): Promise<string> => {
  const email = `email-token-${id}@example.test`;
  await getOwner().knex('auth.user').insert({ id, name: 'Invitee', email, emailVerified: false });
  return email;
};

interface Fixture {
  readonly userId: string;
  readonly invitationId: string;
  readonly copyHash: string;
  readonly emailHash: string;
}

const invitation = async (): Promise<Fixture> => {
  const userId = randomUUID();
  userIds.push(userId);
  const email = await insertUser(userId);
  const invitationId = randomUUID();
  invitationIds.push(invitationId);
  const copyHash = `copy-${invitationId}`;
  const emailHash = `mail-${invitationId}`;
  await getOwner().knex('invitations').insert({
    id: invitationId, agency_id: agencyId, purpose: 'collaborator_invite', email, role_id: adminRoleId,
    token_hash: copyHash, email_token_hash: emailHash,
    expires_at: new Date(Date.now() + 86_400_000)
  });
  return { userId, invitationId, copyHash, emailHash };
};

const lookup = (fixture: Fixture, hash: string) =>
  asUser(fixture.userId, (transaction) =>
    raw<{ rows: Array<{ id: string; valid: boolean }> }>(transaction, 'select id, valid from app_private.invitation_by_token_hash(?)', [hash]));

const cameByEmail = (fixture: Fixture, hash: string) =>
  asUser(fixture.userId, (transaction) =>
    raw<{ rows: Array<{ came: boolean }> }>(transaction, 'select app_private.invitation_token_came_by_email(?) as came', [hash]));

const accept = (fixture: Fixture, hash: string) =>
  asUser(fixture.userId, (transaction) =>
    raw<{ rows: Array<{ status: string; agency_id: string; client_id: string | null }> }>(transaction, 'select * from app_private.accept_invitation(?, ?::uuid, null, null, false)', [hash, fixture.userId]));

/** The SQLSTATE a statement fails with, or undefined when it does not fail. */
const sqlState = async (work: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const role = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'admin' }).first('id');
  if (role === undefined) throw new Error('System role seeds are missing.');
  adminRoleId = role.id;
  await insertUser(ownerUserId);
  await getOwner().knex('agencies').insert({ id: agencyId, name: 'Token do e-mail', owner_user_id: ownerUserId, status: 'active' });
});

afterAll(async () => {
  if (owner !== undefined) {
    await owner.knex('audit.events').where({ agency_id: agencyId }).delete();
    await owner.knex('invitations').whereIn('id', invitationIds).delete();
    await owner.knex('agency_memberships').where({ agency_id: agencyId }).delete();
  }
});

describe('an invitation is found by either of its two hashes', () => {
  it('finds the row by the copy hash and by the e-mail hash, and by nothing else', async () => {
    const fixture = await invitation();

    expect((await lookup(fixture, fixture.copyHash)).rows).toEqual([{ id: fixture.invitationId, valid: true }]);
    expect((await lookup(fixture, fixture.emailHash)).rows).toEqual([{ id: fixture.invitationId, valid: true }]);
    expect((await lookup(fixture, `other-${fixture.invitationId}`)).rows).toEqual([]);
  });

  it('tells which one came by e-mail: only the e-mail hash, never the copy hash or an unknown one', async () => {
    const fixture = await invitation();

    expect((await cameByEmail(fixture, fixture.emailHash)).rows).toEqual([{ came: true }]);
    expect((await cameByEmail(fixture, fixture.copyHash)).rows).toEqual([{ came: false }]);
    expect((await cameByEmail(fixture, 'not-a-hash')).rows).toEqual([{ came: false }]);
  });

  it('a revoked invitation ends both hashes at once', async () => {
    const fixture = await invitation();
    await getOwner().knex('invitations').where({ id: fixture.invitationId }).update({ revoked_at: new Date() });

    expect((await lookup(fixture, fixture.copyHash)).rows).toEqual([{ id: fixture.invitationId, valid: false }]);
    expect((await lookup(fixture, fixture.emailHash)).rows).toEqual([{ id: fixture.invitationId, valid: false }]);
    expect(await sqlState(() => accept(fixture, fixture.copyHash))).toBe('A0001');
    expect(await sqlState(() => accept(fixture, fixture.emailHash))).toBe('A0001');
  });
});

describe('either hash consumes the invitation, once', () => {
  it.each([
    ['the e-mail hash', 'emailHash', 'copyHash'],
    ['the copy hash', 'copyHash', 'emailHash']
  ] as const)('accepting with %s leaves the other hash refused', async (_name, first, second) => {
    const fixture = await invitation();

    expect((await accept(fixture, fixture[first])).rows).toEqual([{ status: 'accepted', agency_id: agencyId, client_id: null }]);
    expect(await sqlState(() => accept(fixture, fixture[second]))).toBe('A0001');
    expect(await sqlState(() => accept(fixture, fixture[first]))).toBe('A0001');
    expect(await getOwner().knex('agency_memberships').where({ agency_id: agencyId, user_id: fixture.userId }).select('id')).toHaveLength(1);
    expect((await getOwner().knex('invitations').where({ id: fixture.invitationId }).first('used_at'))?.used_at).not.toBeNull();
  });
});

describe('the e-mail hash is write-only for the application role', () => {
  it('has INSERT and no SELECT or UPDATE on the column', async () => {
    const { rows } = await raw<{ rows: Array<{ can_insert: boolean; can_select: boolean; can_update: boolean }> }>(getOwner().knex, `
      select pg_catalog.has_column_privilege('ageniza_app', 'public.invitations', 'email_token_hash', 'insert') as can_insert,
             pg_catalog.has_column_privilege('ageniza_app', 'public.invitations', 'email_token_hash', 'select') as can_select,
             pg_catalog.has_column_privilege('ageniza_app', 'public.invitations', 'email_token_hash', 'update') as can_update
    `, []);
    expect(rows[0]).toEqual({ can_insert: true, can_select: false, can_update: false });
  });

  it('refuses to read the column, in a select list and in a where clause', async () => {
    const fixture = await invitation();

    for (const sql of [
      'select email_token_hash from public.invitations',
      'select id from public.invitations where email_token_hash is not null'
    ]) {
      expect(await sqlState(() => asUser(fixture.userId, (transaction) => raw(transaction, sql, [])))).toBe('42501');
    }
  });

  it('the owner role sees the hash, the lists of the application never do', async () => {
    const fixture = await invitation();
    expect((await getOwner().knex('invitations').where({ id: fixture.invitationId }).first('email_token_hash'))?.email_token_hash).toBe(fixture.emailHash);
  });

  it('the function that tells the kind is executable by the application role and not by public', async () => {
    const { rows } = await raw<{ rows: Array<{ app: boolean; public_has_it: boolean }> }>(getOwner().knex, `
      select pg_catalog.has_function_privilege('ageniza_app', 'app_private.invitation_token_came_by_email(text)', 'execute') as app,
             exists (
               select 1
               from pg_catalog.pg_proc p
               cross join lateral pg_catalog.aclexplode(p.proacl) acl
               where p.oid = 'app_private.invitation_token_came_by_email(text)'::regprocedure and acl.grantee = 0
             ) as public_has_it
    `, []);
    expect(rows[0]).toEqual({ app: true, public_has_it: false });
  });
});

describe('the table keeps the two hashes apart', () => {
  const inFuture = (): Date => new Date(Date.now() + 86_400_000);

  it('refuses an e-mail hash equal to the copy hash', async () => {
    const userId = randomUUID();
    userIds.push(userId);
    const email = await insertUser(userId);
    const id = randomUUID();

    expect(await sqlState(() => getOwner().knex('invitations').insert({
      id, agency_id: agencyId, purpose: 'collaborator_invite', email, role_id: adminRoleId,
      token_hash: 'same', email_token_hash: 'same', expires_at: inFuture()
    }))).toBe('23514');
  });

  it('refuses an e-mail hash on a client invitation, which keeps its single token', async () => {
    const userId = randomUUID();
    userIds.push(userId);
    const email = await insertUser(userId);
    const clientId = randomUUID();
    const id = randomUUID();
    await getOwner().knex('clients').insert({ id: clientId, agency_id: agencyId, name: 'Cliente do convite' });

    try {
      expect(await sqlState(() => getOwner().knex('invitations').insert({
        id, agency_id: agencyId, client_id: clientId, purpose: 'client_invite', email,
        token_hash: `c-${id}`, email_token_hash: `m-${id}`, expires_at: inFuture()
      }))).toBe('23514');
    } finally {
      await getOwner().knex('clients').where({ id: clientId }).delete();
    }
  });

  it('refuses the same e-mail hash on two invitations', async () => {
    const first = await invitation();
    const userId = randomUUID();
    userIds.push(userId);
    const email = await insertUser(userId);
    const id = randomUUID();

    expect(await sqlState(() => getOwner().knex('invitations').insert({
      id, agency_id: agencyId, purpose: 'collaborator_invite', email, role_id: adminRoleId,
      token_hash: `other-${id}`, email_token_hash: first.emailHash, expires_at: inFuture()
    }))).toBe('23505');
  });
});
