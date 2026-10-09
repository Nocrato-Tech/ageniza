import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createLocalTestDatabaseClient,
  createVerifiedUserClaims,
  raw,
  withAuthenticatedUserTransaction,
  type DatabaseClient,
  resolveIntegrationDatabaseUrls
} from '../src/index.js';

// Issue #166. The transaction actor is bound once by app_private.bind_actor and read through
// app_private.current_user_id(); the app.user_id GUC is never read. This suite proves the boundary
// when connected as ageniza_app, the role the attack in the issue runs as.
const { applicationUrl, ownerUrl } = resolveIntegrationDatabaseUrls();

let owner: DatabaseClient | undefined;
let application: DatabaseClient | undefined;

const actorA = randomUUID();
const actorB = randomUUID();
const ownerC = randomUUID();
const managerC = randomUUID();
const targetC = randomUUID();
const agencyA = randomUUID();
const agencyB = randomUUID();
const agencyC = randomUUID();
const staleActor = randomUUID();
const freshActor = randomUUID();

let adminRoleId: string;
let managerRoleId: string;
let productionRoleId: string;

const getOwner = (): DatabaseClient => {
  if (owner === undefined) throw new Error('Owner database client was not initialized.');
  return owner;
};

const getApplication = (): DatabaseClient => {
  if (application === undefined) throw new Error('Application database client was not initialized.');
  return application;
};

const asUser = <TResult>(
  userId: string,
  work: Parameters<typeof withAuthenticatedUserTransaction<TResult>>[2]
): Promise<TResult> => withAuthenticatedUserTransaction(getApplication(), createVerifiedUserClaims({ userId }), work);

const membershipRuleDenied = /colaborador\.\w+ is required|Owner's role and status cannot be changed|role_id must be a system role/;

beforeAll(async () => {
  owner = createLocalTestDatabaseClient(ownerUrl);
  application = createLocalTestDatabaseClient(applicationUrl);

  const database = getOwner();
  const roles = await database.knex('roles').whereNull('agency_id').whereIn('key', ['admin', 'account_manager', 'production']).select('id', 'key');
  adminRoleId = roles.find((role) => role.key === 'admin')?.id;
  managerRoleId = roles.find((role) => role.key === 'account_manager')?.id;
  productionRoleId = roles.find((role) => role.key === 'production')?.id;
  if (adminRoleId === undefined || managerRoleId === undefined || productionRoleId === undefined) {
    throw new Error('System role seeds are missing.');
  }

  await database.transaction(async (transaction) => {
    await transaction('auth.user').insert([
      { id: actorA, name: 'Actor A', email: `actor-a-${actorA}@example.test`, emailVerified: true },
      { id: actorB, name: 'Actor B', email: `actor-b-${actorB}@example.test`, emailVerified: true },
      { id: ownerC, name: 'Owner C', email: `owner-c-${ownerC}@example.test`, emailVerified: true },
      { id: managerC, name: 'Manager C', email: `manager-c-${managerC}@example.test`, emailVerified: true },
      { id: targetC, name: 'Target C', email: `target-c-${targetC}@example.test`, emailVerified: true }
    ]);
    await transaction('agencies').insert([
      { id: agencyA, name: 'Actor A Agency', owner_user_id: actorA },
      { id: agencyB, name: 'Actor B Agency', owner_user_id: actorB },
      { id: agencyC, name: 'Actor C Agency', owner_user_id: ownerC }
    ]);
    await transaction('agency_memberships').insert([
      { agency_id: agencyA, user_id: actorA, role_id: adminRoleId },
      { agency_id: agencyB, user_id: actorB, role_id: adminRoleId },
      { agency_id: agencyC, user_id: ownerC, role_id: adminRoleId },
      { agency_id: agencyC, user_id: managerC, role_id: managerRoleId },
      { agency_id: agencyC, user_id: targetC, role_id: productionRoleId }
    ]);
  });
});

afterAll(async () => {
  try {
    const database = getOwner();
    await raw(database.knex, 'delete from app_private.actor_context where user_id = ?::uuid or user_id = ?::uuid', [staleActor, freshActor]);
    await database.knex('agency_memberships').whereIn('agency_id', [agencyA, agencyB, agencyC]).delete();
    await database.knex('agencies').whereIn('id', [agencyA, agencyB, agencyC]).update({ owner_user_id: null });
    await database.knex('agencies').whereIn('id', [agencyA, agencyB, agencyC]).delete();
    await database.knex('auth.user').whereIn('id', [actorA, actorB, ownerC, managerC, targetC]).delete();
  } finally {
    await application?.close();
    await owner?.close();
  }
});

describe('transaction actor context (issue #166)', () => {
  it('shows no tenant rows to the application role without a bound actor', async () => {
    const rows = await getApplication().transaction((transaction) => transaction('agencies').select('id'));
    expect(rows).toEqual([]);
  });

  it('shows only the bound actor tenant, and a forged app.user_id does not change it', async () => {
    const seen = await asUser(actorA, async (transaction) => {
      await raw(transaction, "select set_config('app.user_id', ?, true)", [actorB]);
      const result = await raw<{ rows: readonly { id: string }[] }>(transaction, 'select id from public.agencies order by id', []);
      return result.rows.map((row) => row.id);
    });
    expect(seen).toEqual([agencyA]);
  });

  // The declared contract is 42501 with its own message, not the 23502 the NOT NULL column would
  // raise on its own: without the check, the error a caller sees changes, and the contract with it.
  it('refuses a null actor on bind_actor with 42501', async () => {
    await expect(asUser(actorA, (transaction) => raw(transaction, 'select app_private.bind_actor(?::uuid)', [null])))
      .rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/actor user id is required/) });
  });

  it('refuses a second bind in the same transaction with 42501', async () => {
    await expect(asUser(actorA, (transaction) => raw(transaction, 'select app_private.bind_actor(?::uuid)', [actorB])))
      .rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/actor already bound/) });
  });

  it('refuses a bind hidden in the same instruction (subselect)', async () => {
    const attack = asUser(actorA, (transaction) => raw(
      transaction,
      `select (select app_private.bind_actor(?::uuid))
         from public.permissions
        limit 1`,
      [actorB]
    ));
    await expect(attack).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/actor already bound/) });
  });

  it('denies the application role every direct privilege on app_private.actor_context', async () => {
    const attempt = (statement: string): Promise<unknown> =>
      getApplication().transaction((transaction) => raw(transaction, statement, []));

    await expect(attempt('select count(*) from app_private.actor_context')).rejects.toThrow(/permission denied/);
    await expect(attempt('insert into app_private.actor_context (xact_id, user_id) values (pg_current_xact_id(), gen_random_uuid())')).rejects.toThrow(/permission denied/);
    await expect(attempt('update app_private.actor_context set user_id = gen_random_uuid()')).rejects.toThrow(/permission denied/);
    await expect(attempt('delete from app_private.actor_context')).rejects.toThrow(/permission denied/);
  });

  // The escalation from issue #166: an account manager without colaborador.atribuir_admin, inside a
  // transaction bound to them, forges app.user_id to the Owner and tries to grant admin. The bind
  // is the only thing that authorizes, so the forgery must not help.
  it('does not let an account manager forge the Owner to grant admin', async () => {
    const attack = asUser(managerC, async (transaction) => {
      await raw(transaction, "select set_config('app.user_id', ?, true)", [ownerC]);
      await raw(transaction, 'update public.agency_memberships set role_id = ?::uuid where agency_id = ?::uuid and user_id = ?::uuid', [adminRoleId, agencyC, targetC]);
    });

    await expect(attack).rejects.toThrow(membershipRuleDenied);
    await expect(getOwner().knex('agency_memberships').where({ agency_id: agencyC, user_id: targetC }).first('role_id'))
      .resolves.toEqual({ role_id: productionRoleId });
  });

  it('refuses withAuthenticatedUserTransaction handed an already-open transaction', async () => {
    await expect(asUser(actorA, (transaction) =>
      withAuthenticatedUserTransaction(transaction as unknown as DatabaseClient, createVerifiedUserClaims({ userId: actorB }), async () => undefined)
    )).rejects.toThrow(/never an existing transaction/);
  });

  it('purges only actor rows older than one hour', async () => {
    // Planted as the schema owner: the application role has no insert grant on this table.
    await getOwner().transaction((transaction) =>
      raw(transaction, "insert into app_private.actor_context (xact_id, user_id, bound_at) values (pg_current_xact_id(), ?::uuid, now() - interval '2 hours')", [staleActor])
    );
    await getOwner().transaction((transaction) =>
      raw(transaction, 'insert into app_private.actor_context (xact_id, user_id) values (pg_current_xact_id(), ?::uuid)', [freshActor])
    );

    const purged = await raw<{ rows: readonly { purge: number }[] }>(getApplication().knex, 'select app_private.purge_actor_context() as purge', []);
    expect(purged.rows[0]?.purge).toBeGreaterThanOrEqual(1);

    const stale = await raw<{ rows: readonly unknown[] }>(getOwner().knex, 'select 1 from app_private.actor_context where user_id = ?::uuid', [staleActor]);
    const fresh = await raw<{ rows: readonly unknown[] }>(getOwner().knex, 'select 1 from app_private.actor_context where user_id = ?::uuid', [freshActor]);
    expect(stale.rows).toEqual([]);
    expect(fresh.rows).toHaveLength(1);
  });
});
