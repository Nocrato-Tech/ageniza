import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient,
  resolveIntegrationDatabaseUrls
} from '../src/index.js';

// Issue #452. A membership has two states, `active` and `removed` (specs/colaboradores.md §4), and
// the `agency_memberships_status_check` constraint is the only thing that keeps it that way: the
// UPDATE trigger only judges the moves to `removed` (needs `colaborador.remover`) and to `active`
// (needs `colaborador.alterar_papel`), so any other value reaches the row with no permission
// question asked, and the UPDATE policy and the column grant on `status` let a holder of any one
// of the module's permissions write it.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

const CONSTRAINT = 'agency_memberships_status_check';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
let productionRoleId: string;

const agencyId = randomUUID();
const ownerUserId = randomUUID();
const removerUserId = randomUUID();
const peopleIds: string[] = [];
const roleIds: string[] = [];

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

const customRole = async (permissionKeys: readonly string[]): Promise<string> => {
  const id = randomUUID();
  roleIds.push(id);
  await getOwner().knex('roles').insert({ id, agency_id: agencyId, key: `custom-${id.slice(0, 8)}`, name: 'Papel personalizado', is_system: false });
  await getOwner().knex('role_permissions').insert(permissionKeys.map((permission_key) => ({ role_id: id, permission_key })));
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

const stored = async (membershipId: string) =>
  await getOwner().knex('agency_memberships').where({ id: membershipId }).first('role_id', 'status', 'job_title', 'updated_at');

const updateAs = async (userId: string, membershipId: string, change: Record<string, unknown>): Promise<number> =>
  await withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), async (transaction) =>
    await transaction('agency_memberships').where({ id: membershipId }).update(change)
  );

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const production = await getOwner().knex('roles').whereNull('agency_id').where({ key: 'production' }).first('id');
  if (production === undefined) throw new Error('System role seeds are missing.');
  productionRoleId = production.id as string;

  await insertUser(ownerUserId, 'dona');
  await insertUser(removerUserId, 'removedor');
  await getOwner().knex('agencies').insert({ id: agencyId, name: 'Vocabulário do vínculo', owner_user_id: ownerUserId, status: 'active' });
  const removerRole = await customRole(['colaborador.remover']);
  await getOwner().knex('agency_memberships').insert({ agency_id: agencyId, user_id: removerUserId, role_id: removerRole, status: 'active' });
});

afterAll(async () => {
  await getOwner().knex('agency_memberships').where({ agency_id: agencyId }).delete();
  await getOwner().knex('role_permissions').whereIn('role_id', roleIds).delete();
  await getOwner().knex('roles').whereIn('id', roleIds).delete();
  await getOwner().knex('agencies').where({ id: agencyId }).update({ owner_user_id: null });
  await getOwner().knex('agencies').where({ id: agencyId }).delete();
  await getOwner().knex('auth.user').whereIn('id', [ownerUserId, removerUserId, ...peopleIds]).delete();
  await getApplication().close();
  await getOwner().close();
});

describe('a membership is either active or removed (issue #452)', () => {
  it('the schema owner cannot insert or update a link into any other status: 23514 on the named constraint, row intact', async () => {
    await expect(
      getOwner().knex('agency_memberships').insert({ agency_id: agencyId, user_id: ownerUserId, role_id: productionRoleId, status: 'suspended' })
    ).rejects.toMatchObject({ code: '23514', constraint: CONSTRAINT });
    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyId, user_id: ownerUserId }).first('id')).resolves.toBeUndefined();

    const membershipId = await link('active');
    const before = await stored(membershipId);
    for (const status of ['suspended', 'Active', 'REMOVED', '']) {
      await expect(
        getOwner().knex('agency_memberships').where({ id: membershipId }).update({ status }),
        `status ${JSON.stringify(status)}`
      ).rejects.toMatchObject({ code: '23514', constraint: CONSTRAINT });
    }
    expect(await stored(membershipId)).toEqual(before);
  });

  it('a holder of colaborador.remover alone cannot write another status either, which would skip the alterar_papel the way back needs', async () => {
    const membershipId = await link('removed');
    const before = await stored(membershipId);

    await expect(updateAs(removerUserId, membershipId, { status: 'suspended' })).rejects.toMatchObject({ code: '23514', constraint: CONSTRAINT });
    // `removed` to `active` is the move the trigger guards with alterar_papel, and the refusal is its own.
    await expect(updateAs(removerUserId, membershipId, { status: 'active' })).rejects.toMatchObject({ code: '42501' });

    expect(await stored(membershipId)).toEqual(before);
  });

  it('the two real states still work for whoever may use them, so the refusals above are the constraint and not a broken fixture', async () => {
    const membershipId = await link('active');

    expect(await updateAs(removerUserId, membershipId, { status: 'removed' })).toBe(1);
    expect((await stored(membershipId)).status).toBe('removed');
  });
});
