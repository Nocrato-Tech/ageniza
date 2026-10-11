import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  withAuthenticatedUserTransaction,
  type DatabaseClient,
  resolveIntegrationDatabaseUrls
} from '../src/index.js';

// Issue #98. The trigger that is the second barrier of the membership UPDATE asked for
// `colaborador.atribuir_admin` only when `role_id` changed, so a former Admin brought back as an
// Admin kept the same `role_id` and passed it. The suite runs as `ageniza_app`, the only role the
// trigger governs, and asserts the error code **and** the trigger's own message (an RLS refusal is
// also 42501) and that the row is intact afterwards.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

const TRIGGER_MESSAGE = 'colaborador.atribuir_admin is required to bring back a link with the admin role.';
const ROLE_CHANGE_MESSAGE = 'colaborador.atribuir_admin is required to grant the admin role.';

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;
let adminRoleId: string;
let productionRoleId: string;

const agencyId = randomUUID();
const ownerUserId = randomUUID();
const adminUserId = randomUUID();
const granteeUserId = randomUUID();
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

/** A link with the given role and status, for a person who is only a row. */
const link = async (roleId: string, status: 'active' | 'removed'): Promise<string> => {
  const userId = randomUUID();
  peopleIds.push(userId);
  await insertUser(userId, 'pessoa');
  const [row] = await getOwner().knex('agency_memberships')
    .insert({ agency_id: agencyId, user_id: userId, role_id: roleId, status })
    .returning('id');
  return row.id as string;
};

const stored = async (membershipId: string) =>
  await getOwner().knex('agency_memberships').where({ id: membershipId }).first('role_id', 'status', 'job_title', 'updated_at');

/** Runs one UPDATE as `userId` through the application role and returns the rows it changed. */
const updateAs = async (userId: string, membershipId: string, change: Record<string, unknown>): Promise<number> =>
  await withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), async (transaction) =>
    await transaction('agency_memberships').where({ id: membershipId }).update(change)
  );

const expectTrigger = async (userId: string, membershipId: string, change: Record<string, unknown>, message: string): Promise<void> => {
  await expect(updateAs(userId, membershipId, change)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining(message) });
};

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);
  const roles = await getOwner().knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'production']).select('id', 'key');
  adminRoleId = roles.find((role) => role.key === 'admin')?.id;
  productionRoleId = roles.find((role) => role.key === 'production')?.id;
  if (adminRoleId === undefined || productionRoleId === undefined) throw new Error('System role seeds are missing.');

  await insertUser(ownerUserId, 'dona');
  await insertUser(adminUserId, 'admin');
  await insertUser(granteeUserId, 'concedente');
  await getOwner().knex('agencies').insert({ id: agencyId, name: 'Reativação Admin', owner_user_id: ownerUserId, status: 'active' });
  await getOwner().knex('agency_memberships').insert({ agency_id: agencyId, user_id: adminUserId, role_id: adminRoleId, status: 'active' });
  const granteeRole = await customRole(['colaborador.alterar_papel', 'colaborador.atribuir_admin']);
  await getOwner().knex('agency_memberships').insert({ agency_id: agencyId, user_id: granteeUserId, role_id: granteeRole, status: 'active' });
});

afterAll(async () => {
  await getOwner().knex('agency_memberships').where({ agency_id: agencyId }).delete();
  await getOwner().knex('role_permissions').whereIn('role_id', roleIds).delete();
  await getOwner().knex('roles').whereIn('id', roleIds).delete();
  await getOwner().knex('agencies').where({ id: agencyId }).update({ owner_user_id: null });
  await getOwner().knex('agencies').where({ id: agencyId }).delete();
  await getOwner().knex('auth.user').whereIn('id', [ownerUserId, adminUserId, granteeUserId, ...peopleIds]).delete();
  await getApplication().close();
  await getOwner().close();
});

describe('reactivating a link that holds the admin role (issue #98)', () => {
  it('an Admin without atribuir_admin cannot bring back a former Admin as an Admin: 42501 with the trigger message, row intact', async () => {
    const formerAdmin = await link(adminRoleId, 'removed');
    const before = await stored(formerAdmin);

    await expectTrigger(adminUserId, formerAdmin, { status: 'active' }, TRIGGER_MESSAGE);
    // Naming the same role in the statement changes nothing about the transition.
    await expectTrigger(adminUserId, formerAdmin, { status: 'active', role_id: adminRoleId }, TRIGGER_MESSAGE);

    expect(await stored(formerAdmin)).toEqual(before);
  });

  it('whoever holds atribuir_admin together with alterar_papel brings the former Admin back', async () => {
    const formerAdmin = await link(adminRoleId, 'removed');

    expect(await updateAs(granteeUserId, formerAdmin, { status: 'active' })).toBe(1);

    expect(await stored(formerAdmin)).toMatchObject({ status: 'active', role_id: adminRoleId });
  });

  it('the Owner, who has no link and no role, brings the former Admin back by ownership', async () => {
    const formerAdmin = await link(adminRoleId, 'removed');

    expect(await updateAs(ownerUserId, formerAdmin, { status: 'active' })).toBe(1);

    expect(await stored(formerAdmin)).toMatchObject({ status: 'active', role_id: adminRoleId });
  });

  it('changing the role to admin on the way back is still the role-change rule, with its own message', async () => {
    const formerProduction = await link(productionRoleId, 'removed');

    await expectTrigger(adminUserId, formerProduction, { status: 'active', role_id: adminRoleId }, ROLE_CHANGE_MESSAGE);

    expect(await stored(formerProduction)).toMatchObject({ status: 'removed', role_id: productionRoleId });
  });

  it('an Admin brings back a former Admin with a non-administrative role, and a former non-admin as one', async () => {
    const formerAdmin = await link(adminRoleId, 'removed');
    const formerProduction = await link(productionRoleId, 'removed');

    expect(await updateAs(adminUserId, formerAdmin, { status: 'active', role_id: productionRoleId })).toBe(1);
    expect(await updateAs(adminUserId, formerProduction, { status: 'active' })).toBe(1);

    expect(await stored(formerAdmin)).toMatchObject({ status: 'active', role_id: productionRoleId });
    expect(await stored(formerProduction)).toMatchObject({ status: 'active', role_id: productionRoleId });
  });

  it('acts only on that transition: an active Admin link still has its title edited and can be removed', async () => {
    const activeAdmin = await link(adminRoleId, 'active');

    expect(await updateAs(adminUserId, activeAdmin, { job_title: 'Diretor' })).toBe(1);
    expect(await updateAs(adminUserId, activeAdmin, { status: 'active' })).toBe(1);
    expect(await stored(activeAdmin)).toMatchObject({ status: 'active', job_title: 'Diretor', role_id: adminRoleId });

    // The Admin preset holds colaborador.remover; removal is not a way back, so it passes untouched.
    expect(await updateAs(adminUserId, activeAdmin, { status: 'removed' })).toBe(1);
    expect(await stored(activeAdmin)).toMatchObject({ status: 'removed' });
  });

  it('the schema owner, and so every security definer function it owns, keeps bypassing the trigger', async () => {
    const formerAdmin = await link(adminRoleId, 'removed');

    await getOwner().knex('agency_memberships').where({ id: formerAdmin }).update({ status: 'active' });

    expect(await stored(formerAdmin)).toMatchObject({ status: 'active', role_id: adminRoleId });
  });

  it('a permission revoked while the reactivation waits for the row is judged when the row is written', async () => {
    const roleId = await customRole(['colaborador.alterar_papel', 'colaborador.atribuir_admin']);
    const userId = randomUUID();
    peopleIds.push(userId);
    await insertUser(userId, 'concedente-corrida');
    await getOwner().knex('agency_memberships').insert({ agency_id: agencyId, user_id: userId, role_id: roleId, status: 'active' });
    const formerAdmin = await link(adminRoleId, 'removed');

    // A real third transaction holds the row; the reactivation queues behind it, and the holder
    // takes atribuir_admin away before it lets go.
    const locker = await getOwner().knex.transaction();
    let queued: Promise<number> | undefined;
    try {
      const locked = await locker.raw<{ rows: unknown[] }>('select id from public.agency_memberships where id = ?::uuid for update', [formerAdmin]);
      expect(locked.rows).toHaveLength(1);
      queued = updateAs(userId, formerAdmin, { status: 'active' });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await getOwner().knex.raw<{ rows: Array<{ count: string }> }>(
          "select count(*) as count from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%update \"agency_memberships\"%'"
        );
        if (Number(waiting.rows[0]?.count) >= 1) break;
        if (Date.now() > deadline) throw new Error('The reactivation never queued behind the lock.');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const deleted = await locker.raw<{ rowCount: number }>('delete from public.role_permissions where role_id = ?::uuid and permission_key = ?', [roleId, 'colaborador.atribuir_admin']);
      expect(deleted.rowCount).toBe(1);
      await locker.commit();
    } catch (error) {
      await locker.rollback().catch(() => undefined);
      await Promise.allSettled([queued]);
      throw error;
    }

    await expect(queued).rejects.toMatchObject({ code: '42501', message: expect.stringContaining(TRIGGER_MESSAGE) });
    expect(await stored(formerAdmin)).toMatchObject({ status: 'removed', role_id: adminRoleId });
  });

  it('replacing the function did not hand it to anyone: neither PUBLIC nor ageniza_app can execute it', async () => {
    for (const role of ['public', 'ageniza_app']) {
      const result = await getOwner().knex.raw<{ rows: Array<{ allowed: boolean }> }>(
        "select has_function_privilege(?, 'app_private.check_agency_membership_update()', 'execute') as allowed",
        [role]
      );
      expect(result.rows[0]?.allowed, role).toBe(false);
    }
  });
});
