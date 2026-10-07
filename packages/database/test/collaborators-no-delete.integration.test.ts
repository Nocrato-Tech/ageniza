import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient
} from '../src/index.js';

// Issue #356. SPEC colaboradores rule 11: removing never deletes the row. Until migration
// 20261007000600 `ageniza_app` still held DELETE on `agency_memberships` and `invitations`, and only
// the absence of a DELETE policy under forced RLS stopped it. The suite asserts the privilege layer
// itself (a refusal at the privilege layer reads "permission denied", an RLS one reads "row-level
// security") and that the legitimate paths, which are UPDATEs, were not revoked with it.
const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/ageniza';
const applicationUrl = process.env.DATABASE_URL ?? 'postgresql://ageniza_app:ageniza_app@127.0.0.1:54322/ageniza';

const TABLES = ['agency_memberships', 'invitations'] as const;
const denied = (table: string) => ({ code: '42501', message: expect.stringContaining(`permission denied for table ${table}`) });

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
let productionRoleId: string;

const agencyId = randomUUID();
const ownerUserId = randomUUID();
const removerUserId = randomUUID();
const cancellerUserId = randomUUID();
const peopleIds: string[] = [];
const roleIds: string[] = [];
const invitationIds: string[] = [];

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

const customRole = async (permissionKey: string): Promise<string> => {
  const id = randomUUID();
  roleIds.push(id);
  await getOwner().knex('roles').insert({ id, agency_id: agencyId, key: `custom-${id.slice(0, 8)}`, name: 'Papel personalizado', is_system: false });
  await getOwner().knex('role_permissions').insert({ role_id: id, permission_key: permissionKey });
  return id;
};

const link = async (status: 'active' | 'removed'): Promise<string> => {
  const userId = randomUUID();
  peopleIds.push(userId);
  await insertUser(userId, 'pessoa');
  const [row] = await getOwner().knex('agency_memberships')
    .insert({ agency_id: agencyId, user_id: userId, role_id: productionRoleId, status })
    .returning('id');
  return row.id as string;
};

const invitation = async (): Promise<string> => {
  const id = randomUUID();
  invitationIds.push(id);
  await getOwner().knex('invitations').insert({
    id, agency_id: agencyId, purpose: 'collaborator_invite', email: `convite-${id.slice(0, 8)}@db-integration.test`,
    role_id: productionRoleId, token_hash: `hash-${id}`, expires_at: new Date(Date.now() + 86_400_000)
  });
  return id;
};

const asUser = <TResult>(userId: string, work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]): Promise<TResult> =>
  withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

const rowCount = async (table: (typeof TABLES)[number], id: string): Promise<number> =>
  (await getOwner().knex(table).where({ id }).select('id')).length;

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const role = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id');
  if (role === undefined) throw new Error('System role seeds are missing.');
  productionRoleId = role.id;

  await insertUser(ownerUserId, 'dona');
  await insertUser(removerUserId, 'removedor');
  await insertUser(cancellerUserId, 'cancelador');
  await getOwner().knex('agencies').insert({ id: agencyId, name: 'Sem DELETE', owner_user_id: ownerUserId, status: 'active' });
  await getOwner().knex('agency_memberships').insert([
    { agency_id: agencyId, user_id: removerUserId, role_id: await customRole('colaborador.remover'), status: 'active' },
    { agency_id: agencyId, user_id: cancellerUserId, role_id: await customRole('convite.cancelar'), status: 'active' }
  ]);
});

afterAll(async () => {
  await getOwner().knex('invitations').whereIn('id', invitationIds).delete();
  await getOwner().knex('agency_memberships').where({ agency_id: agencyId }).delete();
  await getOwner().knex('role_permissions').whereIn('role_id', roleIds).delete();
  await getOwner().knex('roles').whereIn('id', roleIds).delete();
  await getOwner().knex('agencies').where({ id: agencyId }).update({ owner_user_id: null });
  await getOwner().knex('agencies').where({ id: agencyId }).delete();
  await getOwner().knex('auth.user').whereIn('id', [ownerUserId, removerUserId, cancellerUserId, ...peopleIds]).delete();
  await getApplication().close();
  await getOwner().close();
});

describe('ageniza_app cannot delete memberships or invitations (issue #356)', () => {
  it('holds SELECT and no DELETE or TRUNCATE on either table', async () => {
    for (const table of TABLES) {
      const { rows } = await getOwner().knex.raw<{ rows: Array<Record<string, boolean>> }>(`
        select
          has_table_privilege('ageniza_app', ?::regclass, 'select') as can_select,
          has_table_privilege('ageniza_app', ?::regclass, 'delete') as can_delete,
          has_table_privilege('ageniza_app', ?::regclass, 'truncate') as can_truncate
      `, [`public.${table}`, `public.${table}`, `public.${table}`]);
      expect({ table, ...rows[0] }).toEqual({ table, can_select: true, can_delete: false, can_truncate: false });
    }
  });

  it('refuses the DELETE of a membership its own actor can see, at the privilege layer, leaving the row', async () => {
    const membership = await link('active');

    // The remover role is the strongest case: it holds the permission that removes, and removing is not deleting.
    await expect(asUser(removerUserId, async (transaction) => {
      expect(await transaction('agency_memberships').where({ id: membership }).select('id')).toHaveLength(1);
      return await transaction('agency_memberships').where({ id: membership }).delete();
    })).rejects.toMatchObject(denied('agency_memberships'));

    expect(await rowCount('agency_memberships', membership)).toBe(1);
  });

  it('refuses the DELETE of an invitation its own actor can see, at the privilege layer, leaving the row', async () => {
    const id = await invitation();

    await expect(asUser(cancellerUserId, async (transaction) => {
      expect(await transaction('invitations').where({ id }).select('id')).toHaveLength(1);
      return await transaction('invitations').where({ id }).delete();
    })).rejects.toMatchObject(denied('invitations'));

    expect(await rowCount('invitations', id)).toBe(1);
  });

  it.each(TABLES)('still refuses a %s DELETE when a permissive DELETE policy is created by mistake', async (table) => {
    const id = table === 'agency_memberships' ? await link('active') : await invitation();
    const actor = table === 'agency_memberships' ? removerUserId : cancellerUserId;

    // Same transaction, rolled back: the owner adds the policy, then acts as ageniza_app under it.
    const transaction = await getOwner().knex.transaction();
    try {
      await transaction.raw(`create policy zz_delete_by_mistake on public.${table} for delete to ageniza_app using (true)`);
      await transaction.raw('set local role ageniza_app');
      await transaction.raw('select app_private.bind_actor(?::uuid)', [actor]);
      await expect(transaction(table).where({ id }).delete()).rejects.toMatchObject(denied(table));
    } finally {
      await transaction.rollback();
    }

    expect(await rowCount(table, id)).toBe(1);
  });

  it('leaves the paths that do not delete: removing and bringing back are UPDATEs of status, cancelling is an UPDATE of revoked_at', async () => {
    const membership = await link('active');
    const id = await invitation();

    expect(await asUser(removerUserId, (transaction) => transaction('agency_memberships').where({ id: membership }).update({ status: 'removed' }))).toBe(1);
    expect(await getOwner().knex('agency_memberships').where({ id: membership }).first('status')).toEqual({ status: 'removed' });

    expect(await asUser(cancellerUserId, (transaction) => transaction('invitations').where({ id }).update({ revoked_at: new Date() }))).toBe(1);
    expect((await getOwner().knex('invitations').where({ id }).first('revoked_at'))?.revoked_at).not.toBeNull();

    expect(await asUser(ownerUserId, (transaction) => transaction('agency_memberships').where({ id: membership }).update({ status: 'active' }))).toBe(1);
    expect(await getOwner().knex('agency_memberships').where({ id: membership }).first('status')).toEqual({ status: 'active' });
  });
});
