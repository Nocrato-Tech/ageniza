import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #353. Two barriers refuse a role that belongs to another agency: the `role.agency_id =
// old.agency_id` clause of `app_private.check_agency_membership_update` (the UPDATE policy does not
// look at the role at all) and the matching clause of the `invitations_insert` policy. Both read
// `public.roles` under RLS, and `roles_select` only shows another agency's roles to its members, so
// an actor who is a member of one agency only is stopped by the hidden role, not by the clause.
// Only a person who is a member of **both** agencies sees the foreign role, which is the one case
// where the clause is the whole defence.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

// The trigger's own message: an RLS refusal is also 42501, so the code alone would not tell them apart.
const TRIGGER_MESSAGE = 'role_id must be a system role or belong to this agency.';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
let adminRoleId: string;
let productionRoleId: string;
let accountManagerRoleId: string;

const agencyA = randomUUID();
const agencyB = randomUUID();
const ownerA = randomUUID();
const ownerB = randomUUID();
const dualAdmin = randomUUID();
const dualChanger = randomUUID();
const dualInviter = randomUUID();
const peopleIds: string[] = [];
const roleIds: string[] = [];
const invitationEmails: string[] = [];
let roleOfA: string;
let roleOfB: string;

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const insertUser = async (id: string, label: string): Promise<void> => {
  await getOwner().knex('auth.user').insert({ id, name: label, email: `${label}.${id.slice(0, 8)}@db-integration.test`, emailVerified: false });
};

/** A non-system role of `agencyId` holding only the given permissions. */
const customRole = async (agencyId: string, permissionKeys: readonly string[]): Promise<string> => {
  const id = randomUUID();
  roleIds.push(id);
  await getOwner().knex('roles').insert({ id, agency_id: agencyId, key: `custom-${id.slice(0, 8)}`, name: 'Papel personalizado', is_system: false });
  await getOwner().knex('role_permissions').insert(permissionKeys.map((permission_key) => ({ role_id: id, permission_key })));
  return id;
};

const link = async (agencyId: string, userId: string, roleId: string): Promise<string> => {
  const [row] = await getOwner().knex('agency_memberships')
    .insert({ agency_id: agencyId, user_id: userId, role_id: roleId, status: 'active' })
    .returning('id');
  return row.id as string;
};

/** A membership of a person who is only a row, with the production role. */
const target = async (agencyId: string): Promise<string> => {
  const userId = randomUUID();
  peopleIds.push(userId);
  await insertUser(userId, 'alvo');
  return await link(agencyId, userId, productionRoleId);
};

const asUser = <TResult>(userId: string, work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

const storedRole = async (membershipId: string): Promise<string | undefined> =>
  (await getOwner().knex('agency_memberships').where({ id: membershipId }).first('role_id'))?.role_id;

/** Reads `roleId` first: a refusal below only proves the clause when the actor can see the role. */
const changeRoleAs = (userId: string, membershipId: string, roleId: string): Promise<number> =>
  asUser(userId, async (transaction) => {
    expect(await transaction('roles').where({ id: roleId }).select('id')).toHaveLength(1);
    return await transaction('agency_memberships').where({ id: membershipId }).update({ role_id: roleId });
  });

const inviteAs = (userId: string, agencyId: string, roleId: string): Promise<unknown> => {
  const id = randomUUID();
  const email = `convite-${id}@db-integration.test`;
  invitationEmails.push(email);
  return asUser(userId, async (transaction) => {
    expect(await transaction('roles').where({ id: roleId }).select('id')).toHaveLength(1);
    return await transaction('invitations').insert({
      id, agency_id: agencyId, purpose: 'collaborator_invite', email, role_id: roleId,
      token_hash: `hash-${id}`, expires_at: new Date(Date.now() + 86_400_000)
    });
  });
};

const invitationsTo = async (agencyId: string, roleId: string): Promise<number> =>
  (await getOwner().knex('invitations').where({ agency_id: agencyId, role_id: roleId }).whereIn('email', invitationEmails).select('id')).length;

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const roles = await getOwner().knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'production', 'account_manager']).select('id', 'key');
  adminRoleId = roles.find((role) => role.key === 'admin')?.id;
  productionRoleId = roles.find((role) => role.key === 'production')?.id;
  accountManagerRoleId = roles.find((role) => role.key === 'account_manager')?.id;
  if (adminRoleId === undefined || productionRoleId === undefined || accountManagerRoleId === undefined) throw new Error('System role seeds are missing.');

  for (const [id, label] of [[ownerA, 'dona-a'], [ownerB, 'dona-b'], [dualAdmin, 'admin-duplo'], [dualChanger, 'alterador-duplo'], [dualInviter, 'convidador-duplo']] as const) {
    await insertUser(id, label);
  }
  await getOwner().knex('agencies').insert([
    { id: agencyA, name: 'Agência A', owner_user_id: ownerA, status: 'active' },
    { id: agencyB, name: 'Agência B', owner_user_id: ownerB, status: 'active' }
  ]);
  roleOfA = await customRole(agencyA, ['colaborador.convidar']);
  roleOfB = await customRole(agencyB, ['colaborador.convidar']);

  // Each of the three is a member of both agencies, so roles_select shows them the other agency's role.
  // Two of them hold exactly the one permission the action asks for, never an Admin's blanket.
  await link(agencyA, dualAdmin, adminRoleId);
  await link(agencyB, dualAdmin, adminRoleId);
  await link(agencyA, dualChanger, await customRole(agencyA, ['colaborador.alterar_papel']));
  await link(agencyB, dualChanger, productionRoleId);
  await link(agencyA, dualInviter, await customRole(agencyA, ['colaborador.convidar']));
  await link(agencyB, dualInviter, productionRoleId);
});

afterAll(async () => {
  await getOwner().knex('invitations').whereIn('agency_id', [agencyA, agencyB]).delete();
  await getOwner().knex('agency_memberships').whereIn('agency_id', [agencyA, agencyB]).delete();
  await getOwner().knex('role_permissions').whereIn('role_id', roleIds).delete();
  await getOwner().knex('roles').whereIn('id', roleIds).delete();
  await getOwner().knex('agencies').whereIn('id', [agencyA, agencyB]).update({ owner_user_id: null });
  await getOwner().knex('agencies').whereIn('id', [agencyA, agencyB]).delete();
  await getOwner().knex('auth.user').whereIn('id', [ownerA, ownerB, dualAdmin, dualChanger, dualInviter, ...peopleIds]).delete();
  await getApplication().close();
  await getOwner().close();
});

describe('a role of another agency is refused even to a member of both (issue #353)', () => {
  it.each([
    ['an Admin of both agencies', () => dualAdmin],
    ['someone holding only colaborador.alterar_papel in A, who is also a member of B', () => dualChanger]
  ])('UPDATE: %s cannot give a membership of A the custom role of B; the trigger refuses with its own message', async (_label, actor) => {
    const membership = await target(agencyA);

    await expect(changeRoleAs(actor(), membership, roleOfB))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining(TRIGGER_MESSAGE) });

    expect(await storedRole(membership)).toBe(productionRoleId);
  });

  it('UPDATE: the same Admin cannot give a membership of B the custom role of A either', async () => {
    const membership = await target(agencyB);

    await expect(changeRoleAs(dualAdmin, membership, roleOfA))
      .rejects.toMatchObject({ code: '42501', message: expect.stringContaining(TRIGGER_MESSAGE) });

    expect(await storedRole(membership)).toBe(productionRoleId);
  });

  it('UPDATE: the roles that belong are still handed out: the agency\'s own custom role and a system role', async () => {
    const membership = await target(agencyA);

    expect(await changeRoleAs(dualChanger, membership, roleOfA)).toBe(1);
    expect(await storedRole(membership)).toBe(roleOfA);
    expect(await changeRoleAs(dualChanger, membership, accountManagerRoleId)).toBe(1);
    expect(await storedRole(membership)).toBe(accountManagerRoleId);
    expect(await changeRoleAs(dualAdmin, await target(agencyB), roleOfB)).toBe(1);
  });

  it.each([
    ['an Admin of both agencies', () => dualAdmin],
    ['someone holding only colaborador.convidar in A, who is also a member of B', () => dualInviter]
  ])('INSERT: %s cannot invite to A with the custom role of B; the policy refuses and no row exists', async (_label, actor) => {
    await expect(inviteAs(actor(), agencyA, roleOfB)).rejects.toThrow(/row-level security/);

    expect(await invitationsTo(agencyA, roleOfB)).toBe(0);
  });

  it('INSERT: the same Admin cannot invite to B with the custom role of A either', async () => {
    await expect(inviteAs(dualAdmin, agencyB, roleOfA)).rejects.toThrow(/row-level security/);

    expect(await invitationsTo(agencyB, roleOfA)).toBe(0);
  });

  it('INSERT: the roles that belong are still accepted: the agency\'s own custom role and a system role', async () => {
    await inviteAs(dualInviter, agencyA, roleOfA);
    await inviteAs(dualInviter, agencyA, productionRoleId);
    await inviteAs(dualAdmin, agencyB, roleOfB);

    expect(await invitationsTo(agencyA, roleOfA)).toBe(1);
    expect(await invitationsTo(agencyA, productionRoleId)).toBe(1);
    expect(await invitationsTo(agencyB, roleOfB)).toBe(1);
  });
});
